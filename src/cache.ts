// Shared display cache wrappers. Keeps multiple HA module instances on the
// same screen from double-fetching — first one writes, the rest read.
//
// Cache keys are versioned so that a plugin update that changes data shape
// doesn't collide with stale blobs from the previous version.

import type { HAStateObject, HAArea } from './types';

const VERSION = 'v1';
const STATES_KEY = (haUrl: string) => `ha:${VERSION}:states:${haUrl}`;
const AREAS_KEY = (haUrl: string) => `ha:${VERSION}:areas:${haUrl}`;

interface Cached<T> {
  value: T;
  expiresAt: number;
}

function getDc() {
  return typeof window !== 'undefined' ? window.__HS_SDK__?.displayCache : undefined;
}

function getWithTTL<T>(key: string): T | null {
  const dc = getDc();
  if (!dc) return null;
  const raw = dc.get(key) as Cached<T> | undefined;
  if (!raw) return null;
  if (Date.now() > raw.expiresAt) return null;
  return raw.value;
}

function setWithTTL<T>(key: string, value: T, ttlMs: number): void {
  const dc = getDc();
  if (!dc) return;
  dc.set(key, { value, expiresAt: Date.now() + ttlMs } satisfies Cached<T>);
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
  const raw = dc.get(STATES_KEY(haUrl)) as Cached<HAStateObject[]> | undefined;
  if (!raw) return;
  dc.set(STATES_KEY(haUrl), { value: Array.from(byId.values()), expiresAt: raw.expiresAt });
}
