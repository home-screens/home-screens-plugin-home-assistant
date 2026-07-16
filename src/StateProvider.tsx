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
import { subscribeFastPoll } from './fast-poll';
import { PLUGIN_ID, isPublishableEntityId, providedKey } from './shared-state';

/** Full-poll cadence. The fast lane carries state flips in ~2s; this pass
 *  exists to (re)establish which entities exist and to self-heal after fast
 *  lane outages, so a relaxed cadence keeps the proxy budget negligible. */
export const FULL_POLL_MS = 60_000;

/** Proxy cache window for the full poll, kept below FULL_POLL_MS: with the
 *  TTL equal to the interval, each tick would re-serve the previous tick's
 *  snapshot and fresh data would only land every other tick. */
export const FULL_POLL_TTL_MS = FULL_POLL_MS - 5_000;

/** The subset of demanded keys this provider can act on: valid HA entity
 *  ids whose prefixed bus key the host will accept. Exported for tests. */
export function selectPublishableIds(demandedKeys: readonly string[]): string[] {
  return demandedKeys.filter(isPublishableEntityId);
}

/** Publish plan for a full-poll snapshot: demanded ids that exist in the
 *  snapshot, with their current state. Unresolvable ids (typo, deleted
 *  entity) are absent — never published. Exported for tests. */
export function planFullPublish(
  demandedIds: readonly string[],
  states: readonly Pick<HAStateObject, 'entity_id' | 'state'>[],
): Array<{ id: string; state: string }> {
  const demanded = new Set(demandedIds);
  return states
    .filter((s) => demanded.has(s.entity_id))
    .map((s) => ({ id: s.entity_id, state: s.state }));
}

/** Keys to clear when demand shrinks: previously published, no longer
 *  demanded. Exported for tests. */
export function planShrinkClears(
  published: ReadonlySet<string>,
  demandedIds: readonly string[],
): string[] {
  const demanded = new Set(demandedIds);
  return Array.from(published).filter((id) => !demanded.has(id));
}

/** Keys to clear after a successful full poll: previously published, still
 *  demanded, but absent from the snapshot, meaning the entity was deleted
 *  or renamed on the HA side. A successful snapshot is a definitive "gone"
 *  signal (transient fetch failures never reach this), so the key falls
 *  back to unknown instead of gating conditions on its last value forever.
 *  Exported for tests. */
export function planVanishedClears(
  published: ReadonlySet<string>,
  demandedIds: readonly string[],
  snapshotIds: ReadonlySet<string>,
): string[] {
  const demanded = new Set(demandedIds);
  return Array.from(published).filter((id) => demanded.has(id) && !snapshotIds.has(id));
}

/** Fast-lane publish plan: updates for entities the last full poll confirmed
 *  to exist. The rest are buffered by the caller and replayed once a full
 *  poll resolves them, never published straight through, so HA's 'unknown'
 *  template answer for a nonexistent id stays off the bus. Exported for
 *  tests. */
export function planFastPublish(
  known: ReadonlySet<string>,
  updates: readonly { entity_id: string; state: string }[],
): Array<{ id: string; state: string }> {
  return updates
    .filter((u) => known.has(u.entity_id))
    .map((u) => ({ id: u.entity_id, state: u.state }));
}

export function StateProvider({ demandedKeys, settings }: StateProviderProps) {
  const haUrl = typeof settings.haUrl === 'string' ? settings.haUrl.trim() : '';
  const fastUpdates = settings.fastUpdates !== false;
  const debugLogging = settings.debugLogging === true;

  // demandedKeys is referentially stable when unchanged (host contract), so
  // this memo — and every effect keyed on `ids` — holds across unrelated
  // config churn.
  const ids = React.useMemo(() => selectPublishableIds(demandedKeys), [demandedKeys]);

  // Entities confirmed to exist by the last full poll. Gates the fast lane
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

  const publish = React.useCallback((id: string, state: string) => {
    const sdk = window.__HS_SDK__;
    if (typeof sdk?.publishState !== 'function') return;
    const prev = publishedRef.current.get(id);
    sdk.publishState(PLUGIN_ID, id, state);
    publishedRef.current.set(id, state);
    if (debugLogging && prev !== state) {
      console.info(`[home-assistant] provider publish ${providedKey(id)} = "${state}"`);
    }
  }, [debugLogging]);

  const clear = React.useCallback((id: string) => {
    const sdk = window.__HS_SDK__;
    if (typeof sdk?.clearState !== 'function') return;
    sdk.clearState(PLUGIN_ID, id);
    publishedRef.current.delete(id);
    knownRef.current.delete(id);
    pendingFastRef.current.delete(id);
    if (debugLogging) {
      console.info(`[home-assistant] provider clear ${providedKey(id)}`);
    }
  }, [debugLogging]);

  // Connection identity change: the known-set and any buffered fast-lane
  // values describe the previous server, so drop them before the new
  // connection's first poll runs. When the URL is cleared outright there is
  // no next poll to correct anything, so also clear every published key,
  // sending its conditions back to unknown.
  React.useEffect(() => {
    if (!haUrl) {
      for (const id of Array.from(publishedRef.current.keys())) clear(id);
    }
    return () => {
      knownRef.current = new Set();
      pendingFastRef.current.clear();
    };
  }, [haUrl, clear]);

  // Full poll: resolve which demanded entities exist and publish their
  // states. Restarts (with an immediate tick) whenever the demand set or
  // connection changes, so a newly referenced key publishes within one
  // config poll of being added.
  React.useEffect(() => {
    if (!haUrl || ids.length === 0) return;
    let cancelled = false;
    let inflight = false;
    async function tick() {
      if (inflight || cancelled) return;
      inflight = true;
      try {
        const states = await fetchStates(haUrl, FULL_POLL_TTL_MS);
        if (cancelled) return;
        const plan = planFullPublish(ids, states);
        const snapshotIds = new Set(plan.map((p) => p.id));
        knownRef.current = snapshotIds;
        for (const { id, state } of plan) publish(id, state);
        // Replay fast-lane values buffered while their entity was still
        // unconfirmed: the fast value is newer than a possibly cache-aged
        // snapshot, so it wins. If it flipped again since, the next fast
        // tick corrects it.
        for (const [id, state] of Array.from(pendingFastRef.current)) {
          if (!snapshotIds.has(id)) continue;
          pendingFastRef.current.delete(id);
          publish(id, state);
        }
        for (const id of planVanishedClears(
          new Set(publishedRef.current.keys()), ids, snapshotIds,
        )) {
          clear(id);
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
  }, [haUrl, ids, publish, clear]);

  // Fast lane: the shared 2s state-only poll, gated on the known-set.
  React.useEffect(() => {
    if (!haUrl || !fastUpdates || ids.length === 0) return;
    return subscribeFastPoll(haUrl, ids, (updates) => {
      for (const { id, state } of planFastPublish(knownRef.current, updates)) {
        publish(id, state);
      }
      for (const u of updates) {
        if (!knownRef.current.has(u.entity_id)) {
          pendingFastRef.current.set(u.entity_id, u.state);
        }
      }
    });
  }, [haUrl, fastUpdates, ids, publish]);

  // Demand shrink: clear keys that dropped out of the demand set. The host
  // tombstones cleared keys for a grace window, so a quick re-add revives
  // the value without a blink.
  React.useEffect(() => {
    const demanded = new Set(ids);
    for (const id of Array.from(pendingFastRef.current.keys())) {
      if (!demanded.has(id)) pendingFastRef.current.delete(id);
    }
    for (const id of planShrinkClears(new Set(publishedRef.current.keys()), ids)) {
      clear(id);
    }
  }, [ids, clear]);

  return null;
}
