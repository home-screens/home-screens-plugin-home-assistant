// Demand-driven state provider — the plugin's single shared-state publisher.
//
// The host mounts exactly one instance of this component (manifest
// `exports.stateProvider`, rendered by PluginServiceLayer, alive across
// screen rotation) and hands it `demandedKeys`: every key of this plugin's
// namespace referenced by any visibility condition or Text-module token on
// the display. Referencing a key IS what makes it publish — no hidden
// `backgroundProvider` module, no entity list to keep in sync.
//
// Contract with the host (and how it maps here):
//  - Publish every demanded key you can resolve. A key is "resolvable" when
//    the last full /api/states poll contains its entity — typos and deleted
//    entities are simply never published, and the consumer-side `whenUnknown`
//    gate handles the rest. The fast lane is gated on the same known-set so
//    HA's `states()` template answer for a nonexistent id ('unknown') never
//    leaks onto the bus.
//  - When `demandedKeys` shrinks, clear keys previously published that are
//    no longer demanded (the host's tombstone grace makes this safe).
//  - Never publish outside the demand set.
//
// Data flow mirrors the visible component: a low-frequency full poll for
// correctness (attributes-complete /api/states snapshot, also the resolver
// of which entities exist) plus the shared 2s fast-poll lane for latency.
// Both key off the plugin-level `haUrl` setting — the provider has no module
// instance to read config from.

import React from 'react';
import type { StateProviderProps } from './hs-plugin';
import type { ProviderHealthStatus } from './hs-sdk';
import type { HAStateObject } from './types';
import { tr } from './i18n';
import { fetchStates } from './api';
import {
  getFastPollValues, resetFastPollBaseline, subscribeFastPoll, type RefUpdate,
} from './fast-poll';
import {
  PLUGIN_ID, isPublishableStateKey, parseStateKey, providedKey, resolveRefValue,
} from './shared-state';

/** Full-poll cadence. The fast lane carries state flips in ~2s; this pass
 *  exists to (re)establish which entities exist and to self-heal after fast
 *  lane outages, so a relaxed cadence keeps the proxy budget negligible. */
export const FULL_POLL_MS = 60_000;

/** Proxy cache window for the full poll, kept below FULL_POLL_MS: with the
 *  TTL equal to the interval, each tick would re-serve the previous tick's
 *  snapshot and fresh data would only land every other tick. */
export const FULL_POLL_TTL_MS = FULL_POLL_MS - 5_000;

/** The subset of demanded keys this provider can act on: valid entity-state
 *  or entity-attribute refs whose prefixed bus key the host will accept.
 *  Exported for tests. */
export function selectPublishableRefs(demandedKeys: readonly string[]): string[] {
  return demandedKeys.filter(isPublishableStateKey);
}

/** Publish plan for a full-poll snapshot: demanded refs that resolve against
 *  it, with their current value — the entity's state for a plain ref, the
 *  stringified scalar attribute for an attribute ref. Unresolvable refs
 *  (typo, deleted entity, missing or non-scalar attribute) are absent —
 *  never published. Exported for tests. */
export function planFullPublish(
  demandedRefs: readonly string[],
  states: readonly HAStateObject[],
): Array<{ ref: string; value: string }> {
  const byId = new Map(states.map((s) => [s.entity_id, s]));
  const out: Array<{ ref: string; value: string }> = [];
  for (const ref of demandedRefs) {
    const parsed = parseStateKey(ref);
    if (parsed === null) continue;
    const s = byId.get(parsed.entityId);
    if (!s) continue;
    const value = resolveRefValue(ref, s);
    if (value === null) continue;
    out.push({ ref, value });
  }
  return out;
}

/** Overlay the fast lane's current values onto a full-poll publish plan.
 *  The snapshot behind the plan may be proxy-cache-aged while the hub's
 *  values are at most one 2s tick old — and the hub never re-notifies a
 *  value it already reported, so a stale snapshot's republish would stick
 *  on the bus until the next full poll. Refs the hub doesn't track keep
 *  their snapshot value.
 *
 *  `prevKnown` is the known-set from BEFORE this poll. A hub baseline of
 *  'unknown' for a ref outside it was recorded while the entity didn't exist
 *  (HA's states() answers 'unknown' for nonexistent ids), so overlaying it
 *  onto the poll that just resolved the freshly-created entity would put the
 *  one value this provider promises never to publish onto the bus — the
 *  snapshot wins there. For refs already known, 'unknown' is a genuine state
 *  and overlays normally. Exported for tests. */
export function planWithFastOverlay(
  plan: readonly { ref: string; value: string }[],
  fast: ReadonlyMap<string, string> | null,
  prevKnown: ReadonlySet<string>,
): Array<{ ref: string; value: string }> {
  if (!fast) return [...plan];
  return plan.map((p) => {
    const v = fast.get(p.ref);
    if (v === undefined || v === p.value) return p;
    if (v === 'unknown' && !prevKnown.has(p.ref)) return p;
    return { ref: p.ref, value: v };
  });
}

/** Keys to clear when demand shrinks: previously published, no longer
 *  demanded. Exported for tests. */
export function planShrinkClears(
  published: ReadonlySet<string>,
  demandedRefs: readonly string[],
): string[] {
  const demanded = new Set(demandedRefs);
  return Array.from(published).filter((ref) => !demanded.has(ref));
}

/** Keys to clear after a successful full poll: previously published, still
 *  demanded, but unresolved against the snapshot — the entity was deleted
 *  or renamed, or the attribute disappeared (HA drops attributes like
 *  `media_title` when idle).
 *
 *  Debounced by TWO consecutive misses. During HA startup /api/states returns
 *  200 with a partial entity list and restored entities carrying empty
 *  attribute bags; clearing on the first such snapshot blinks gated modules to
 *  `whenUnknown` for the ~45s until the corrective poll (the host's 15s
 *  tombstone loses to the 60s cadence). So a ref that misses once is held
 *  (kept published, returned in `nextMisses`) and only cleared when a SECOND
 *  consecutive poll also fails to resolve it. Any successful resolution resets
 *  the miss state (the ref is simply absent from `nextMisses`). Demand-shrink
 *  clears are handled separately (planShrinkClears) and stay immediate.
 *  Exported for tests. */
export function planVanishedClears(
  published: ReadonlySet<string>,
  demandedRefs: readonly string[],
  resolvedRefs: ReadonlySet<string>,
  pendingMisses: ReadonlySet<string>,
): { clears: string[]; nextMisses: Set<string> } {
  const demanded = new Set(demandedRefs);
  const clears: string[] = [];
  const nextMisses = new Set<string>();
  for (const ref of published) {
    if (!demanded.has(ref) || resolvedRefs.has(ref)) continue;
    // Published, still demanded, unresolved this poll: a miss.
    if (pendingMisses.has(ref)) clears.push(ref); // second consecutive miss
    else nextMisses.add(ref); // first miss: hold one more cycle
  }
  return { clears, nextMisses };
}

/** Fast-lane re-adopt plan: updates for refs the provider recently cleared as
 *  vanished that have returned with a value on the fast lane, and are still
 *  demanded. A vanished-and-returned ref recovers within one fast tick this
 *  way instead of waiting for the next full poll; clearing a ref removes it
 *  from the known-set, so without this its return would only be buffered
 *  (planFastBuffer) and drained by a full poll. Only refs the provider itself
 *  cleared as vanished are candidates, so re-adopting never bypasses the
 *  known-set gate for an id the full poll has not yet confirmed. Exported for
 *  tests. */
export function planReadopt(
  recentlyCleared: ReadonlySet<string>,
  demanded: ReadonlySet<string>,
  updates: readonly RefUpdate[],
): Array<{ ref: string; value: string }> {
  return updates
    .filter((u) => recentlyCleared.has(u.ref) && demanded.has(u.ref))
    .map((u) => ({ ref: u.ref, value: u.value }));
}

/** Fast-lane publish plan: updates for refs the last full poll confirmed to
 *  resolve. The rest are buffered by the caller and replayed once a full
 *  poll resolves them, never published straight through, so HA's 'unknown'
 *  template answer for a nonexistent id stays off the bus. Exported for
 *  tests. */
export function planFastPublish(
  known: ReadonlySet<string>,
  updates: readonly RefUpdate[],
): Array<{ ref: string; value: string }> {
  return updates
    .filter((u) => known.has(u.ref))
    .map((u) => ({ ref: u.ref, value: u.value }));
}

/** Fast-lane buffer plan: demanded-but-not-yet-confirmed refs to hold for
 *  replay after the next full poll. The shared hub broadcasts every changed
 *  ref on the loop — including entity ids only visible widgets subscribed —
 *  so anything outside this provider's demand set must be ignored here, or
 *  it accumulates forever and replays a stale value over the full poll's
 *  fresh one the moment the ref later becomes demanded. Exported for
 *  tests. */
export function planFastBuffer(
  demanded: ReadonlySet<string>,
  known: ReadonlySet<string>,
  updates: readonly RefUpdate[],
): RefUpdate[] {
  return updates.filter((u) => demanded.has(u.ref) && !known.has(u.ref));
}

/** An outage in progress: the epoch ms of its first failing full poll, held
 *  fixed for the whole outage so `since` never drifts mid-outage. */
type HealthOutage = { since: number };

/** A full-poll outcome fed to the health reporter. `at` is Date.now() at the
 *  moment of a failure, only consulted to seed a fresh outage's `since`. */
type HealthOutcome = { ok: true } | { ok: false; message: string; at: number };

/** Decide what (if anything) to report to the host from one full-poll outcome,
 *  given the outage carried from the previous poll. Pure so the reporting rules
 *  are testable without rendering:
 *   - failure with no prior outage: open one at `at`, report not-ok.
 *   - failure with a prior outage: keep the same `since`, re-report not-ok
 *     (cheap, idempotent — keeps a freshly-opened editor informed).
 *   - success after an outage: report ok once, close the outage.
 *   - success while already healthy: report nothing.
 *  Only the full poll produces outcomes; the fast lane never reports (transient
 *  by design). Exported for tests. */
export function planHealthReport(
  prevOutage: HealthOutage | null,
  outcome: HealthOutcome,
): { report: ProviderHealthStatus | null; outage: HealthOutage | null } {
  if (outcome.ok) {
    if (prevOutage === null) return { report: null, outage: null };
    return { report: { ok: true }, outage: null };
  }
  const since = prevOutage ? prevOutage.since : outcome.at;
  return { report: { ok: false, message: outcome.message, since }, outage: { since } };
}

/** Forward a health report to the host, guarding the whole path: the SDK, and
 *  the `reportProviderHealth` method itself (absent on hosts older than
 *  provider-health reporting). A no-op there — silence reads as healthy.
 *  Exported for tests. */
export function emitProviderHealth(status: ProviderHealthStatus): void {
  window.__HS_SDK__?.reportProviderHealth?.(PLUGIN_ID, status);
}

export function StateProvider({ demandedKeys, settings }: StateProviderProps) {
  const haUrl = typeof settings.haUrl === 'string' ? settings.haUrl.trim() : '';
  const fastUpdates = settings.fastUpdates !== false;
  const debugLogging = settings.debugLogging === true;

  // demandedKeys is referentially stable when unchanged (host contract), so
  // this memo — and every effect keyed on `refs` — holds across unrelated
  // config churn.
  const refs = React.useMemo(() => selectPublishableRefs(demandedKeys), [demandedKeys]);

  // Refs confirmed to resolve by the last full poll. Gates the fast lane
  // so a template 'unknown' for a nonexistent id never publishes.
  const knownRef = React.useRef<Set<string>>(new Set());
  // Last value published per key: the clear-on-shrink baseline, and the
  // change detector that keeps debug logging to actual state changes
  // instead of every 60s republish.
  const publishedRef = React.useRef<Map<string, string>>(new Map());
  // Fast-lane values that arrived before a full poll confirmed their entity
  // exists. The shared hub records every changed value as its notification
  // baseline, so simply dropping these would let a cache-aged full-poll
  // value stick on the bus until the entity next changes; instead they are
  // replayed once the entity turns up in a snapshot.
  const pendingFastRef = React.useRef<Map<string, string>>(new Map());
  // Refs that missed the last full poll once. A second consecutive miss
  // clears them (planVanishedClears); a single miss during HA's partial
  // startup snapshots must not, or gated modules blink to unknown on routine
  // restarts.
  const missedRef = React.useRef<Set<string>>(new Set());
  // Refs cleared as vanished in the current inter-poll window: candidates for
  // fast-lane re-adoption. A vanished-and-returned ref republishes within one
  // fast tick (planReadopt) instead of waiting for the next full poll. The
  // window is one poll; the full poll below expires prior entries so the set
  // stays bounded.
  const readoptRef = React.useRef<Set<string>>(new Set());
  // The full poll's current outage, or null while healthy. Only the full poll
  // writes this; the fast lane never reports (see planHealthReport).
  const outageRef = React.useRef<HealthOutage | null>(null);

  const reportHealth = React.useCallback((outcome: HealthOutcome) => {
    const { report, outage } = planHealthReport(outageRef.current, outcome);
    outageRef.current = outage;
    if (report) emitProviderHealth(report);
  }, []);

  const publish = React.useCallback((ref: string, value: string) => {
    const sdk = window.__HS_SDK__;
    if (typeof sdk?.publishState !== 'function') return;
    const prev = publishedRef.current.get(ref);
    sdk.publishState(PLUGIN_ID, ref, value);
    publishedRef.current.set(ref, value);
    if (debugLogging && prev !== value) {
      console.info(`[home-assistant] provider publish ${providedKey(ref)} = "${value}"`);
    }
  }, [debugLogging]);

  const clear = React.useCallback((ref: string) => {
    const sdk = window.__HS_SDK__;
    if (typeof sdk?.clearState !== 'function') return;
    sdk.clearState(PLUGIN_ID, ref);
    publishedRef.current.delete(ref);
    knownRef.current.delete(ref);
    pendingFastRef.current.delete(ref);
    // The fast lane's change baseline still holds the pre-clear value; drop it
    // so a returning value is seen as a change. Republishing on return is
    // driven by the re-adopt set the vanished-clear path records (see the full
    // poll), not by this baseline reset alone.
    resetFastPollBaseline(haUrl, ref);
    if (debugLogging) {
      console.info(`[home-assistant] provider clear ${providedKey(ref)}`);
    }
  }, [debugLogging, haUrl]);

  // Connection identity change: the known-set and any buffered fast-lane
  // values describe the previous server, so drop them before the new
  // connection's first poll runs. When the URL is cleared outright there is
  // no next poll to correct anything, so also clear every published key,
  // sending its conditions back to unknown.
  React.useEffect(() => {
    if (!haUrl) {
      for (const ref of Array.from(publishedRef.current.keys())) clear(ref);
    }
    return () => {
      knownRef.current = new Set();
      pendingFastRef.current.clear();
      missedRef.current = new Set();
      readoptRef.current = new Set();
      // Drop the outage without reporting recovery: on a connection change the
      // new URL's first poll speaks for its own health, and on unmount there is
      // no editor left to inform. Never emit ok from here.
      outageRef.current = null;
    };
  }, [haUrl, clear]);

  // Full poll: resolve which demanded refs exist and publish their values.
  // Restarts (with an immediate tick) whenever the demand set or
  // connection changes, so a newly referenced key publishes within one
  // config poll of being added.
  React.useEffect(() => {
    if (!haUrl || refs.length === 0) return;
    let cancelled = false;
    let inflight = false;
    async function tick() {
      if (inflight || cancelled) return;
      inflight = true;
      try {
        const states = await fetchStates(haUrl, FULL_POLL_TTL_MS);
        if (cancelled) return;
        reportHealth({ ok: true });
        // knownRef still holds the PREVIOUS poll's known-set here (it is
        // reassigned below) — exactly the baseline planWithFastOverlay needs
        // to spot hub values recorded before their entity existed.
        const plan = planWithFastOverlay(
          planFullPublish(refs, states),
          fastUpdates ? getFastPollValues(haUrl) : null,
          knownRef.current,
        );
        const resolvedRefs = new Set(plan.map((p) => p.ref));
        knownRef.current = resolvedRefs;
        for (const { ref, value } of plan) publish(ref, value);
        // Replay fast-lane values buffered while their ref was still
        // unconfirmed: the fast value is newer than a possibly cache-aged
        // snapshot, so it wins. If it flipped again since, the next fast
        // tick corrects it.
        for (const [ref, value] of Array.from(pendingFastRef.current)) {
          if (!resolvedRefs.has(ref)) continue;
          pendingFastRef.current.delete(ref);
          publish(ref, value);
        }
        // The re-adopt window is one inter-poll period: entries from before
        // this poll have had their fast-lane chance, so drop them (a resolved
        // ref was just republished above; a still-gone ref is now handled by
        // the normal vanish path). Then record this poll's fresh clears.
        readoptRef.current = new Set();
        const { clears, nextMisses } = planVanishedClears(
          new Set(publishedRef.current.keys()), refs, resolvedRefs, missedRef.current,
        );
        missedRef.current = nextMisses;
        for (const ref of clears) {
          clear(ref);
          readoptRef.current.add(ref);
        }
      } catch {
        // Transient failure — demanded keys simply stay at their last
        // published value (or unknown); the next tick retries. Report the
        // outage to the host inspector (unless we were torn down mid-flight).
        if (!cancelled) {
          reportHealth({
            ok: false,
            message: tr('provider.cantReach', "Can't reach Home Assistant"),
            at: Date.now(),
          });
        }
      } finally {
        inflight = false;
      }
    }
    tick();
    const timer = setInterval(tick, FULL_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [haUrl, refs, publish, clear, reportHealth, fastUpdates]);

  // Fast lane: the shared 2s poll, gated on the known-set for publishing and
  // on the demand set for buffering (the hub notifies every changed ref on
  // the loop, this provider's or not).
  React.useEffect(() => {
    if (!haUrl || !fastUpdates || refs.length === 0) return;
    const demanded = new Set(refs);
    return subscribeFastPoll(haUrl, refs, (updates) => {
      // A vanished ref returning on the fast lane is re-adopted immediately:
      // republish it and put it back in the known-set so it stops being
      // buffered. This must run before the buffer step, or planFastBuffer
      // would hold it (cleared refs leave the known-set) until a full poll.
      const readopted = new Set<string>();
      for (const { ref, value } of planReadopt(readoptRef.current, demanded, updates)) {
        readoptRef.current.delete(ref);
        knownRef.current.add(ref);
        pendingFastRef.current.delete(ref);
        publish(ref, value);
        readopted.add(ref);
      }
      const rest = readopted.size === 0
        ? updates
        : updates.filter((u) => !readopted.has(u.ref));
      for (const { ref, value } of planFastPublish(knownRef.current, rest)) {
        publish(ref, value);
      }
      for (const u of planFastBuffer(demanded, knownRef.current, rest)) {
        pendingFastRef.current.set(u.ref, u.value);
      }
    });
  }, [haUrl, fastUpdates, refs, publish]);

  // Demand shrink: clear keys that dropped out of the demand set. The host
  // tombstones cleared keys for a grace window, so a quick re-add revives
  // the value without a blink.
  React.useEffect(() => {
    const demanded = new Set(refs);
    for (const ref of Array.from(pendingFastRef.current.keys())) {
      if (!demanded.has(ref)) pendingFastRef.current.delete(ref);
    }
    for (const ref of Array.from(readoptRef.current)) {
      if (!demanded.has(ref)) readoptRef.current.delete(ref);
    }
    for (const ref of planShrinkClears(new Set(publishedRef.current.keys()), refs)) {
      clear(ref);
    }
  }, [refs, clear]);

  return null;
}
