import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HAStateObject } from './types';

vi.mock('./api', () => ({
  fetchStates: vi.fn(),
  fetchAreas: vi.fn(),
}));

import { fetchStates, fetchAreas } from './api';
import {
  searchStateKeys, entityDescriptor, attributeDescriptor, __resetSearchCacheForTests,
} from './search';

function state(
  entityId: string,
  stateValue: string,
  attributes: Record<string, unknown> = {},
): HAStateObject {
  return {
    entity_id: entityId,
    state: stateValue,
    attributes,
    last_changed: '2026-01-01T00:00:00Z',
    last_updated: '2026-01-01T00:00:00Z',
  } as HAStateObject;
}

const STATES = [
  state('binary_sensor.back_door', 'on', { friendly_name: 'Back Door Sensor', device_class: 'door' }),
  state('sensor.kitchen_temp', '72.5', { friendly_name: 'Kitchen Temperature', unit_of_measurement: '°F' }),
  state('light.porch', 'off', { friendly_name: 'Porch Light' }),
  state('sensor.notes', 'hello world', { friendly_name: 'Notes' }),
];

const SETTINGS = { settings: { haUrl: 'http://ha.local:8123' } };

beforeEach(() => {
  __resetSearchCacheForTests();
  vi.mocked(fetchStates).mockReset().mockResolvedValue(STATES);
  vi.mocked(fetchAreas).mockReset().mockResolvedValue([
    { area_id: 'porch', name: 'Porch', entities: ['binary_sensor.back_door', 'light.porch'] },
  ]);
});

describe('searchStateKeys', () => {
  it('returns [] without a plugin-level haUrl (never guesses a connection)', async () => {
    expect(await searchStateKeys('door', { settings: {} })).toEqual([]);
    expect(fetchStates).not.toHaveBeenCalled();
  });

  it('matches on friendly name, case-insensitively', async () => {
    const results = await searchStateKeys('back door', SETTINGS);
    expect(results.map((r) => r.key)).toEqual(['plugin:home-assistant:binary_sensor.back_door']);
  });

  it('matches on entity id and on the full prefixed bus key (descriptor lookup path)', async () => {
    const byId = await searchStateKeys('sensor.kitchen', SETTINGS);
    expect(byId.map((r) => r.key)).toContain('plugin:home-assistant:sensor.kitchen_temp');

    const byKey = await searchStateKeys('plugin:home-assistant:light.porch', SETTINGS);
    expect(byKey.map((r) => r.key)).toEqual(['plugin:home-assistant:light.porch']);
  });

  it('an empty query returns everything up to the limit', async () => {
    const results = await searchStateKeys('', { ...SETTINGS, limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('does not substring-match the shared key prefix (generic queries stay empty)', async () => {
    // Every bus key starts with `plugin:home-assistant:` — if the prefixed
    // key were substring-matched, queries like "home" or "plugin" would
    // return the entire entity list.
    expect(await searchStateKeys('home', SETTINGS)).toEqual([]);
    expect(await searchStateKeys('plugin', SETTINGS)).toEqual([]);
  });

  it('ranks prefix matches above substring matches', async () => {
    // "porch" prefix-matches "Porch Light" (name) and substring-matches
    // nothing else in STATES — matching never looks at areas, so "Back Door
    // Sensor" (area Porch) must not appear at all.
    const results = await searchStateKeys('porch', SETTINGS);
    expect(results.map((r) => r.key)).toEqual(['plugin:home-assistant:light.porch']);
  });

  it('ranks an exact match above a superstring entity', async () => {
    vi.mocked(fetchStates).mockResolvedValue([
      ...STATES,
      state('light.porch_light', 'off', { friendly_name: 'Porch Light Strip' }),
    ]);
    // By entity id and by full bus key (the committed-condition descriptor
    // lookup): light.porch must beat light.porch_light in both.
    const byId = await searchStateKeys('light.porch', SETTINGS);
    expect(byId[0].key).toBe('plugin:home-assistant:light.porch');
    const byKey = await searchStateKeys('plugin:home-assistant:light.porch', SETTINGS);
    expect(byKey[0].key).toBe('plugin:home-assistant:light.porch');
  });

  it('clamps a fractional limit down, and non-positive limits fall back to the default', async () => {
    expect(await searchStateKeys('', { ...SETTINGS, limit: 2.9 })).toHaveLength(2);
    expect(await searchStateKeys('', { ...SETTINGS, limit: -1 })).toHaveLength(STATES.length);
  });

  it('memoizes the area map per server, one template render per window, not per keystroke', async () => {
    await searchStateKeys('door', SETTINGS);
    await searchStateKeys('porch', SETTINGS);
    expect(fetchAreas).toHaveBeenCalledTimes(1);
  });

  it('groups by area when known, by domain otherwise', async () => {
    const results = await searchStateKeys('', SETTINGS);
    const byKey = new Map(results.map((r) => [r.key, r]));
    expect(byKey.get('plugin:home-assistant:binary_sensor.back_door')?.group).toBe('Porch');
    expect(byKey.get('plugin:home-assistant:sensor.kitchen_temp')?.group).toBe('Sensor');
  });

  it('area fetch failure degrades to domain grouping, never fails the search', async () => {
    vi.mocked(fetchAreas).mockRejectedValue(new Error('template error'));
    const results = await searchStateKeys('back door', SETTINGS);
    expect(results).toHaveLength(1);
    expect(results[0].group).toBe('Binary sensor');
  });
});

describe('attribute discovery', () => {
  const phone = state('sensor.phone', 'home', {
    friendly_name: 'Phone',
    battery_level: 84,
    charging: true,
    forecast: [{ temp: 1 }],
  });

  beforeEach(() => {
    vi.mocked(fetchStates).mockResolvedValue([...STATES, phone]);
  });

  it('finds an attribute when a token matches the attribute name', async () => {
    const results = await searchStateKeys('phone battery', SETTINGS);
    expect(results.map((r) => r.key)).toEqual(['plugin:home-assistant:sensor.phone:battery_level']);
    expect(results[0]).toMatchObject({
      label: 'Phone Battery Level (attribute)',
      valueType: 'numeric',
      currentValue: '84',
    });
  });

  it('a bare entity query lists the entity, not its attribute bag', async () => {
    const results = await searchStateKeys('phone', SETTINGS);
    expect(results.map((r) => r.key)).toEqual(['plugin:home-assistant:sensor.phone']);
  });

  it('resolves a committed attribute key exactly (descriptor lookup path)', async () => {
    const results = await searchStateKeys('plugin:home-assistant:sensor.phone:battery_level', SETTINGS);
    expect(results[0].key).toBe('plugin:home-assistant:sensor.phone:battery_level');
  });

  it('boolean attributes offer the exact published vocabulary', async () => {
    const results = await searchStateKeys('phone charging', SETTINGS);
    expect(results[0]).toMatchObject({ valueType: 'enum', currentValue: 'true' });
    expect(results[0].valueOptions).toEqual([{ value: 'true' }, { value: 'false' }]);
  });

  it('never offers non-scalar attributes, and the empty query skips attributes entirely', async () => {
    const byName = await searchStateKeys('phone forecast', SETTINGS);
    expect(byName.map((r) => r.key)).toEqual([]);

    const all = await searchStateKeys('', SETTINGS);
    expect(all.every((r) => !r.key.includes(':battery_level'))).toBe(true);
  });
});

describe('attributeDescriptor', () => {
  const phone = state('sensor.phone', 'home', { friendly_name: 'Phone' });

  it('types from the raw value: number → numeric, numeric string → numeric, text → string', () => {
    expect(attributeDescriptor(phone, 'battery_level', 84, '84').valueType).toBe('numeric');
    expect(attributeDescriptor(phone, 'level', '12.5', '12.5').valueType).toBe('numeric');
    expect(attributeDescriptor(phone, 'carrier', 'acme', 'acme').valueType).toBe('string');
  });

  it('prefers the area group and falls back to the domain', () => {
    expect(attributeDescriptor(phone, 'battery_level', 84, '84', 'Kitchen').group).toBe('Kitchen');
    expect(attributeDescriptor(phone, 'battery_level', 84, '84').group).toBe('Sensor');
  });
});

describe('entityDescriptor', () => {
  it('maps a device_class binary sensor to enum with BOTH vocabularies', () => {
    const d = entityDescriptor(STATES[0]);
    expect(d).toMatchObject({
      key: 'plugin:home-assistant:binary_sensor.back_door',
      label: 'Back Door Sensor',
      valueType: 'enum',
      currentValue: 'on',
    });
    expect(d.valueOptions).toEqual([
      { value: 'on', label: 'Open' },
      { value: 'off', label: 'Closed' },
    ]);
  });

  it('maps a unit-bearing sensor to numeric with the unit', () => {
    const d = entityDescriptor(STATES[1]);
    expect(d).toMatchObject({ valueType: 'numeric', unit: '°F', currentValue: '72.5' });
    expect(d.valueOptions).toBeUndefined();
  });

  it('maps a unitless free-text sensor to string', () => {
    const d = entityDescriptor(STATES[3]);
    expect(d.valueType).toBe('string');
  });

  it('maps a unitless but numeric state to numeric', () => {
    const d = entityDescriptor(state('sensor.count', '42', {}));
    expect(d).toMatchObject({ valueType: 'numeric', unit: undefined });
  });

  it('uses climate hvac_modes as the enum vocabulary', () => {
    const d = entityDescriptor(
      state('climate.house', 'heat', { hvac_modes: ['off', 'heat', 'cool'] }),
    );
    expect(d.valueType).toBe('enum');
    expect(d.valueOptions?.map((o) => o.value)).toEqual(['off', 'heat', 'cool']);
    // Friendly label only where it differs from the raw value.
    expect(d.valueOptions?.find((o) => o.value === 'heat')?.label).toBe('Heat');
  });

  it('folds an off-list live state (zone name) into the vocabulary', () => {
    const d = entityDescriptor(state('person.bryan', 'gym', { friendly_name: 'Bryan' }));
    expect(d.valueOptions?.map((o) => o.value)).toEqual(['gym', 'home', 'not_home']);
  });

  it('does not fold unavailable/unknown into the vocabulary', () => {
    const d = entityDescriptor(state('light.porch', 'unavailable', {}));
    expect(d.valueOptions?.map((o) => o.value)).toEqual(['on', 'off']);
  });
});

describe('states memo (proxy budget)', () => {
  it('serves repeated queries in one session from a single fetchStates call', async () => {
    await searchStateKeys('door', SETTINGS);
    await searchStateKeys('kitchen', SETTINGS);
    await searchStateKeys('porch', SETTINGS);
    expect(fetchStates).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed states fetch', async () => {
    vi.mocked(fetchStates).mockRejectedValueOnce(new Error('proxy 429'));
    await expect(searchStateKeys('door', SETTINGS)).rejects.toThrow('proxy 429');
    const results = await searchStateKeys('back door', SETTINGS);
    expect(results.map((r) => r.key)).toEqual(['plugin:home-assistant:binary_sensor.back_door']);
    expect(fetchStates).toHaveBeenCalledTimes(2);
  });
});
