import { describe, expect, it } from 'vitest';
import type { HAStateObject } from './types';
import {
  MAX_VALUE_LENGTH,
  PLUGIN_ID,
  attributeKey,
  deriveProvidedKeys,
  isPublishableEntityId,
  isPublishableStateKey,
  parseStateKey,
  providedKey,
  publishableAttributes,
  resolveRefValue,
  sampleRawStates,
  stringifyAttributeValue,
} from './shared-state';

// The host validates full bus keys against this pattern and silently drops
// mismatches — every advertised key must satisfy it.
const HOST_KEY_RE = /^[a-z0-9_:.-]{1,128}$/;

describe('deriveProvidedKeys', () => {
  it('emits fully prefixed keys for configured entities, preserving order', () => {
    expect(deriveProvidedKeys({ entities: ['light.kitchen', 'sensor.outdoor_temp'] })).toEqual([
      { key: `plugin:${PLUGIN_ID}:light.kitchen`, label: 'light.kitchen', sampleValues: ['on', 'off'] },
      { key: `plugin:${PLUGIN_ID}:sensor.outdoor_temp`, label: 'sensor.outdoor_temp' },
    ]);
  });

  it('advertises domain sample values only where the raw vocabulary is known', () => {
    const keys = deriveProvidedKeys({
      entities: ['binary_sensor.back_door', 'lock.front', 'person.bryan', 'sensor.temp', 'weather.home'],
    });
    expect(keys.map((k) => k.sampleValues)).toEqual([
      ['on', 'off'],
      ['locked', 'unlocked'],
      ['home', 'not_home'],
      undefined,
      undefined,
    ]);
    // Omitted, not null/empty — older hosts must see a shape identical to before.
    expect('sampleValues' in keys[3]).toBe(false);
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
    expect(keys).toEqual([
      { key: `plugin:${PLUGIN_ID}:light.kitchen`, label: 'light.kitchen', sampleValues: ['on', 'off'] },
    ]);
  });

  it('only advertises keys the host will accept', () => {
    const overlong = `sensor.${'x'.repeat(120)}`;
    const keys = deriveProvidedKeys({
      entities: ['binary_sensor.back_door', 'Light.Kitchen', 'has space.oops', overlong],
    });
    expect(keys).toEqual([
      { key: `plugin:${PLUGIN_ID}:binary_sensor.back_door`, label: 'binary_sensor.back_door', sampleValues: ['on', 'off'] },
    ]);
    for (const { key } of keys) expect(key).toMatch(HOST_KEY_RE);
  });
});

describe('sampleRawStates', () => {
  it('maps on/off domains and domain-specific vocabularies', () => {
    expect(sampleRawStates('binary_sensor.back_door')).toEqual(['on', 'off']);
    expect(sampleRawStates('cover.garage')).toEqual(['open', 'closed']);
    expect(sampleRawStates('media_player.living_room')).toEqual(['playing', 'paused', 'idle', 'off']);
  });

  it('returns null for non-enumerable domains and malformed ids', () => {
    expect(sampleRawStates('sensor.outdoor_temp')).toBeNull();
    expect(sampleRawStates('climate.house')).toBeNull(); // modes are per-entity, see possibleRawStates
    expect(sampleRawStates('no_dot')).toBeNull();
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

  it('rejects attribute refs — a colon is never part of an entity id', () => {
    expect(isPublishableEntityId('sensor.phone:battery_level')).toBe(false);
  });
});

function stateObj(overrides: Partial<HAStateObject> = {}): HAStateObject {
  return {
    entity_id: 'sensor.phone',
    state: '84',
    attributes: {},
    last_changed: '',
    last_updated: '',
    ...overrides,
  };
}

describe('parseStateKey', () => {
  it('splits on the first colon: entity vs attribute', () => {
    expect(parseStateKey('sensor.phone')).toEqual({ entityId: 'sensor.phone', attribute: null });
    expect(parseStateKey('sensor.phone:battery_level'))
      .toEqual({ entityId: 'sensor.phone', attribute: 'battery_level' });
  });

  it('returns null for unusable shapes', () => {
    expect(parseStateKey('')).toBeNull();
    expect(parseStateKey(':battery_level')).toBeNull();
    expect(parseStateKey('sensor.phone:')).toBeNull();
    expect(parseStateKey('a:b:c')).toBeNull();
  });
});

describe('isPublishableStateKey', () => {
  it('accepts entity-state keys and attribute keys', () => {
    expect(isPublishableStateKey('binary_sensor.back_door')).toBe(true);
    expect(isPublishableStateKey('sensor.phone:battery_level')).toBe(true);
  });

  it('rejects malformed refs and keys over the host budget', () => {
    expect(isPublishableStateKey('a:b:c')).toBe(false);
    expect(isPublishableStateKey('sensor.phone:')).toBe(false);
    expect(isPublishableStateKey('Sensor.Phone:battery')).toBe(false);
    expect(isPublishableStateKey(42)).toBe(false);
    // Entity id fits alone, but entity + attribute overflows the 128-char key.
    const longId = `sensor.${'x'.repeat(90)}`;
    expect(isPublishableStateKey(longId)).toBe(true);
    expect(isPublishableStateKey(`${longId}:${'y'.repeat(20)}`)).toBe(false);
  });
});

describe('stringifyAttributeValue', () => {
  it('stringifies scalars and rejects everything else', () => {
    expect(stringifyAttributeValue('open')).toBe('open');
    expect(stringifyAttributeValue(72.5)).toBe('72.5');
    expect(stringifyAttributeValue(true)).toBe('true');
    expect(stringifyAttributeValue(false)).toBe('false');
    expect(stringifyAttributeValue(null)).toBeNull();
    expect(stringifyAttributeValue(undefined)).toBeNull();
    expect(stringifyAttributeValue(['a'])).toBeNull();
    expect(stringifyAttributeValue({ a: 1 })).toBeNull();
    expect(stringifyAttributeValue(Number.NaN)).toBeNull();
    expect(stringifyAttributeValue(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('enforces the host value cap', () => {
    expect(stringifyAttributeValue('x'.repeat(MAX_VALUE_LENGTH))).toHaveLength(MAX_VALUE_LENGTH);
    expect(stringifyAttributeValue('x'.repeat(MAX_VALUE_LENGTH + 1))).toBeNull();
  });
});

describe('resolveRefValue', () => {
  it('resolves state refs to the state and attribute refs to the attribute', () => {
    const s = stateObj({ attributes: { battery_level: 84 } });
    expect(resolveRefValue('sensor.phone', s)).toBe('84');
    expect(resolveRefValue('sensor.phone:battery_level', s)).toBe('84');
  });

  it('resolves attribute names case-sensitively, matching the fast lane', () => {
    // HA's state_attr() is case-sensitive, so the full poll must be too —
    // a mixed-case attribute never resolves under its lowercased key.
    const s = stateObj({ attributes: { Battery_Level: 84 } as never });
    expect(resolveRefValue('sensor.phone:battery_level', s)).toBeNull();
  });

  it('returns null for missing or non-scalar attributes', () => {
    const s = stateObj({ attributes: { forecast: [{ temp: 1 }] } });
    expect(resolveRefValue('sensor.phone:battery_level', s)).toBeNull();
    expect(resolveRefValue('sensor.phone:forecast', s)).toBeNull();
    expect(resolveRefValue('a:b:c', s)).toBeNull();
  });
});

describe('publishableAttributes', () => {
  it('keeps scalars, drops noise metadata, non-scalars, and mixed-case names', () => {
    const s = stateObj({
      attributes: {
        friendly_name: 'Phone',
        icon: 'mdi:phone',
        entity_picture: '/p.png',
        battery_level: 84,
        // Mixed-case names are skipped, not lowercased: resolution is
        // case-sensitive in both lanes, so a lowercased alias would be a
        // key that never resolves.
        Charging: true,
        forecast: [],
        unit_of_measurement: '%',
      } as never,
    });
    expect(publishableAttributes(s)).toEqual([
      { attribute: 'battery_level', value: '84', raw: 84 },
      { attribute: 'unit_of_measurement', value: '%', raw: '%' },
    ]);
  });

  it('never emits an attribute whose key the host would drop', () => {
    const s = stateObj({
      entity_id: `sensor.${'x'.repeat(90)}`,
      attributes: { battery_level: 84, [`${'y'.repeat(30)}`]: 1 } as never,
    });
    for (const { attribute } of publishableAttributes(s)) {
      expect(isPublishableStateKey(attributeKey(s.entity_id, attribute))).toBe(true);
    }
  });
});
