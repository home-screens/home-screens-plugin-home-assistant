import { describe, expect, it } from 'vitest';
import {
  setpointModel, tempStep, tempBounds, gaugeBounds, stepValue, formatTemp,
  climateStateLine, hvacModeColor, setTemperaturePayload, hvacModes,
} from './climate';
import type { HAStateObject } from './types';

function climate(attributes: Record<string, unknown>, state = 'heat'): HAStateObject {
  return {
    entity_id: 'climate.hallway', state,
    attributes: { friendly_name: 'Hallway', ...attributes },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

describe('setpointModel', () => {
  it('prefers the dual-setpoint pair when both bounds are present', () => {
    expect(setpointModel(climate({ target_temp_low: 68, target_temp_high: 74, temperature: 70 })))
      .toEqual({ kind: 'range', low: 68, high: 74 });
  });

  it('falls to single setpoint on a plain temperature attribute', () => {
    expect(setpointModel(climate({ temperature: 70 })))
      .toEqual({ kind: 'single', target: 70 });
  });

  it('is null when the thermostat exposes no committed target (e.g. off)', () => {
    expect(setpointModel(climate({ current_temperature: 69 }, 'off'))).toBeNull();
    // A lone range bound is not a range — and not silently a single either.
    expect(setpointModel(climate({ target_temp_low: 68 }))).toBeNull();
  });
});

describe('tempStep / tempBounds', () => {
  it('honors target_temp_step (HA wire name) and defaults to 0.5', () => {
    expect(tempStep(climate({ target_temp_step: 1 }))).toBe(1);
    expect(tempStep(climate({}))).toBe(0.5);
    expect(tempStep(climate({ target_temp_step: 0 }))).toBe(0.5);
    // The Python property name never appears in state attributes.
    expect(tempStep(climate({ target_temperature_step: 1 }))).toBe(0.5);
  });

  it('uses the entity min/max and reports unknown bounds as null', () => {
    expect(tempBounds(climate({ min_temp: 55, max_temp: 85 }))).toEqual({ min: 55, max: 85 });
    // Missing or degenerate attributes must never produce a guessed clamp
    // range — a wrong guess would rewrite the thermostat on the first tap.
    expect(tempBounds(climate({ current_temperature: 70 }))).toBeNull();
    expect(tempBounds(climate({ min_temp: 30, max_temp: 30 }))).toBeNull();
  });
});

describe('gaugeBounds', () => {
  it('prefers real bounds and only unit-guesses for the display arc', () => {
    expect(gaugeBounds(climate({ min_temp: 55, max_temp: 85 }))).toEqual({ min: 55, max: 85 });
    expect(gaugeBounds(climate({ current_temperature: 70 }))).toEqual({ min: 60, max: 85 });
    expect(gaugeBounds(climate({ current_temperature: 21 }))).toEqual({ min: 15, max: 30 });
    expect(gaugeBounds(climate({ min_temp: 30, max_temp: 30, current_temperature: 21 })))
      .toEqual({ min: 15, max: 30 });
  });
});

describe('stepValue', () => {
  const bounds = { min: 60, max: 85 };

  it('steps by the increment and clamps at the bounds', () => {
    expect(stepValue(70, 1, 0.5, bounds)).toBe(70.5);
    expect(stepValue(70.5, -1, 0.5, bounds)).toBe(70);
    expect(stepValue(84.8, 1, 0.5, bounds)).toBe(85);
    expect(stepValue(60.2, -1, 0.5, bounds)).toBe(60);
  });

  it('rounds to the step precision so float drift cannot accumulate', () => {
    let v = 20.1;
    for (let i = 0; i < 10; i++) v = stepValue(v, 1, 0.1, { min: 15, max: 30 });
    expect(v).toBe(21.1);
    expect(stepValue(70, 1, 1, bounds)).toBe(71);
  });

  it('never rounds past a bound with more decimals than the step', () => {
    // Round-after-clamp would turn 21.75 into 21.8 — above max.
    expect(stepValue(21.5, 1, 0.5, { min: 15, max: 21.75 })).toBe(21.75);
    expect(stepValue(15.2, -1, 0.5, { min: 15.05, max: 30 })).toBe(15.05);
  });

  it('steps unclamped when the entity reports no bounds', () => {
    expect(stepValue(70, 1, 0.5, null)).toBe(70.5);
    expect(stepValue(70, -1, 0.5, null)).toBe(69.5);
  });
});

describe('hvacModes', () => {
  it('passes through a clean list and drops non-string entries', () => {
    expect(hvacModes(climate({ hvac_modes: ['heat', 'cool', 'off'] })))
      .toEqual(['heat', 'cool', 'off']);
    expect(hvacModes(climate({ hvac_modes: ['heat', 7, null, 'off'] })))
      .toEqual(['heat', 'off']);
  });

  it('returns an empty list for missing or non-array attributes', () => {
    expect(hvacModes(climate({}))).toEqual([]);
    expect(hvacModes(climate({ hvac_modes: 'heat' }))).toEqual([]);
  });
});

describe('formatTemp', () => {
  it('drops trailing zeros but keeps real halves', () => {
    expect(formatTemp(70)).toBe('70');
    expect(formatTemp(70.5)).toBe('70.5');
    expect(formatTemp(70.499999999)).toBe('70.5');
  });
});

describe('climateStateLine', () => {
  it('prefers hvac_action over the mode and appends the reading', () => {
    expect(climateStateLine(climate({ hvac_action: 'heating', current_temperature: 69.5 })))
      .toBe('Heating · 69.5° now');
    expect(climateStateLine(climate({ current_temperature: 69.5 })))
      .toBe('Heat · 69.5° now');
    expect(climateStateLine(climate({}, 'heat_cool'))).toBe('Heat cool');
    expect(climateStateLine(climate({}, 'unavailable'))).toBe('Unavailable');
  });
});

describe('hvacModeColor', () => {
  it('color-codes the known modes and greys the rest', () => {
    expect(hvacModeColor('heat')).toBe('#fb923c');
    expect(hvacModeColor('cool')).toBe('#38bdf8');
    expect(hvacModeColor('heat_cool')).toBe(hvacModeColor('auto'));
    expect(hvacModeColor('off')).toBe(hvacModeColor('eco_custom_mode'));
  });
});

describe('setTemperaturePayload', () => {
  it('builds the single and paired payloads', () => {
    expect(setTemperaturePayload({ kind: 'single', target: 70.5 }))
      .toEqual({ temperature: 70.5 });
    expect(setTemperaturePayload({ kind: 'range', low: 68, high: 74 }))
      .toEqual({ target_temp_low: 68, target_temp_high: 74 });
  });

  it('never lets the range cross — HA rejects low > high', () => {
    expect(setTemperaturePayload({ kind: 'range', low: 75, high: 74 }))
      .toEqual({ target_temp_low: 74, target_temp_high: 75 });
  });
});
