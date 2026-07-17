// Shared-state bus helpers for the host's conditional-module-visibility
// feature. Pure module — no React, no SDK access — so it is unit-testable
// and importable by the editor-facing deriveProvidedKeys export without
// dragging in the component tree.
//
// Key grammar (the part after the host's `plugin:home-assistant:` prefix):
//   <entity_id>              entity state
//   <entity_id>:<attribute>  one attribute of that entity
// Entity ids never contain `:`, so the first colon splits unambiguously.

import type { HAStateObject } from './types';
import { entityDomain } from './types';

/** Must match "id" in manifest.json — the host force-prefixes published
 *  keys with `plugin:<id>:`, and deriveProvidedKeys reproduces that prefix
 *  so the editor's key picker matches what actually lands on the bus. */
export const PLUGIN_ID = 'home-assistant';

// The host validates full bus keys against this pattern and silently drops
// anything else (publishState returns void, no error surface). Mirrored here
// so the picker never advertises a key the publish path can't land.
const HOST_KEY_RE = /^[a-z0-9_:.-]{1,128}$/;

/** Full bus key for an entity, exactly as the host prefixes it. */
export function providedKey(entityId: string): string {
  return `plugin:${PLUGIN_ID}:${entityId}`;
}

/** True when the entity id yields a host-accepted bus key. Canonical HA ids
 *  (lowercase `domain.object_id`) always pass; overlong (the prefix leaves
 *  106 of the 128 chars for the id) or malformed config entries don't, and
 *  are skipped by both the picker and the publish loop so the two never
 *  disagree about which keys exist. Colons are rejected even though the
 *  host charset allows them — `:` is the attribute-key separator, never
 *  part of an entity id. */
export function isPublishableEntityId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && !id.includes(':')
    && HOST_KEY_RE.test(providedKey(id));
}

// Raw states an entity of a given domain reports, keyed by domain. Users only
// ever see friendly text ("Alert", "Locked"), so without this the raw
// vocabulary conditions must match ("on") is invisible until the state
// happens to flip. Deliberately the SHORT common lists: this feeds the host
// editor's key-picker labels, which render inline as `label (v1, v2)`.
// Attribute-driven and lifecycle-complete lists (climate modes, select
// options, cover 'opening') live in utils.possibleRawStates, which has the
// live state object to work from.
const DOMAIN_RAW_STATES: Record<string, readonly string[]> = {
  binary_sensor: ['on', 'off'],
  light: ['on', 'off'],
  switch: ['on', 'off'],
  input_boolean: ['on', 'off'],
  fan: ['on', 'off'],
  automation: ['on', 'off'],
  humidifier: ['on', 'off'],
  siren: ['on', 'off'],
  remote: ['on', 'off'],
  script: ['on', 'off'],
  lock: ['locked', 'unlocked'],
  cover: ['open', 'closed'],
  person: ['home', 'not_home'],
  device_tracker: ['home', 'not_home'],
  media_player: ['playing', 'paused', 'idle', 'off'],
};

/** Common raw states for an entity, derived from its domain alone (no live
 *  state needed — callable from deriveProvidedKeys, which only gets config).
 *  Null when the domain isn't enumerable this way (sensors, weather, ...). */
export function sampleRawStates(entityId: string): string[] | null {
  const list = DOMAIN_RAW_STATES[entityDomain(entityId)];
  return list ? [...list] : null;
}

/** Advertises an instance's entities as static key suggestions in the host
 *  editor's condition key picker. Suggestions only: publishing itself is
 *  demand-driven (StateProvider), so these keys no longer determine what
 *  lands on the bus. Called by the host with the instance's raw config,
 *  so it must be pure and defensive: the editor may call it with
 *  partial/legacy configs. sampleValues renders in the picker as
 *  `label (v1, v2)` on hosts that support it; unknown fields are ignored
 *  by older hosts. */
export function deriveProvidedKeys(
  config: Record<string, unknown>,
): { key: string; label: string; sampleValues?: string[] }[] {
  const entities = Array.isArray(config?.entities) ? (config.entities as unknown[]) : [];
  return entities
    .filter(isPublishableEntityId)
    .map((id) => {
      const sampleValues = sampleRawStates(id);
      return sampleValues
        ? { key: providedKey(id), label: id, sampleValues }
        : { key: providedKey(id), label: id };
    });
}

// The cross-instance clear-arbitration refcount (retainEntities /
// isEntityConfigured) that used to live here collapsed when the headless
// StateProvider became the bus's single publisher — with one owner there is
// no sibling whose keys a clearing instance could wipe.

// ---------------------------------------------------------------------------
// Attribute keys
// ---------------------------------------------------------------------------

/** Mirror of the host bus's per-value cap (shared-state-store MAX_VALUE_LENGTH):
 *  the store truncates longer values to the cap, and a silently truncated
 *  value would let conditions match text the user never saw — so anything
 *  over the cap is treated as unresolvable here instead: filtered from
 *  discovery, never published. */
export const MAX_VALUE_LENGTH = 1024;

/** Attributes that are presentation metadata, never useful as a condition or
 *  Text token — kept out of search discovery. Still resolvable if someone
 *  types the key by hand; the exclusion is noise control, not a capability. */
const ATTRIBUTE_NOISE = new Set(['friendly_name', 'icon', 'entity_picture']);

export interface ParsedStateKey {
  entityId: string;
  /** Null for a plain entity-state key. */
  attribute: string | null;
}

/** Split an unprefixed bus key on its first colon. Null when the shape is
 *  unusable (empty segments, a second colon). */
export function parseStateKey(key: string): ParsedStateKey | null {
  const idx = key.indexOf(':');
  if (idx === -1) return key.length > 0 ? { entityId: key, attribute: null } : null;
  const entityId = key.slice(0, idx);
  const attribute = key.slice(idx + 1);
  if (entityId.length === 0 || attribute.length === 0 || attribute.includes(':')) return null;
  return { entityId, attribute };
}

/** Unprefixed bus key for one attribute of an entity. The attribute name is
 *  embedded verbatim: resolution is case-sensitive in both lanes (the full
 *  poll's bag lookup and the fast lane's `state_attr()` call), so a
 *  mixed-case name simply fails the host's lowercase-only key charset and
 *  is never offered or published — HA attributes are conventionally
 *  lowercase snake_case, so in practice nothing is lost. */
export function attributeKey(entityId: string, attribute: string): string {
  return `${entityId}:${attribute}`;
}

/** True when the demanded key — entity state or entity attribute — yields a
 *  host-accepted bus key. The generalization of `isPublishableEntityId` the
 *  demand-driven provider filters on. */
export function isPublishableStateKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length === 0) return false;
  const parsed = parseStateKey(key);
  if (parsed === null) return false;
  if (!isPublishableEntityId(parsed.entityId)) return false;
  return HOST_KEY_RE.test(providedKey(key));
}

/** Bus-ready string for one attribute value, or null when the value cannot
 *  publish: objects, arrays, null/undefined, non-finite numbers, and strings
 *  over the host's value cap. Bools stringify as 'true'/'false'. */
export function stringifyAttributeValue(v: unknown): string | null {
  if (typeof v === 'string') return v.length <= MAX_VALUE_LENGTH ? v : null;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

/**
 * Resolve a demanded key against one live state object: the state itself for
 * a plain key, the (stringified, scalar-only) attribute for an attribute key.
 * Null = unresolvable right now — the provider skips the publish, and on a
 * successful full poll clears a previously published key so consumers fall
 * back to unknown instead of a stale value (HA drops attributes like
 * `media_title` when idle, so vanishing is routine, not exceptional).
 */
export function resolveRefValue(ref: string, s: HAStateObject): string | null {
  const parsed = parseStateKey(ref);
  if (parsed === null) return null;
  if (parsed.attribute === null) return s.state;
  // Case-sensitive on purpose: the fast lane's `state_attr()` lookup is
  // case-sensitive in HA, and the two lanes must agree on what resolves.
  const bag = s.attributes as Record<string, unknown>;
  return stringifyAttributeValue(bag[parsed.attribute]);
}

/**
 * Every attribute of `s` that could publish: scalar value within the caps,
 * name fitting the host key charset verbatim, noise metadata excluded.
 * Feeds search discovery, so its filter matches the publish path exactly —
 * a descriptor the picker offers is always a key the provider can land.
 */
export function publishableAttributes(
  s: HAStateObject,
): Array<{ attribute: string; value: string; raw: unknown }> {
  const out: Array<{ attribute: string; value: string; raw: unknown }> = [];
  for (const [attribute, raw] of Object.entries(s.attributes)) {
    if (ATTRIBUTE_NOISE.has(attribute)) continue;
    // Mixed-case names fail the host's lowercase-only charset here and are
    // skipped — resolution is case-sensitive in both lanes, so offering a
    // lowercased alias would advertise a key that never resolves.
    if (!isPublishableStateKey(attributeKey(s.entity_id, attribute))) continue;
    const value = stringifyAttributeValue(raw);
    if (value === null) continue;
    out.push({ attribute, value, raw });
  }
  return out;
}
