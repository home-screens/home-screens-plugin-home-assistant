import { describe, expect, it } from 'vitest';
import {
  batteryLevel, batteryTone, collectBatteries, countNeedingCharge,
} from './batteries';
import type { HAStateObject } from './types';

function entity(
  entityId: string, state: string, attributes: Record<string, unknown> = {},
): HAStateObject {
  return {
    entity_id: entityId, state,
    attributes: { ...attributes },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

function battery(id: string, level: string, name?: string): HAStateObject {
  return entity(`sensor.${id}`, level, {
    device_class: 'battery', unit_of_measurement: '%',
    ...(name ? { friendly_name: name } : {}),
  });
}

describe('batteryLevel', () => {
  it('reads a numeric level off a battery sensor', () => {
    expect(batteryLevel(battery('phone', '38'))).toBe(38);
    expect(batteryLevel(battery('phone', '99.4'))).toBeCloseTo(99.4);
  });

  it('clamps out-of-range readings', () => {
    expect(batteryLevel(battery('phone', '140'))).toBe(100);
    expect(batteryLevel(battery('phone', '-3'))).toBe(0);
  });

  it('ignores anything that is not a numeric battery sensor', () => {
    expect(batteryLevel(battery('phone', 'unavailable'))).toBeNull();
    expect(batteryLevel(battery('phone', ''))).toBeNull();
    // Right device class, wrong domain: the binary "low battery" flavor.
    expect(batteryLevel(entity('binary_sensor.door_battery', 'on', {
      device_class: 'battery',
    }))).toBeNull();
    expect(batteryLevel(entity('sensor.living_room_temp', '72', {
      device_class: 'temperature',
    }))).toBeNull();
  });
});

describe('batteryTone', () => {
  it('splits at the low and warn thresholds', () => {
    expect(batteryTone(0)).toBe('low');
    expect(batteryTone(20)).toBe('low');
    expect(batteryTone(21)).toBe('warn');
    expect(batteryTone(40)).toBe('warn');
    expect(batteryTone(41)).toBe('ok');
    expect(batteryTone(100)).toBe('ok');
  });
});

describe('collectBatteries', () => {
  it('finds battery sensors anywhere in the poll, emptiest first', () => {
    const entries = collectBatteries([
      entity('light.kitchen', 'on'),
      battery('back_door', '12', 'Back Door'),
      entity('sensor.living_room_temp', '72', { device_class: 'temperature' }),
      battery('phone', '86', 'Phone'),
      battery('remote', '45', 'Remote'),
    ]);
    expect(entries.map((e) => e.state.entity_id)).toEqual([
      'sensor.back_door', 'sensor.remote', 'sensor.phone',
    ]);
    expect(entries[0].level).toBe(12);
  });

  it('breaks ties by name so a full house does not reshuffle each poll', () => {
    const entries = collectBatteries([
      battery('zeta', '100', 'Zeta Sensor'),
      battery('alpha', '100', 'Alpha Sensor'),
    ]);
    expect(entries.map((e) => e.state.entity_id))
      .toEqual(['sensor.alpha', 'sensor.zeta']);
  });

  it('returns nothing when the house has no battery sensors', () => {
    expect(collectBatteries([entity('light.kitchen', 'on')])).toEqual([]);
  });
});

describe('countNeedingCharge', () => {
  it('counts only the ones at or below the low threshold', () => {
    const entries = collectBatteries([
      battery('a', '5'), battery('b', '20'), battery('c', '21'), battery('d', '90'),
    ]);
    expect(countNeedingCharge(entries)).toBe(2);
  });
});
