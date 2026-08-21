import { describe, expect, it } from 'vitest';
import {
  batterySign, classifyEnergy, energyStatus, findBatteryLevel, flows, formatWatts,
  gridSign, hasAnyNode, homeOnly, particleDuration, rightNowRows, roleDetail, roleFor,
  selfPowered, toWatts, wattsLabel, PARTICLES_PER_WIRE,
} from './energy';
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

function power(entityId: string, state: string, name?: string, unit = 'W'): HAStateObject {
  return entity(entityId, state, {
    device_class: 'power', unit_of_measurement: unit,
    ...(name ? { friendly_name: name } : {}),
  });
}

const solar = power('sensor.solar_power', '5200', 'Solar Power');
const grid = power('sensor.grid_power', '-1600', 'Grid Power');
const battery = power('sensor.battery_power', '900', 'Battery Power');
const house = power('sensor.house_power', '1840', 'House Power');
const level = entity('sensor.battery_level', '78', {
  device_class: 'battery', unit_of_measurement: '%', friendly_name: 'Battery Level',
});

describe('roleFor', () => {
  it('reads the role off the entity id', () => {
    expect(roleFor(power('sensor.pv_output', '1'))).toBe('solar');
    expect(roleFor(power('sensor.inverter_ac', '1'))).toBe('solar');
    expect(roleFor(power('sensor.utility_meter_power', '1'))).toBe('grid');
    expect(roleFor(power('sensor.mains_power', '1'))).toBe('grid');
    expect(roleFor(power('sensor.powerwall_power', '1'))).toBe('battery');
    expect(roleFor(power('sensor.storage_flow', '1'))).toBe('battery');
  });

  it('reads the friendly name too, case-insensitively', () => {
    expect(roleFor(power('sensor.shelly_em_ch1', '1', 'GRID Import'))).toBe('grid');
    expect(roleFor(power('sensor.abc', '1', 'Garage Solar'))).toBe('solar');
  });

  it('treats everything else as the house', () => {
    expect(roleFor(power('sensor.house_power', '1'))).toBe('home');
    expect(roleFor(power('sensor.total_load', '1'))).toBe('home');
    expect(roleFor(power('sensor.shelly_em', '1', 'Consumption'))).toBe('home');
  });

  it('does not match inside other words', () => {
    // "gridley" is a street, not the utility.
    expect(roleFor(power('sensor.gridley_house', '1'))).toBe('home');
  });
});

describe('toWatts', () => {
  it('normalizes kW and MW to watts', () => {
    expect(toWatts(power('sensor.a', '1.5', undefined, 'kW'))).toBe(1500);
    expect(toWatts(power('sensor.a', '0.002', undefined, 'MW'))).toBe(2000);
    expect(toWatts(power('sensor.a', '430', undefined, 'W'))).toBe(430);
    expect(toWatts(power('sensor.a', '2', undefined, 'kVA'))).toBe(2000);
  });

  it('assumes watts when the unit is missing or unknown', () => {
    expect(toWatts(entity('sensor.a', '300'))).toBe(300);
    // An energy total or a current reading that slipped through the picker
    // is shown as-is rather than scaled by a guess.
    expect(toWatts(power('sensor.a', '14.2', undefined, 'kWh'))).toBe(14.2);
    expect(toWatts(power('sensor.a', '6', undefined, 'A'))).toBe(6);
  });

  it('returns null for unavailable and unknown', () => {
    expect(toWatts(power('sensor.a', 'unavailable'))).toBeNull();
    expect(toWatts(power('sensor.a', 'unknown'))).toBeNull();
    expect(toWatts(power('sensor.a', ''))).toBeNull();
  });
});

describe('sign conventions', () => {
  it('flips a sensor named export so grid positive means importing', () => {
    expect(gridSign(power('sensor.grid_export', '800'), 800)).toBe(-800);
    expect(gridSign(power('sensor.grid_power', '800'), 800)).toBe(800);
  });

  it('flips a sensor named discharge so battery positive means charging', () => {
    expect(batterySign(power('sensor.battery_discharge_power', '500'), 500)).toBe(-500);
    expect(batterySign(power('sensor.home_battery_power', '500'), 500)).toBe(500);
  });

  it('flips a Powerwall, whose integration reports charging as negative', () => {
    expect(batterySign(power('sensor.powerwall_battery_now', '-1200'), -1200)).toBe(1200);
    expect(batterySign(power('sensor.powerwall_battery_now', '800'), 800)).toBe(-800);
    expect(batterySign(power('sensor.battery_power', '500', 'Powerwall Battery Power'), 500)).toBe(-500);
  });
});

describe('classifyEnergy', () => {
  it('sorts the harness sensors into their roles', () => {
    const m = classifyEnergy([solar, grid, battery, level, house], level);
    expect(m.solar).toBe(5200);
    expect(m.grid).toBe(-1600);
    expect(m.battery).toBe(900);
    expect(m.home).toBe(1840);
    expect(m.homeDerived).toBe(false);
    expect(m.batteryLevel).toBe(78);
  });

  it('first sensor per role wins and extra home candidates are ignored', () => {
    const second = power('sensor.total_load', '9999', 'Total Load');
    const m = classifyEnergy([house, second, power('sensor.pv2', '100', 'PV East')]);
    expect(m.home).toBe(1840);
    expect(m.solar).toBe(100);
  });

  it('derives home from solar and grid when no house sensor is picked', () => {
    const m = classifyEnergy([solar, grid, battery]);
    // 5200 in from solar, 1600 out to the grid, 900 into the battery.
    expect(m.home).toBe(2700);
    expect(m.homeDerived).toBe(true);
  });

  it('adds battery discharge to the derived home', () => {
    const m = classifyEnergy([solar, power('sensor.grid_power', '200'), power('sensor.battery_power', '-400')]);
    expect(m.home).toBe(5800);
  });

  it('does not derive home without both solar and grid', () => {
    expect(classifyEnergy([solar]).home).toBeNull();
    expect(classifyEnergy([grid, battery]).home).toBeNull();
  });

  it('keeps a role whose sensor is unavailable, reading as zero', () => {
    const m = classifyEnergy([
      power('sensor.solar_power', 'unavailable'),
      power('sensor.grid_power', 'unknown'),
      power('sensor.battery_power', 'unavailable'),
    ]);
    expect(m.solar).toBe(0);
    expect(m.grid).toBe(0);
    expect(m.battery).toBe(0);
    expect(flows(m).map((f) => f.watts)).toEqual([0, 0, 0, 0]);
  });

  it('clamps a derived home at zero when the meter lags the inverter', () => {
    const m = classifyEnergy([power('sensor.solar_power', '1000'), power('sensor.grid_power', '-3000')]);
    expect(m.home).toBe(0);
    expect(m.homeDerived).toBe(true);
  });

  it('ignores non-power sensors for roles', () => {
    const m = classifyEnergy([level]);
    expect(hasAnyNode(m)).toBe(false);
  });

  it('reads the level off the sensor it is handed, and nothing without one', () => {
    expect(classifyEnergy([battery], level).batteryLevel).toBe(78);
    expect(classifyEnergy([battery], null).batteryLevel).toBeNull();
    expect(classifyEnergy([battery], entity('sensor.battery_level', 'unavailable', {
      device_class: 'battery',
    })).batteryLevel).toBeNull();
  });
});

describe('findBatteryLevel', () => {
  const remote = entity('sensor.kitchen_remote_battery', '40', { device_class: 'battery', unit_of_measurement: '%' });

  it('prefers a selected level sensor', () => {
    expect(findBatteryLevel([battery, level], [remote, level])).toBe(level);
  });

  it('matches on a distinctive shared word', () => {
    const pw = power('sensor.powerwall_power', '1', 'Powerwall Power');
    const pwLevel = entity('sensor.powerwall_charge', '55', { device_class: 'battery', unit_of_measurement: '%', friendly_name: 'Powerwall Charge' });
    expect(findBatteryLevel([pw], [remote, pwLevel])).toBe(pwLevel);
  });

  it('matches a shared entity id prefix when the names are generic', () => {
    expect(findBatteryLevel([battery], [remote, level])).toBe(level);
  });

  it('never guesses an unrelated battery, and needs a battery power sensor', () => {
    const pw = power('sensor.powerwall_power', '1', 'Powerwall Power');
    expect(findBatteryLevel([pw], [remote])).toBeNull();
    expect(findBatteryLevel([solar], [remote, level])).toBeNull();
    expect(findBatteryLevel([], [remote])).toBeNull();
  });
});

describe('flows', () => {
  it('routes every wire through the hub with direction by sign', () => {
    const m = classifyEnergy([solar, grid, battery, house]);
    expect(flows(m)).toEqual([
      { from: 'solar', to: 'hub', watts: 5200 },
      { from: 'hub', to: 'grid', watts: 1600 },
      { from: 'hub', to: 'battery', watts: 900 },
      { from: 'hub', to: 'home', watts: 1840 },
    ]);
  });

  it('reverses grid and battery when importing and discharging', () => {
    const m = classifyEnergy([power('sensor.grid_power', '400'), power('sensor.battery_power', '-300'), house]);
    expect(flows(m)).toEqual([
      { from: 'grid', to: 'hub', watts: 400 },
      { from: 'battery', to: 'hub', watts: 300 },
      { from: 'hub', to: 'home', watts: 1840 },
    ]);
  });

  it('draws only the nodes that exist', () => {
    const m = classifyEnergy([house]);
    expect(flows(m)).toEqual([{ from: 'hub', to: 'home', watts: 1840 }]);
    expect(homeOnly(m)).toBe(true);
    expect(homeOnly(classifyEnergy([house, solar]))).toBe(false);
  });
});

describe('selfPowered', () => {
  it('is solar over home, clamped to 100', () => {
    expect(selfPowered(classifyEnergy([solar, house]))).toBe(100);
    expect(selfPowered(classifyEnergy([power('sensor.solar_power', '920'), house]))).toBe(50);
  });

  it('needs both numbers and a house that is using something', () => {
    expect(selfPowered(classifyEnergy([solar]))).toBeNull();
    expect(selfPowered(classifyEnergy([house]))).toBeNull();
    expect(selfPowered(classifyEnergy([solar, power('sensor.house_power', '10')]))).toBeNull();
  });
});

describe('energyStatus', () => {
  it('leads with grid movement', () => {
    expect(energyStatus(classifyEnergy([solar, grid, house]))).toEqual({ kind: 'exporting', watts: 1600 });
    expect(energyStatus(classifyEnergy([solar, power('sensor.grid_power', '400'), house])))
      .toEqual({ kind: 'importing', watts: 400 });
  });

  it('says solar when the sun covers the house and the grid is idle', () => {
    expect(energyStatus(classifyEnergy([solar, power('sensor.grid_power', '5'), house])))
      .toEqual({ kind: 'solar', watts: 5200 });
  });

  it('says solar when the sun helps but does not cover the house, with nothing else moving', () => {
    const m = classifyEnergy([power('sensor.solar_power', '800'), power('sensor.grid_power', '0'), house]);
    expect(energyStatus(m)).toEqual({ kind: 'solar', watts: 800 });
    // ...but a discharging battery is the better story when there is one.
    const withBattery = classifyEnergy([
      power('sensor.solar_power', '800'), power('sensor.grid_power', '0'),
      power('sensor.battery_power', '-1000'), house,
    ]);
    expect(energyStatus(withBattery)).toEqual({ kind: 'battery', watts: 1000 });
  });

  it('says battery when the battery carries the house', () => {
    const m = classifyEnergy([power('sensor.solar_power', '0'), power('sensor.grid_power', '0'), power('sensor.battery_power', '-1200'), house]);
    expect(energyStatus(m)).toEqual({ kind: 'battery', watts: 1200 });
  });

  it('falls back to what the house is using, then quiet', () => {
    expect(energyStatus(classifyEnergy([house]))).toEqual({ kind: 'using', watts: 1840 });
    expect(energyStatus(classifyEnergy([power('sensor.house_power', '12')]))).toEqual({ kind: 'quiet', watts: 0 });
  });
});

describe('formatting', () => {
  it('uses W below a kilowatt and kW above, with formatValue\'s precision', () => {
    expect(formatWatts(430)).toEqual({ value: '430', unit: 'W' });
    expect(formatWatts(999.6)).toEqual({ value: '1000', unit: 'W' });
    expect(formatWatts(1840)).toEqual({ value: '1.84', unit: 'kW' });
    expect(formatWatts(-1600)).toEqual({ value: '1.60', unit: 'kW' });
    expect(formatWatts(12345)).toEqual({ value: '12.3', unit: 'kW' });
    expect(wattsLabel(5200)).toBe('5.20 kW');
  });
});

describe('particles', () => {
  it('moves faster with more watts, within the clamp', () => {
    expect(particleDuration(0)).toBe(6);
    expect(particleDuration(100)).toBe(6);
    expect(particleDuration(1500)).toBe(2);
    expect(particleDuration(10000)).toBe(0.8);
  });

  it('keeps a fixed count so jitter never remounts them', () => {
    expect(PARTICLES_PER_WIRE).toBe(4);
  });
});

describe('roleDetail', () => {
  it('names the direction, and stays quiet inside the dead zone', () => {
    const m = classifyEnergy([solar, grid, battery, house]);
    expect(roleDetail('grid', m)).toBe('exporting');
    expect(roleDetail('battery', m)).toBe('charging');
    expect(roleDetail('solar', m)).toBeNull();
    expect(roleDetail('home', m)).toBeNull();
    const quiet = classifyEnergy([power('sensor.grid_power', '20'), power('sensor.battery_power', '-30')]);
    expect(roleDetail('grid', quiet)).toBeNull();
    expect(roleDetail('battery', quiet)).toBeNull();
  });

  it('marks a derived home as estimated', () => {
    expect(roleDetail('home', classifyEnergy([solar, grid]))).toBe('estimated');
  });
});

describe('rightNowRows', () => {
  it('lists every node in order with the level on the battery row', () => {
    const m = classifyEnergy([house, battery, grid, solar], level);
    expect(rightNowRows(m)).toEqual([
      { key: 'solar', role: 'solar', detail: null, value: '5.20 kW' },
      { key: 'grid', role: 'grid', detail: 'exporting', value: '1.60 kW' },
      { key: 'battery', role: 'battery', detail: 'charging', value: '900 W · 78%' },
      { key: 'home', role: 'home', detail: null, value: '1.84 kW' },
    ]);
  });

  it('skips missing nodes and shows the battery watts alone without a level sensor', () => {
    expect(rightNowRows(classifyEnergy([battery, house]))).toEqual([
      { key: 'battery', role: 'battery', detail: 'charging', value: '900 W' },
      { key: 'home', role: 'home', detail: null, value: '1.84 kW' },
    ]);
  });

  it('shows the level alone when only a level sensor was picked', () => {
    expect(rightNowRows(classifyEnergy([house], level))).toEqual([
      { key: 'battery', role: 'battery', detail: null, value: '78%' },
      { key: 'home', role: 'home', detail: null, value: '1.84 kW' },
    ]);
  });
});
