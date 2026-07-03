// Fast-poll lane — near-realtime entity state between full /api/states polls.
//
// One shared loop per haUrl, no matter how many module instances subscribe
// (the README's recommended setup — a hidden background provider plus a
// visible widget — always means 2+ instances). Each tick issues a single
// batched template request (fetchEntityStates) for the union of every
// subscriber's entities, so the proxy budget cost is flat: 60_000/FAST_POLL_MS
// requests per minute total, regardless of entity or instance count.
//
// This lane is an accelerator, not a source of truth: it carries only
// `state` (no attributes), listeners are notified with CHANGED entries only,
// and errors are swallowed because the regular full poll remains the
// correctness fallback — a broken fast lane degrades to refreshInterval
// latency instead of surfacing a second error path.

import { fetchEntityStates } from './api';

export const FAST_POLL_MS = 2_000;

export interface EntityStateUpdate {
  entity_id: string;
  state: string;
}

type Listener = (updates: EntityStateUpdate[]) => void;

interface Hub {
  /** Refcounted so overlapping entity lists across instances release correctly. */
  entityCounts: Map<string, number>;
  listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval> | null;
  inflight: boolean;
  /** Last value seen per entity — the change-detection baseline. Entries are
   *  dropped when the last subscriber for an entity releases, so a later
   *  re-subscribe gets an initial notification instead of a stale skip. */
  lastValues: Map<string, string>;
}

const hubs = new Map<string, Hub>();

async function tick(haUrl: string, hub: Hub): Promise<void> {
  if (hub.inflight) return;
  const ids = Array.from(hub.entityCounts.keys());
  if (ids.length === 0) return;
  hub.inflight = true;
  try {
    const results = await fetchEntityStates(haUrl, ids);
    const changed = results.filter((r) => hub.lastValues.get(r.entity_id) !== r.state);
    for (const r of changed) hub.lastValues.set(r.entity_id, r.state);
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
 * Track `entityIds` on the shared fast-poll loop for `haUrl` and receive
 * change notifications. Returns an idempotent release function for the
 * effect cleanup. Ids must already be validated (isPublishableEntityId) —
 * this module embeds them into a Jinja template via fetchEntityStates.
 */
export function subscribeFastPoll(
  haUrl: string,
  entityIds: readonly string[],
  listener: Listener,
): () => void {
  let hub = hubs.get(haUrl);
  if (!hub) {
    hub = {
      entityCounts: new Map(),
      listeners: new Set(),
      timer: null,
      inflight: false,
      lastValues: new Map(),
    };
    hubs.set(haUrl, hub);
  }
  const ids = Array.from(new Set(entityIds));
  for (const id of ids) hub.entityCounts.set(id, (hub.entityCounts.get(id) ?? 0) + 1);
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
    for (const id of ids) {
      const n = h.entityCounts.get(id) ?? 0;
      if (n <= 1) {
        h.entityCounts.delete(id);
        h.lastValues.delete(id);
      } else {
        h.entityCounts.set(id, n - 1);
      }
    }
    if (h.listeners.size === 0) {
      if (h.timer != null) clearInterval(h.timer);
      hubs.delete(haUrl);
    }
  };
}

/** Test-only reset. */
export function __resetFastPollForTests(): void {
  for (const hub of hubs.values()) {
    if (hub.timer != null) clearInterval(hub.timer);
  }
  hubs.clear();
}
