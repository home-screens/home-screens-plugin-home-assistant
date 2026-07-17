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
import type { HAStateObject } from './types';
import { fetchStates } from './api';
import { resetFastPollBaseline, subscribeFastPoll, type RefUpdate } from './fast-poll';
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
 *  `media_title` when idle). A successful snapshot is a definitive "gone"
 *  signal (transient fetch failures never reach this), so the key falls
 *  back to unknown instead of gating conditions on its last value forever.
 *  Exported for tests. */
export function planVanishedClears(
  published: ReadonlySet<string>,
  demandedRefs: readonly string[],
  resolvedRefs: ReadonlySet<string>,
): string[] {
  const demanded = new Set(demandedRefs);
  return Array.from(published).filter((ref) => demanded.has(ref) && !resolvedRefs.has(ref));
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
    // The fast lane's change baseline still holds the pre-clear value; drop
    // it so a ref that returns at that same value re-notifies instead of
    // leaving the cleared key unknown until the next full poll.
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
        const plan = planFullPublish(refs, states);
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
        for (const ref of planVanishedClears(
          new Set(publishedRef.current.keys()), refs, resolvedRefs,
        )) {
          clear(ref);
        }
      } catch {
        // Transient failure — demanded keys simply stay at their last
        // published value (or unknown); the next tick retries.
      } finally {
        inflight = false;
      }
    }
    tick();
    const timer = setInterval(tick, FULL_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [haUrl, refs, publish, clear]);

  // Fast lane: the shared 2s poll, gated on the known-set for publishing and
  // on the demand set for buffering (the hub notifies every changed ref on
  // the loop, this provider's or not).
  React.useEffect(() => {
    if (!haUrl || !fastUpdates || refs.length === 0) return;
    const demanded = new Set(refs);
    return subscribeFastPoll(haUrl, refs, (updates) => {
      for (const { ref, value } of planFastPublish(knownRef.current, updates)) {
        publish(ref, value);
      }
      for (const u of planFastBuffer(demanded, knownRef.current, updates)) {
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
    for (const ref of planShrinkClears(new Set(publishedRef.current.keys()), refs)) {
      clear(ref);
    }
  }, [refs, clear]);

  return null;
}
