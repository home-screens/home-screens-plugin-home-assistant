// Shared display cache wrappers. Keeps multiple HA module instances on the
// same screen from double-fetching — first one writes, the rest read.
//
// Cache keys are versioned so that a plugin update that changes data shape
// doesn't collide with stale blobs from the previous version.

import type { HAStateObject, HAArea } from './types';
import type { HistorySeries } from './history';

const VERSION = 'v1';
const STATES_KEY = (haUrl: string) => `ha:${VERSION}:states:${haUrl}`;
const AREAS_KEY = (haUrl: string) => `ha:${VERSION}:areas:${haUrl}`;
const HISTORY_KEY = (haUrl: string, idsKey: string) => `ha:${VERSION}:history:${haUrl}:${idsKey}`;

interface Cached<T> {
  value: T;
  expiresAt: number;
}

function getDc() {
  return typeof window !== 'undefined' ? window.__HS_SDK__?.displayCache : undefined;
}

/** The host's displayCache wraps every stored value in {data, stale} on read
 *  and keeps serving expired entries with stale: true (stale-while-
 *  revalidate). This plugin wants expiry to mean "miss", so the plugin-side
 *  Cached envelope (value + expiresAt) is what gets stored as `data`, and
 *  reads enforce expiresAt themselves — reading `raw.value` off the host's
 *  wrapper (as this module once did) returns undefined for every entry,
 *  which silently killed cache sharing and every patchCachedStates call. */
function getWithTTL<T>(key: string): T | null {
  const dc = getDc();
  if (!dc) return null;
  const rec = dc.get(key);
  const raw = rec?.data as Cached<T> | undefined;
  if (!raw || typeof raw.expiresAt !== 'number') return null;
  if (Date.now() > raw.expiresAt) return null;
  return raw.value;
}

function setWithTTL<T>(key: string, value: T, ttlMs: number): void {
  const dc = getDc();
  if (!dc) return;
  dc.set(key, { value, expiresAt: Date.now() + ttlMs } satisfies Cached<T>, ttlMs);
}

export function getCachedStates(haUrl: string): HAStateObject[] | null {
  return getWithTTL<HAStateObject[]>(STATES_KEY(haUrl));
}

export function setCachedStates(haUrl: string, states: HAStateObject[], ttlMs: number): void {
  setWithTTL(STATES_KEY(haUrl), states, ttlMs);
}

export function getCachedAreas(haUrl: string): HAArea[] | null {
  return getWithTTL<HAArea[]>(AREAS_KEY(haUrl));
}

export function setCachedAreas(haUrl: string, areas: HAArea[], ttlMs: number): void {
  setWithTTL(AREAS_KEY(haUrl), areas, ttlMs);
}

/** Sparkline history, keyed by the sorted entity-id list so modules watching
 *  the same set share one fetch and differing sets don't clobber each other. */
export function getCachedHistory(
  haUrl: string, idsKey: string,
): Record<string, HistorySeries> | null {
  return getWithTTL<Record<string, HistorySeries>>(HISTORY_KEY(haUrl, idsKey));
}

export function setCachedHistory(
  haUrl: string, idsKey: string, value: Record<string, HistorySeries>, ttlMs: number,
): void {
  setWithTTL(HISTORY_KEY(haUrl, idsKey), value, ttlMs);
}

/** Reconcile a full-poll /api/states snapshot against what the module
 *  already shows. The proxy may serve snapshots up to a TTL old, so a poll
 *  landing after a service call's optimistic patch (or a fast-lane merge)
 *  can carry pre-change data — replacing state wholesale flips the UI
 *  backwards, and the fast lane never repeats itself (its change baseline
 *  already holds the new value), so the stale value sticks until a
 *  genuinely fresh poll.
 *
 *  Two guards, applied per entity:
 *   - last_updated: when the entity we already hold is at least as new as
 *     the snapshot's (both stamps come from the HA server, so they compare
 *     cleanly), keep the held object whole — an optimistic patch's state AND
 *     attributes survive a cache-aged snapshot. Ties keep the held object
 *     too: same server event, possibly carrying a fast-merged state on top,
 *     and preserving identity skips pointless re-renders. Unparseable
 *     stamps fall back to trusting the snapshot.
 *   - fastValues: the fast lane's current value (at most one 2s tick old)
 *     overrides the snapshot's state — covers externally-originated changes
 *     that have no optimistic patch to defend them. The lane is state-only,
 *     so like the live fast merge this stamps last_changed with the merge
 *     time as an upper bound on the real transition.
 *
 *  Entities absent from the snapshot drop out, matching the wholesale-
 *  replace semantics this refines. */
export function reconcileStates(
  prev: readonly HAStateObject[] | null,
  next: readonly HAStateObject[],
  fastValues: ReadonlyMap<string, string> | null,
): HAStateObject[] {
  const prevById = prev && prev.length > 0
    ? new Map(prev.map((s) => [s.entity_id, s]))
    : null;
  return next.map((s) => {
    let out = s;
    const held = prevById?.get(s.entity_id);
    if (held && held !== s) {
      // Unchanged entities are the overwhelming majority of every tick and HA
      // emits fixed-format stamps, so equal strings settle the tie without
      // paying for two Date.parses per entity.
      if (held.last_updated === s.last_updated) {
        out = held;
      } else {
        const tHeld = Date.parse(held.last_updated);
        const tNext = Date.parse(s.last_updated);
        if (Number.isFinite(tHeld) && Number.isFinite(tNext) && tHeld >= tNext) out = held;
      }
    }
    const fast = fastValues?.get(out.entity_id);
    if (fast !== undefined && fast !== out.state) {
      out = { ...out, state: fast, last_changed: new Date().toISOString() };
    }
    return out;
  });
}

/** Merge a single updated state into the cached array — used after a service
 *  call returns its post-call state so the UI flips instantly. */
export function patchCachedStates(haUrl: string, updates: HAStateObject[]): void {
  const existing = getCachedStates(haUrl);
  if (!existing) return;
  const byId = new Map(existing.map((s) => [s.entity_id, s]));
  for (const u of updates) byId.set(u.entity_id, u);
  // Keep existing TTL: re-derive from the cache record so we don't extend.
  const dc = getDc();
  if (!dc) return;
  const raw = dc.get(STATES_KEY(haUrl))?.data as Cached<HAStateObject[]> | undefined;
  if (!raw || typeof raw.expiresAt !== 'number') return;
  const remainingMs = Math.max(0, raw.expiresAt - Date.now());
  dc.set(
    STATES_KEY(haUrl),
    { value: Array.from(byId.values()), expiresAt: raw.expiresAt },
    remainingMs,
  );
}
