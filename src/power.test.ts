import { describe, expect, it } from 'vitest';
import { isPowerSensor, pickPowerEntity, powerStats } from './power';
import type { HAStateObject } from './types';
import type { HistorySeries } from './history';

function entity(
  entityId: string, state: string, attributes: Record<string, unknown> = {},
): HAStateObject {
  return {
    entity_id: entityId, state,
    attributes: { ...attributes },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

describe('isPowerSensor', () => {
  it('takes the device class when HA sets one', () => {
    expect(isPowerSensor(entity('sensor.home_power', '1.2', {
      device_class: 'power', unit_of_measurement: 'kW',
    }))).toBe(true);
  });

  it('falls back to the unit for template sensors with no device class', () => {
    expect(isPowerSensor(entity('sensor.diy_watts', '430', {
      unit_of_measurement: 'W',
    }))).toBe(true);
    expect(isPowerSensor(entity('sensor.diy_watts', '430', {
      unit_of_measurement: ' kW ',
    }))).toBe(true);
  });

  it('rejects energy totals and non-sensors', () => {
    // kWh is a total, not a rate — its 24h line is a ramp, not a shape.
    expect(isPowerSensor(entity('sensor.daily_energy', '14.2', {
      device_class: 'energy', unit_of_measurement: 'kWh',
    }))).toBe(false);
    expect(isPowerSensor(entity('sensor.living_room_temp', '72', {
      device_class: 'temperature', unit_of_measurement: '°F',
    }))).toBe(false);
    expect(isPowerSensor(entity('switch.kettle', 'on', {
      unit_of_measurement: 'W',
    }))).toBe(false);
  });
});

describe('pickPowerEntity', () => {
  it('prefers a real power sensor over anything else selected', () => {
    const picked = pickPowerEntity([
      entity('light.kitchen', 'on'),
      entity('sensor.living_room_temp', '72', { device_class: 'temperature' }),
      entity('sensor.home_power', '1.24', { device_class: 'power' }),
    ]);
    expect(picked?.entity_id).toBe('sensor.home_power');
  });

  it('falls back to the first sensor so a deliberate pick still renders', () => {
    const picked = pickPowerEntity([
      entity('light.kitchen', 'on'),
      entity('sensor.water_flow', '4.1', { unit_of_measurement: 'L/min' }),
    ]);
    expect(picked?.entity_id).toBe('sensor.water_flow');
  });

  it('returns null when nothing selected is a sensor', () => {
    expect(pickPowerEntity([entity('light.kitchen', 'on')])).toBeNull();
    expect(pickPowerEntity([])).toBeNull();
  });
});

describe('powerStats', () => {
  function series(
    points: number[], min: number, max: number, firstSampleIndex = 0,
  ): HistorySeries {
    return { points, min, max, firstSampleIndex };
  }

  it('reports the extremes of the drawn curve, not the raw window', () => {
    // The chart is scaled to the bucket means, so labelling Low/High with
    // the raw window's extremes names a peak the curve never reaches — a
    // three-minute kettle spike inside a bucket averages away.
    const stats = powerStats(series([1, 2, 3, 4], 0.4, 5.8));
    expect(stats.avg).toBeCloseTo(2.5);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
  });

  it('averages only the measured part of the day', () => {
    // A sensor added late gets its leading buckets back-filled so the line
    // spans the card; counting those would report an average for hours it
    // never observed.
    const stats = powerStats(series([6, 6, 6, 6, 2, 2], 2, 6, 4));
    expect(stats.avg).toBeCloseTo(2);
    expect(stats.min).toBe(2);
    expect(stats.max).toBe(6);
  });

  it('handles a flat day without dividing by zero', () => {
    const stats = powerStats(series([2, 2, 2], 2, 2));
    expect(stats).toEqual({ min: 2, max: 2, avg: 2 });
  });
});
