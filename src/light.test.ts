import { describe, expect, it } from 'vitest';
import {
  supportsColorTemp, supportsColor, supportsBrightness,
  colorTempRange, brightnessPct, currentKelvin,
  rangeFraction, kelvinFromFraction, brightnessFromFraction,
  describeKelvin, lightStateLine, activeSwatch, LIGHT_SWATCHES,
  describeLightColor, currentHs, hsFromWheelPoint, wheelPointFromHs, hsCss,
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
  });

  // A bulb that drops off the network while its detail sheet is open must not
  // leak the raw HA token onto a translated display, which is what every
  // sibling module (fan, lock, cover, media, vacuum) already guards against.
  it('translates the unreachable states rather than echoing them', () => {
    expect(lightStateLine(light('unavailable'))).toBe('Unavailable');
    expect(lightStateLine(light('unknown'))).toBe('Unavailable');
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

describe('color mode helpers', () => {
  it('names the active preset, otherwise calls it a custom color', () => {
    expect(describeLightColor(light('on', { rgb_color: [96, 165, 250] }))).toBe('Blue');
    expect(describeLightColor(light('on', { rgb_color: [10, 200, 200] }))).toBe('Custom color');
    expect(describeLightColor(light('on'))).toBe('Custom color');
  });

  it('reads hs_color only when it is a numeric pair', () => {
    expect(currentHs(light('on', { hs_color: [30, 60] }))).toEqual([30, 60]);
    expect(currentHs(light('on', { hs_color: [30] }))).toBeNull();
    expect(currentHs(light('on', { hs_color: ['a', 'b'] }))).toBeNull();
    expect(currentHs(light('on'))).toBeNull();
  });
});

describe('hue/saturation wheel geometry', () => {
  const r = 100;

  it('maps the compass points to hues clockwise from the top', () => {
    expect(hsFromWheelPoint(100, 0, 100, 100, r)).toEqual([0, 100]);    // top
    expect(hsFromWheelPoint(200, 100, 100, 100, r)).toEqual([90, 100]); // right
    expect(hsFromWheelPoint(100, 200, 100, 100, r)).toEqual([180, 100]); // bottom
    expect(hsFromWheelPoint(0, 100, 100, 100, r)).toEqual([270, 100]);  // left
  });

  it('grows saturation from the centre and clamps past the rim', () => {
    expect(hsFromWheelPoint(100, 100, 100, 100, r)).toEqual([0, 0]);
    expect(hsFromWheelPoint(150, 100, 100, 100, r)).toEqual([90, 50]);
    expect(hsFromWheelPoint(400, 100, 100, 100, r)).toEqual([90, 100]);
    expect(hsFromWheelPoint(150, 100, 100, 100, 0)).toEqual([0, 0]);
  });

  it('wraps hue 360 back to 0 and keeps fractional hues on the round trip', () => {
    // Just left of twelve o'clock rounds up to 360, which must read as 0.
    expect(hsFromWheelPoint(100 - 0.001, 0, 100, 100, r)[0]).toBe(0);
    const full = wheelPointFromHs(360, 100, r);
    const zero = wheelPointFromHs(0, 100, r);
    expect(full.x).toBeCloseTo(zero.x, 6);
    expect(full.y).toBeCloseTo(zero.y, 6);
    const p = wheelPointFromHs(47.6, 83, r);
    const [h, s] = hsFromWheelPoint(100 + p.x, 100 + p.y, 100, 100, r);
    expect(h).toBe(48);
    expect(s).toBe(83);
  });

  it('round-trips through wheelPointFromHs', () => {
    for (const [h, s] of [[0, 100], [45, 30], [200, 75], [359, 10]] as [number, number][]) {
      const p = wheelPointFromHs(h, s, r);
      expect(hsFromWheelPoint(100 + p.x, 100 + p.y, 100, 100, r)).toEqual([h, s]);
    }
    expect(wheelPointFromHs(0, 0, r)).toEqual({ x: 0, y: -0 });
    expect(wheelPointFromHs(0, 250, r).y).toBe(-100);
  });

  it('paints white at the centre and the full hue at the rim', () => {
    expect(hsCss(120, 0)).toBe('hsl(120 100% 100%)');
    expect(hsCss(120, 100)).toBe('hsl(120 100% 50%)');
    expect(hsCss(120, 150)).toBe('hsl(120 100% 50%)');
  });

  it('gives every swatch a translation key', () => {
    for (const sw of LIGHT_SWATCHES) expect(sw.key).toMatch(/^[a-z][A-Za-z]*$/);
  });
});
