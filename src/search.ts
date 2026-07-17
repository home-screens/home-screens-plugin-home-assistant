// Editor-only friendly key search — the host's `searchStateKeys` contract
// (conventional named export, re-exported from index.tsx). The host's
// condition builder calls this as the user types (debounced host-side) and
// again with a full bus key to resolve a committed condition's descriptor,
// so matching covers friendly names, entity ids, full prefixed keys, AND
// attribute refs (`<entity_id>:<attribute>` — see shared-state.ts).
//
// One cached /api/states fetch answers everything: labels, device_class
// vocabularies, units, live values. The states array is memoized HERE, per
// haUrl, not just at the proxy: the proxy rate-counts a request BEFORE its
// own cache lookup, so without an in-module memo every debounced query
// spends a unit of the shared 240/min localNetwork budget and contends with
// live displays' polling. Areas come from an uncached POST to the template
// endpoint (the proxy caches GETs only), so the area map is memoized the
// same way; it is pure grouping garnish — its failure never sinks the
// search.

import type { HAStateObject } from './types';
import { entityDomain } from './types';
import type { StateKeyDescriptor } from './hs-plugin';
import { fetchStates, fetchAreas } from './api';
import { friendlyName, formatValue, possibleRawStates } from './utils';
import {
  attributeKey, isPublishableEntityId, providedKey, publishableAttributes,
} from './shared-state';

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
    fetchStatesCached(haUrl),
    fetchAreaMap(haUrl),
  ]);

  const q = String(query ?? '').trim().toLowerCase();
  const scored: Array<{
    score: number;
    label: string;
    entityId: string;
    make: (area?: string) => StateKeyDescriptor;
  }> = [];
  for (const s of states) {
    if (!isPublishableEntityId(s.entity_id)) continue;
    const score = matchScore(s, q);
    if (score >= 0) {
      scored.push({
        score,
        label: friendlyName(s),
        entityId: s.entity_id,
        make: (area) => entityDescriptor(s, area),
      });
    }
    // Attribute discovery rides a non-empty query only: enumerating every
    // scalar attribute of every entity for the empty "show me something"
    // query would drown the picker in noise.
    if (q === '') continue;
    for (const { attribute, value, raw } of publishableAttributes(s)) {
      const attrScore = attributeMatchScore(s, attribute, q);
      if (attrScore < 0) continue;
      scored.push({
        score: attrScore,
        label: `${friendlyName(s)} ${prettyAttribute(attribute)}`,
        entityId: s.entity_id,
        make: (area) => attributeDescriptor(s, attribute, raw, value, area),
      });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
  return scored
    .slice(0, limit)
    .map(({ entityId, make }) => make(areaByEntity.get(entityId)));
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
  // entity's descriptor. Exact match only: substring-matching the prefixed
  // key would make queries like "home" or "plugin" match every entity,
  // since the shared prefix is always present.
  if (name === q || id === q || providedKey(id) === q) return 0;
  if (name.startsWith(q) || id.startsWith(q)) return 1;
  if (name.includes(q) || id.includes(q)) return 2;
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

/**
 * Score one (entity, attribute) candidate; negative means no match. A full
 * bus key or unprefixed ref query resolves exactly (the host's committed-key
 * descriptor lookup). Otherwise the query is tokenized: every token must
 * match somewhere (entity name, id, or attribute), and at least one token
 * must match the ATTRIBUTE name — so "phone battery" finds the ref while
 * "door" alone lists door entities without dumping their attribute bags.
 * Matches rank at 2.5: below any direct entity match, above the empty-query
 * catch-all.
 */
function attributeMatchScore(s: HAStateObject, attribute: string, q: string): number {
  const ref = attributeKey(s.entity_id, attribute);
  if (ref === q || providedKey(ref) === q) return 0;
  const attrText = attribute.replace(/_/g, ' ');
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return -1;
  const hay = `${friendlyName(s).toLowerCase()} ${s.entity_id.toLowerCase()} ${attribute} ${attrText}`;
  if (!tokens.every((t) => hay.includes(t))) return -1;
  if (!tokens.some((t) => attribute.includes(t) || attrText.includes(t))) return -1;
  return 2.5;
}

/**
 * Descriptor for one attribute key. Typed from the RAW attribute value —
 * numbers bind to the numeric above/below condition UI, booleans offer the
 * exact true/false vocabulary the provider publishes. No unit: HA declares
 * `unit_of_measurement` for the state, not for attributes. Exported for
 * tests.
 */
export function attributeDescriptor(
  s: HAStateObject,
  attribute: string,
  raw: unknown,
  value: string,
  area?: string,
): StateKeyDescriptor {
  const base = {
    key: providedKey(attributeKey(s.entity_id, attribute)),
    label: `${friendlyName(s)} ${prettyAttribute(attribute)} (attribute)`,
    group: area ?? prettyDomain(entityDomain(s.entity_id)),
    currentValue: value,
  };
  if (typeof raw === 'boolean') {
    return {
      ...base,
      valueType: 'enum',
      valueOptions: [{ value: 'true' }, { value: 'false' }],
    };
  }
  if (typeof raw === 'number' || isNumericState(value)) {
    return { ...base, valueType: 'numeric' };
  }
  return { ...base, valueType: 'string' };
}

function prettyAttribute(attribute: string): string {
  return attribute.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
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

// States memoized per haUrl so repeated debounced queries in one panel
// session make ONE proxy round trip (see the header comment: the proxy
// rate-counts before its cache, so its GET cache does not spare the budget).
// Failures are NOT cached — a transient error should not blank search for
// 30 seconds.
const statesCache = new Map<string, { at: number; states: HAStateObject[] }>();

async function fetchStatesCached(haUrl: string): Promise<HAStateObject[]> {
  const cached = statesCache.get(haUrl);
  if (cached && Date.now() - cached.at < STATES_TTL_MS) return cached.states;
  const states = await fetchStates(haUrl, STATES_TTL_MS);
  statesCache.set(haUrl, { at: Date.now(), states });
  return states;
}

/** Test-only reset. */
export function __resetSearchCacheForTests(): void {
  areaCache.clear();
  statesCache.clear();
}
