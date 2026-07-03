import { describe, expect, it } from 'vitest';
import {
  PLUGIN_ID,
  deriveProvidedKeys,
  isEntityConfigured,
  isPublishableEntityId,
  providedKey,
  retainEntities,
} from './shared-state';

// The host validates full bus keys against this pattern and silently drops
// mismatches — every advertised key must satisfy it.
const HOST_KEY_RE = /^[a-z0-9_:.-]{1,128}$/;

describe('deriveProvidedKeys', () => {
  it('emits fully prefixed keys for configured entities, preserving order', () => {
    expect(deriveProvidedKeys({ entities: ['light.kitchen', 'sensor.outdoor_temp'] })).toEqual([
      { key: `plugin:${PLUGIN_ID}:light.kitchen`, label: 'light.kitchen' },
      { key: `plugin:${PLUGIN_ID}:sensor.outdoor_temp`, label: 'sensor.outdoor_temp' },
    ]);
  });

  it('does not throw on partial or legacy configs', () => {
    expect(deriveProvidedKeys({})).toEqual([]);
    expect(deriveProvidedKeys({ entities: null })).toEqual([]);
    expect(deriveProvidedKeys({ entities: 'light.kitchen' })).toEqual([]);
    expect(deriveProvidedKeys(null as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('filters malformed entries instead of throwing', () => {
    const keys = deriveProvidedKeys({
      entities: ['light.kitchen', '', 42, null, undefined, { entity_id: 'light.den' }],
    });
    expect(keys).toEqual([{ key: `plugin:${PLUGIN_ID}:light.kitchen`, label: 'light.kitchen' }]);
  });

  it('only advertises keys the host will accept', () => {
    const overlong = `sensor.${'x'.repeat(120)}`;
    const keys = deriveProvidedKeys({
      entities: ['binary_sensor.back_door', 'Light.Kitchen', 'has space.oops', overlong],
    });
    expect(keys).toEqual([
      { key: `plugin:${PLUGIN_ID}:binary_sensor.back_door`, label: 'binary_sensor.back_door' },
    ]);
    for (const { key } of keys) expect(key).toMatch(HOST_KEY_RE);
  });
});

describe('isPublishableEntityId', () => {
  it('accepts canonical HA entity ids', () => {
    expect(isPublishableEntityId('light.kitchen')).toBe(true);
    expect(isPublishableEntityId('binary_sensor.back_door_sensor_intrusion')).toBe(true);
  });

  it('rejects ids the host key format cannot hold', () => {
    expect(isPublishableEntityId('')).toBe(false);
    expect(isPublishableEntityId('Light.Kitchen')).toBe(false);
    expect(isPublishableEntityId(`sensor.${'x'.repeat(120)}`)).toBe(false);
    expect(isPublishableEntityId(42)).toBe(false);
  });

  it('agrees with providedKey about the prefix length budget', () => {
    const maxId = 'a'.repeat(128 - providedKey('').length);
    expect(isPublishableEntityId(maxId)).toBe(true);
    expect(isPublishableEntityId(`${maxId}a`)).toBe(false);
  });
});

describe('retainEntities / isEntityConfigured', () => {
  it('refcounts entities across instances so shared keys survive one release', () => {
    const releaseA = retainEntities(['light.kitchen', 'light.den']);
    const releaseB = retainEntities(['light.kitchen']);

    releaseA();
    expect(isEntityConfigured('light.den')).toBe(false);
    expect(isEntityConfigured('light.kitchen')).toBe(true); // B still holds it

    releaseB();
    expect(isEntityConfigured('light.kitchen')).toBe(false);
  });

  it('release is idempotent', () => {
    const releaseA = retainEntities(['switch.fan']);
    const releaseB = retainEntities(['switch.fan']);
    releaseA();
    releaseA(); // double release must not steal B's count
    expect(isEntityConfigured('switch.fan')).toBe(true);
    releaseB();
    expect(isEntityConfigured('switch.fan')).toBe(false);
  });
});
