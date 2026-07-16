// Editor-only friendly key search — the host's `searchStateKeys` contract
// (conventional named export, re-exported from index.tsx). The host's
// condition builder calls this as the user types (debounced host-side) and
// again with a full bus key to resolve a committed condition's descriptor,
// so matching covers friendly names, entity ids, AND full prefixed keys.
//
// One cached /api/states fetch answers everything: labels, device_class
// vocabularies, units, live values. The proxy caches the GET for
// STATES_TTL_MS, so a burst of queries during one panel session costs a
// single upstream request. Areas come from an uncached POST to the template
// endpoint (the proxy caches GETs only), so the area map is memoized here
// per haUrl; it is pure grouping garnish — its failure never sinks the
// search.

import type { HAStateObject } from './types';
import { entityDomain } from './types';
import type { StateKeyDescriptor } from './hs-plugin';
import { fetchStates, fetchAreas } from './api';
import { friendlyName, formatValue, possibleRawStates } from './utils';
import { providedKey, isPublishableEntityId } from './shared-state';

const STATES_TTL_MS = 30_000;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

export async function searchStateKeys(
  query: string,
  opts: { limit?: number; settings?: Record<string, unknown> } = {},
): Promise<StateKeyDescriptor[]> {
  const settings = opts.settings ?? {};
  const haUrl = typeof settings.haUrl === 'string' ? settings.haUrl.trim() : '';
  // No plugin-level connection → nothing to search. Deliberately not falling
  // back to any module's haUrl: search runs with zero modules placed, and
  // the plugin settings page is where the connection belongs.
  if (!haUrl) return [];
  const limit = typeof opts.limit === 'number' && opts.limit > 0
    ? Math.min(Math.floor(opts.limit), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const [states, areaByEntity] = await Promise.all([
    fetchStates(haUrl, STATES_TTL_MS),
    fetchAreaMap(haUrl),
  ]);

  const q = String(query ?? '').trim().toLowerCase();
  const scored: Array<{ score: number; s: HAStateObject }> = [];
  for (const s of states) {
    if (!isPublishableEntityId(s.entity_id)) continue;
    const score = matchScore(s, q);
    if (score < 0) continue;
    scored.push({ score, s });
  }
  scored.sort(
    (a, b) => a.score - b.score || friendlyName(a.s).localeCompare(friendlyName(b.s)),
  );
  return scored
    .slice(0, limit)
    .map(({ s }) => entityDescriptor(s, areaByEntity.get(s.entity_id)));
}

/** Lower is better; negative means no match. Exact matches outrank prefix
 *  matches outrank substring matches, so `light.porch` never ties with
 *  `light.porch_light`; an empty query matches everything (the host asks
 *  for "the most useful `limit` keys"). */
function matchScore(s: HAStateObject, q: string): number {
  if (q === '') return 3;
  const name = friendlyName(s).toLowerCase();
  const id = s.entity_id.toLowerCase();
  // providedKey covers the host's committed-key descriptor lookup, which
  // passes the full `plugin:home-assistant:<id>` bus key as the query —
  // an exact key match must rank first or the host resolves the wrong
  // entity's descriptor.
  if (name === q || id === q || providedKey(id) === q) return 0;
  if (name.startsWith(q) || id.startsWith(q)) return 1;
  if (name.includes(q) || id.includes(q) || providedKey(id).includes(q)) return 2;
  return -1;
}

/**
 * Map one live state object to the host's descriptor shape. Enumerable
 * domains get `enum` with BOTH vocabularies (raw value + the same friendly
 * text the cards render, so "Alert (on)" reads exactly like the widget);
 * unit-bearing or number-valued states get `numeric`; everything else is
 * free text. Exported for tests.
 */
export function entityDescriptor(s: HAStateObject, area?: string): StateKeyDescriptor {
  const base = {
    key: providedKey(s.entity_id),
    label: friendlyName(s),
    group: area ?? prettyDomain(entityDomain(s.entity_id)),
    currentValue: s.state,
  };

  const rawValues = possibleRawStates(s);
  if (rawValues) {
    // Fold in the live state when the static list misses it (zone names,
    // transient states) — same folding the old key-reference panel did.
    const values = rawValues.includes(s.state)
      || s.state === 'unavailable' || s.state === 'unknown' || s.state === ''
      ? rawValues
      : [s.state, ...rawValues];
    return {
      ...base,
      valueType: 'enum',
      valueOptions: values.map((v) => ({ value: v, label: valueLabel(s, v) })),
    };
  }

  const unit = s.attributes.unit_of_measurement;
  if (typeof unit === 'string' || isNumericState(s.state)) {
    return { ...base, valueType: 'numeric', unit: unit || undefined };
  }
  return { ...base, valueType: 'string' };
}

function isNumericState(state: string): boolean {
  return state.trim() !== '' && Number.isFinite(Number(state));
}

/** Friendly label for one raw value, via the exact formatter the cards use
 *  (device_class-aware). Omitted when it adds nothing over the raw value. */
function valueLabel(s: HAStateObject, raw: string): string | undefined {
  const label = formatValue({ ...s, state: raw });
  return label && label !== raw && label !== '—' ? label : undefined;
}

function prettyDomain(domain: string): string {
  const spaced = domain.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// The area map is memoized per haUrl because fetchAreas is a POST the proxy
// never caches, and it renders a Jinja template iterating every area x
// device x entity — far too heavy to pay per debounced keystroke.
const AREA_CACHE_TTL_MS = 60_000;
const areaCache = new Map<string, { at: number; map: Map<string, string> }>();

async function fetchAreaMap(haUrl: string): Promise<Map<string, string>> {
  const cached = areaCache.get(haUrl);
  if (cached && Date.now() - cached.at < AREA_CACHE_TTL_MS) return cached.map;
  const map = new Map<string, string>();
  try {
    const areas = await fetchAreas(haUrl);
    for (const area of areas) {
      for (const id of area.entities) {
        if (!map.has(id)) map.set(id, area.name);
      }
    }
  } catch {
    // Grouping falls back to the entity's domain. The empty result is
    // cached too: retrying the full template render on every keystroke
    // would hammer HA for garnish.
  }
  areaCache.set(haUrl, { at: Date.now(), map });
  return map;
}

/** Test-only reset. */
export function __resetSearchCacheForTests(): void {
  areaCache.clear();
}
