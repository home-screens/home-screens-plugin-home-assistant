// Fast-poll lane — near-realtime entity state between full /api/states polls.
//
// One shared loop per haUrl, no matter how many subscribers: any mix of
// visible widgets and the headless StateProvider (the usual case is at
// least one of each) shares a single loop. Each tick issues a single
// batched template request (fetchEntityRefs) for the union of every
// subscriber's refs, so the proxy budget cost is flat: 60_000/FAST_POLL_MS
// requests per minute total, regardless of ref or instance count.
//
// A ref is a demanded-key string: `<entity_id>` for a state, or
// `<entity_id>:<attribute>` for one attribute (see shared-state.ts). Widgets
// subscribe plain entity ids; the StateProvider subscribes whatever the
// display demands, attributes included.
//
// This lane is an accelerator, not a source of truth: it carries only the
// requested values (no attribute bags), listeners are notified with CHANGED
// entries only, and errors are swallowed because the regular full poll
// remains the correctness fallback — a broken fast lane degrades to
// refreshInterval latency instead of surfacing a second error path.

import { fetchEntityRefs } from './api';

export const FAST_POLL_MS = 2_000;

export interface RefUpdate {
  /** Demanded-key form: `<entity_id>` or `<entity_id>:<attribute>`. */
  ref: string;
  value: string;
}

type Listener = (updates: RefUpdate[]) => void;

interface Hub {
  /** Refcounted so overlapping ref lists across instances release correctly. */
  refCounts: Map<string, number>;
  listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: boolean;
  /** Last value seen per ref — the change-detection baseline. Entries are
   *  dropped when the last subscriber for a ref releases, so a later
   *  re-subscribe gets an initial notification instead of a stale skip. */
  lastValues: Map<string, string>;
}

const hubs = new Map<string, Hub>();

async function tick(haUrl: string, hub: Hub): Promise<void> {
  if (hub.inflight) return;
  const refs = Array.from(hub.refCounts.keys());
  if (refs.length === 0) return;
  hub.inflight = true;
  try {
    const results = await fetchEntityRefs(haUrl, refs);
    // Null values (missing entity/attribute, non-scalar) are skipped rather
    // than recorded: the baseline keeps the last real value. Vanish semantics
    // belong to the full poll — when the StateProvider clears a vanished key
    // it also resets this baseline (resetFastPollBaseline), so a ref that
    // returns at its pre-vanish value still re-notifies.
    const changed = results.filter(
      (r): r is RefUpdate => r.value !== null && hub.lastValues.get(r.ref) !== r.value,
    );
    for (const r of changed) hub.lastValues.set(r.ref, r.value);
    if (changed.length > 0) {
      for (const listener of Array.from(hub.listeners)) {
        try {
          listener(changed);
        } catch {
          // A throwing listener must not starve its siblings.
        }
      }
    }
  } catch {
    // Transient fetch failure — the full poll lane is the fallback.
  } finally {
    hub.inflight = false;
  }
}

/**
 * Track `refs` on the shared fast-poll loop for `haUrl` and receive change
 * notifications (for every changed ref on the loop, not just this
 * subscriber's — filter in the listener). Returns an idempotent release
 * function for the effect cleanup. Refs must already be validated
 * (isPublishableStateKey) — this module embeds them into a Jinja template
 * via fetchEntityRefs.
 */
export function subscribeFastPoll(
  haUrl: string,
  refs: readonly string[],
  listener: Listener,
): () => void {
  let hub = hubs.get(haUrl);
  if (!hub) {
    hub = {
      refCounts: new Map(),
      listeners: new Set(),
      timer: null,
      inflight: false,
      lastValues: new Map(),
    };
    hubs.set(haUrl, hub);
  }
  const tracked = Array.from(new Set(refs));
  for (const ref of tracked) hub.refCounts.set(ref, (hub.refCounts.get(ref) ?? 0) + 1);
  hub.listeners.add(listener);

  if (hub.timer == null) {
    // Immediate first tick so a fresh subscriber isn't blind for a full period.
    void tick(haUrl, hub);
    hub.timer = setInterval(() => void tick(haUrl, hub!), FAST_POLL_MS);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const h = hubs.get(haUrl);
    if (!h) return;
    h.listeners.delete(listener);
    for (const ref of tracked) {
      const n = h.refCounts.get(ref) ?? 0;
      if (n <= 1) {
        h.refCounts.delete(ref);
        h.lastValues.delete(ref);
      } else {
        h.refCounts.set(ref, n - 1);
      }
    }
    if (h.listeners.size === 0) {
      if (h.timer != null) clearInterval(h.timer);
      hubs.delete(haUrl);
    }
  };
}

/**
 * Drop the change-detection baseline for one ref, so the next tick
 * re-notifies it even when its upstream value is unchanged. The
 * StateProvider calls this when it clears a vanished key: without it, a ref
 * that vanishes and later returns at its pre-vanish value would match the
 * stale baseline and stay silent — leaving the cleared key unknown on the
 * bus until the next full poll.
 */
export function resetFastPollBaseline(haUrl: string, ref: string): void {
  hubs.get(haUrl)?.lastValues.delete(ref);
}

/** Test-only reset. */
export function __resetFastPollForTests(): void {
  for (const hub of hubs.values()) {
    if (hub.timer != null) clearInterval(hub.timer);
  }
  hubs.clear();
}
