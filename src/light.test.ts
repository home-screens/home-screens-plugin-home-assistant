import { describe, expect, it } from 'vitest';
import {
  supportsColorTemp, supportsColor, supportsBrightness,
  colorTempRange, brightnessPct, currentKelvin,
  rangeFraction, kelvinFromFraction, brightnessFromFraction,
  describeKelvin, lightStateLine, activeSwatch, LIGHT_SWATCHES,
} from './light';
import type { HAStateObject } from './types';

function light(state = 'on', attributes: Record<string, unknown> = {}): HAStateObject {
  return {
    entity_id: 'light.kitchen',
    state,
    attributes,
    last_changed: '2026-07-16T00:00:00Z',
    last_updated: '2026-07-16T00:00:00Z',
  };
}

describe('capability detection', () => {
  it('reads color temp and color support from supported_color_modes', () => {
    expect(supportsColorTemp(light('on', { supported_color_modes: ['color_temp', 'hs'] }))).toBe(true);
    expect(supportsColorTemp(light('on', { supported_color_modes: ['onoff'] }))).toBe(false);
    expect(supportsColor(light('on', { supported_color_modes: ['hs'] }))).toBe(true);
    expect(supportsColor(light('on', { supported_color_modes: ['rgbww'] }))).toBe(true);
    expect(supportsColor(light('on', { supported_color_modes: ['color_temp'] }))).toBe(false);
  });

  it('treats onoff-only lights as non-dimmable, missing modes as dimmable', () => {
    expect(supportsBrightness(light('on', { supported_color_modes: ['onoff'] }))).toBe(false);
    expect(supportsBrightness(light('on', { supported_color_modes: ['brightness'] }))).toBe(true);
    expect(supportsBrightness(light('on'))).toBe(true);
  });
});

describe('ranges and fractions', () => {
  it('uses the entity kelvin bounds, falling back when absent or inverted', () => {
    expect(colorTempRange(light('on', {
      min_color_temp_kelvin: 2200, max_color_temp_kelvin: 6000,
    }))).toEqual({ min: 2200, max: 6000 });
    expect(colorTempRange(light('on'))).toEqual({ min: 2000, max: 6500 });
    expect(colorTempRange(light('on', {
      min_color_temp_kelvin: 6000, max_color_temp_kelvin: 2200,
    }))).toEqual({ min: 2000, max: 6500 });
  });

  it('converts brightness 0-255 to 0-100 only while on', () => {
    expect(brightnessPct(light('on', { brightness: 255 }))).toBe(100);
    expect(brightnessPct(light('on', { brightness: 128 }))).toBe(50);
    expect(brightnessPct(light('off', { brightness: 128 }))).toBeNull();
    expect(brightnessPct(light('on'))).toBeNull();
  });

  it('clamps rangeFraction and snaps kelvinFromFraction to 50K within bounds', () => {
    expect(rangeFraction(2700, 2000, 6500)).toBeCloseTo(0.1556, 3);
    expect(rangeFraction(1000, 2000, 6500)).toBe(0);
    expect(rangeFraction(9000, 2000, 6500)).toBe(1);
    // A collapsed or inverted kelvin range centers the thumb instead of
    // dividing by zero — live entities can report equal min/max bounds.
    expect(rangeFraction(3000, 4000, 4000)).toBe(0.5);
    expect(rangeFraction(3000, 5000, 4000)).toBe(0.5);
    expect(kelvinFromFraction(0.5, { min: 2000, max: 6500 })).toBe(4250);
    expect(kelvinFromFraction(0, { min: 2210, max: 6500 })).toBe(2210);
    expect(kelvinFromFraction(1, { min: 2000, max: 6490 })).toBe(6490);
  });

  it('floors brightnessFromFraction at 1 so a full-left drag never turns off', () => {
    expect(brightnessFromFraction(0)).toBe(1);
    expect(brightnessFromFraction(0.68)).toBe(68);
    expect(brightnessFromFraction(1)).toBe(100);
  });
});

describe('lightStateLine', () => {
  it('composes on-state parts and names the warmth band', () => {
    expect(lightStateLine(light('on', { brightness: 173, color_temp_kelvin: 2700 })))
      .toBe('On · 68% · Warm');
    expect(lightStateLine(light('on', { brightness: 255, color_temp_kelvin: 4000 })))
      .toBe('On · 100% · Neutral');
    expect(lightStateLine(light('on'))).toBe('On');
    expect(lightStateLine(light('off'))).toBe('Off');
    expect(lightStateLine(light('unavailable'))).toBe('unavailable');
  });

  it('bands kelvin into Warm / Neutral / Daylight', () => {
    expect(describeKelvin(2200)).toBe('Warm');
    expect(describeKelvin(4000)).toBe('Neutral');
    expect(describeKelvin(6500)).toBe('Daylight');
  });
});

describe('activeSwatch', () => {
  it('matches the nearest swatch within tolerance', () => {
    expect(activeSwatch(light('on', { rgb_color: [250, 110, 115] }))?.name).toBe('Red');
    expect(activeSwatch(light('on', { rgb_color: [255, 255, 255] }))?.name).toBe('White');
  });

  it('returns null for distant colors or missing rgb', () => {
    expect(activeSwatch(light('on', { rgb_color: [0, 0, 0] }))).toBeNull();
    expect(activeSwatch(light('on'))).toBeNull();
    expect(activeSwatch(light('on', { rgb_color: [255] }))).toBeNull();
    expect(activeSwatch(light('on', { rgb_color: ['a', 'b', 'c'] }))).toBeNull();
  });

  it('keeps 44px-target-friendly swatch count', () => {
    // The sheet lays swatches in one row on a ~480px sheet; more than 8
    // would wrap awkwardly on narrow modules.
    expect(LIGHT_SWATCHES.length).toBeLessThanOrEqual(8);
  });
});
