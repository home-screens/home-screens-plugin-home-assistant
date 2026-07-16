// Shared-state bus helpers for the host's conditional-module-visibility
// feature. Pure module — no React, no SDK access — so it is unit-testable
// and importable by the editor-facing deriveProvidedKeys export without
// dragging in the component tree.

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
 *  disagree about which keys exist. */
export function isPublishableEntityId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && HOST_KEY_RE.test(providedKey(id));
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

/** Advertises an instance's shared-state keys to the host editor (condition
 *  key picker + the "Run hidden in the background" toggle). Called by the
 *  host with the instance's raw config — must be pure and defensive: the
 *  editor may call it with partial/legacy configs. sampleValues renders in
 *  the picker as `label (v1, v2)` on hosts that support it; unknown fields
 *  are ignored by older hosts. */
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
