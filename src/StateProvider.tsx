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
  // Keys this provider has published — the clear-on-shrink baseline.
  const publishedRef = React.useRef<Set<string>>(new Set());

  const publish = React.useCallback((id: string, state: string) => {
    const sdk = window.__HS_SDK__;
    if (typeof sdk?.publishState !== 'function') return;
    sdk.publishState(PLUGIN_ID, id, state);
    publishedRef.current.add(id);
    if (debugLogging) {
      console.info(`[home-assistant] provider publish ${providedKey(id)} = "${state}"`);
    }
  }, [debugLogging]);

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
        const states = await fetchStates(haUrl, FULL_POLL_MS);
        if (cancelled) return;
        const plan = planFullPublish(ids, states);
        knownRef.current = new Set(plan.map((p) => p.id));
        for (const { id, state } of plan) publish(id, state);
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
  }, [haUrl, ids, publish]);

  // Fast lane: the shared 2s state-only poll, gated on the known-set.
  React.useEffect(() => {
    if (!haUrl || !fastUpdates || ids.length === 0) return;
    return subscribeFastPoll(haUrl, ids, (updates) => {
      for (const u of updates) {
        if (!knownRef.current.has(u.entity_id)) continue;
        publish(u.entity_id, u.state);
      }
    });
  }, [haUrl, fastUpdates, ids, publish]);

  // Demand shrink: clear keys that dropped out of the demand set. The host
  // tombstones cleared keys for a grace window, so a quick re-add revives
  // the value without a blink.
  React.useEffect(() => {
    const sdk = window.__HS_SDK__;
    if (typeof sdk?.clearState !== 'function') return;
    for (const id of planShrinkClears(publishedRef.current, ids)) {
      sdk.clearState(PLUGIN_ID, id);
      publishedRef.current.delete(id);
      knownRef.current.delete(id);
      if (debugLogging) {
        console.info(`[home-assistant] provider clear ${providedKey(id)}`);
      }
    }
  }, [ids, debugLogging]);

  return null;
}
