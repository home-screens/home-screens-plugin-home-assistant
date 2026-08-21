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
  if (k < 3000) return tr('light.warmth.warm', 'Warm');
  if (k < 4500) return tr('light.warmth.neutral', 'Neutral');
  return tr('light.warmth.daylight', 'Daylight');
}

/** "On · 68% · Warm" header line for the detail sheet. */
export function lightStateLine(s: HAStateObject): string {
  if (s.state === 'unavailable' || s.state === 'unknown') {
    return tr('common.unavailable', 'Unavailable');
  }
  if (s.state !== 'on') return tr('common.off', 'Off');
  const parts = [tr('common.on', 'On')];
  const pct = brightnessPct(s);
  if (pct != null) parts.push(`${pct}%`);
  const k = currentKelvin(s);
  if (k != null) parts.push(describeKelvin(k));
  return parts.join(' · ');
}

export interface Swatch {
  name: string;
  /** Translation key suffix under `light.swatch.` for the spoken name. */
  key: string;
  css: string;
  rgb: [number, number, number];
}

export const LIGHT_SWATCHES: Swatch[] = [
  { name: 'Warm white', key: 'warmWhite', css: '#ffd9a3', rgb: [255, 217, 163] },
  { name: 'White', key: 'white', css: '#ffffff', rgb: [255, 255, 255] },
  { name: 'Red', key: 'red', css: '#f87171', rgb: [248, 113, 113] },
  { name: 'Orange', key: 'orange', css: '#fb923c', rgb: [251, 146, 60] },
  { name: 'Green', key: 'green', css: '#4ade80', rgb: [74, 222, 128] },
  { name: 'Blue', key: 'blue', css: '#60a5fa', rgb: [96, 165, 250] },
  { name: 'Purple', key: 'purple', css: '#c084fc', rgb: [192, 132, 252] },
];

/** The swatch's name in the display's language. The English names double
 *  as the tr() fallback, so a host without the key still reads "Blue". */
export function swatchLabel(sw: Swatch): string {
  return tr(`light.swatch.${sw.key}`, sw.name);
}

/** Big value line for the sheet's color mode: the preset the light is
 *  sitting on, or "Custom color" for anything picked off the wheel. */
export function describeLightColor(s: HAStateObject): string {
  const sw = activeSwatch(s);
  return sw ? swatchLabel(sw) : tr('light.customColor', 'Custom color');
}

/** The light's hue/saturation, or null when it reports none (a white-only
 *  light, or one that is off and has dropped its color attributes). */
export function currentHs(s: HAStateObject): [number, number] | null {
  const hs = s.attributes.hs_color;
  if (!Array.isArray(hs) || hs.length < 2) return null;
  const [h, sat] = hs;
  if (typeof h !== 'number' || typeof sat !== 'number') return null;
  return [h, sat];
}

// ── Hue/saturation wheel geometry ──────────────────────────────────────────
//
// The wheel is a CSS conic-gradient of hues (0 at twelve o'clock, clockwise,
// the browser's default) under a radial white wash, so saturation grows
// from the centre (0) to the rim (100). Both directions of the mapping live
// here so the marker lands on the exact spot a pointer picked.

/** Hue 0–360 and saturation 0–100 for a pointer at (x, y) on a wheel of
 *  radius r centred at (cx, cy). Points outside the rim clamp to full
 *  saturation along the same hue, so a finger that overshoots still picks
 *  the color it is pointing at. */
export function hsFromWheelPoint(
  x: number, y: number, cx: number, cy: number, r: number,
): [number, number] {
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (r <= 0 || dist === 0) return [0, 0];
  // atan2(dx, -dy) puts 0° at the top and grows clockwise, matching the
  // gradient's default start angle and direction.
  let hue = (Math.atan2(dx, -dy) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  const sat = Math.min(1, dist / r) * 100;
  return [Math.round(hue) % 360, Math.round(sat)];
}

/** Inverse of hsFromWheelPoint: the marker's offset from the wheel centre
 *  for a hue/saturation pair. */
export function wheelPointFromHs(
  hue: number, sat: number, r: number,
): { x: number; y: number } {
  const theta = (hue * Math.PI) / 180;
  const dist = Math.max(0, Math.min(100, sat)) / 100 * r;
  return { x: Math.sin(theta) * dist, y: -Math.cos(theta) * dist };
}

/** CSS color for a hue/saturation pair: full hue at the rim, white at the
 *  centre, the same ramp the wheel paints. */
export function hsCss(hue: number, sat: number): string {
  const clamped = Math.max(0, Math.min(100, sat));
  return `hsl(${Math.round(hue)} 100% ${Math.round(100 - clamped / 2)}%)`;
}

/** The wheel's hue ring, as a conic gradient over the CSS hue circle. */
export const HUE_CONIC = `conic-gradient(${
  [0, 60, 120, 180, 240, 300, 360].map((h) => `hsl(${h} 100% 50%)`).join(', ')
})`;

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
