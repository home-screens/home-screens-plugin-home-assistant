// Pure light-capability helpers backing the detail sheet (controls.tsx).
// Kept free of React so they can be unit-tested in the node environment.

import { tr } from './i18n';
import type { HAStateObject } from './types';

// HA color modes that mean "this light can render arbitrary colors".
const COLOR_CAPABLE_MODES = new Set(['hs', 'rgb', 'rgbw', 'rgbww', 'xy']);

export function supportsColorTemp(s: HAStateObject): boolean {
  const modes = s.attributes.supported_color_modes;
  return Array.isArray(modes) && modes.includes('color_temp');
}

export function supportsColor(s: HAStateObject): boolean {
  const modes = s.attributes.supported_color_modes;
  return Array.isArray(modes) && modes.some((m) => COLOR_CAPABLE_MODES.has(m));
}

/** Lights whose only mode is onoff can't dim. Missing/empty mode lists
 *  (older HA, odd integrations) default to dimmable — a brightness_pct on a
 *  non-dimmable light is harmlessly ignored by HA, while hiding the slider
 *  on a dimmable light would lose the sheet's main control. */
export function supportsBrightness(s: HAStateObject): boolean {
  const modes = s.attributes.supported_color_modes;
  if (!Array.isArray(modes) || modes.length === 0) return true;
  return modes.some((m) => m !== 'onoff');
}

export interface KelvinRange { min: number; max: number }

const DEFAULT_KELVIN: KelvinRange = { min: 2000, max: 6500 };

export function colorTempRange(s: HAStateObject): KelvinRange {
  const min = s.attributes.min_color_temp_kelvin;
  const max = s.attributes.max_color_temp_kelvin;
  if (typeof min === 'number' && typeof max === 'number' && min < max) {
    return { min, max };
  }
  return DEFAULT_KELVIN;
}

/** 0–100, or null when the light is off / reports no brightness. */
export function brightnessPct(s: HAStateObject): number | null {
  if (s.state !== 'on') return null;
  const b = s.attributes.brightness;
  if (typeof b !== 'number') return null;
  return Math.max(0, Math.min(100, Math.round((b / 255) * 100)));
}

export function currentKelvin(s: HAStateObject): number | null {
  const k = s.attributes.color_temp_kelvin;
  return typeof k === 'number' ? k : null;
}

/** Fraction (0–1) along a min/max range, clamped. */
export function rangeFraction(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/** Inverse of rangeFraction, snapped to 50K steps like HA's own UI. */
export function kelvinFromFraction(fraction: number, range: KelvinRange): number {
  const raw = range.min + Math.max(0, Math.min(1, fraction)) * (range.max - range.min);
  const snapped = Math.round(raw / 50) * 50;
  return Math.max(range.min, Math.min(range.max, snapped));
}

/** Brightness percent from a slider fraction; floor 1 so a full-left drag
 *  dims to minimum instead of turning the light off (the power button owns
 *  off). */
export function brightnessFromFraction(fraction: number): number {
  return Math.max(1, Math.min(100, Math.round(fraction * 100)));
}

export function describeKelvin(k: number): string {
  if (k < 3000) return 'Warm';
  if (k < 4500) return 'Neutral';
  return 'Daylight';
}

/** "On · 68% · Warm" header line for the detail sheet. */
export function lightStateLine(s: HAStateObject): string {
  if (s.state !== 'on') return s.state === 'off' ? tr('common.off', 'Off') : s.state;
  const parts = [tr('common.on', 'On')];
  const pct = brightnessPct(s);
  if (pct != null) parts.push(`${pct}%`);
  const k = currentKelvin(s);
  if (k != null) parts.push(describeKelvin(k));
  return parts.join(' · ');
}

export interface Swatch {
  name: string;
  css: string;
  rgb: [number, number, number];
}

export const LIGHT_SWATCHES: Swatch[] = [
  { name: 'Warm white', css: '#ffd9a3', rgb: [255, 217, 163] },
  { name: 'White', css: '#ffffff', rgb: [255, 255, 255] },
  { name: 'Red', css: '#f87171', rgb: [248, 113, 113] },
  { name: 'Orange', css: '#fb923c', rgb: [251, 146, 60] },
  { name: 'Green', css: '#4ade80', rgb: [74, 222, 128] },
  { name: 'Blue', css: '#60a5fa', rgb: [96, 165, 250] },
  { name: 'Purple', css: '#c084fc', rgb: [192, 132, 252] },
];

/** Which swatch (if any) matches the light's current color, within a
 *  perceptual-enough RGB distance. Used only for the selected ring — a
 *  fuzzy match is fine, a wrong-looking ring is not, hence the tolerance. */
export function activeSwatch(s: HAStateObject): Swatch | null {
  const rgb = s.attributes.rgb_color;
  if (!Array.isArray(rgb) || rgb.length < 3) return null;
  const [r, g, b] = rgb;
  if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return null;
  let best: Swatch | null = null;
  let bestDist = Infinity;
  for (const sw of LIGHT_SWATCHES) {
    const d = (sw.rgb[0] - r) ** 2 + (sw.rgb[1] - g) ** 2 + (sw.rgb[2] - b) ** 2;
    if (d < bestDist) { bestDist = d; best = sw; }
  }
  const TOLERANCE = 40 * 40 * 3;
  return bestDist <= TOLERANCE ? best : null;
}
