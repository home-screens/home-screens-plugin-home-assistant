import { describe, expect, it } from 'vitest';
import { possibleRawStates } from './utils';
import type { HAStateObject } from './types';

function stub(entityId: string, state = 'on', attributes: Record<string, unknown> = {}): HAStateObject {
  return {
    entity_id: entityId,
    state,
    attributes,
    last_changed: '2026-07-04T00:00:00Z',
    last_updated: '2026-07-04T00:00:00Z',
  };
}

describe('possibleRawStates', () => {
  it('enumerates on/off domains via the shared domain map', () => {
    expect(possibleRawStates(stub('binary_sensor.back_door', 'off', { device_class: 'safety' })))
      .toEqual(['on', 'off']);
    expect(possibleRawStates(stub('switch.fan'))).toEqual(['on', 'off']);
  });

  it('uses per-entity attributes where HA enumerates states', () => {
    expect(possibleRawStates(stub('climate.house', 'heat', { hvac_modes: ['off', 'heat', 'cool'] })))
      .toEqual(['off', 'heat', 'cool']);
    expect(possibleRawStates(stub('input_select.mode', 'day', { options: ['day', 'night', 'away'] })))
      .toEqual(['day', 'night', 'away']);
  });

  it('returns null when attributes are missing or malformed instead of guessing', () => {
    expect(possibleRawStates(stub('climate.house', 'heat'))).toBeNull();
    expect(possibleRawStates(stub('climate.house', 'heat', { hvac_modes: 'heat' }))).toBeNull();
    expect(possibleRawStates(stub('select.mode', 'a', { options: [1, 2] }))).toBeNull();
  });

  it('lists full lifecycle states for locks and covers', () => {
    expect(possibleRawStates(stub('lock.front', 'locked')))
      .toEqual(['locked', 'unlocked', 'locking', 'unlocking', 'jammed']);
    expect(possibleRawStates(stub('cover.garage', 'open')))
      .toEqual(['open', 'closed', 'opening', 'closing']);
  });

  it('returns null for numeric and free-form domains', () => {
    expect(possibleRawStates(stub('sensor.outdoor_temp', '72.5', { unit_of_measurement: '°F' }))).toBeNull();
    expect(possibleRawStates(stub('weather.home', 'partlycloudy'))).toBeNull();
  });
});
