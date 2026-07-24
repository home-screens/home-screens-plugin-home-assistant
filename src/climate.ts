// Pure climate-capability helpers backing the detail sheet (controls.tsx)
// and the ClimateView gauge. Kept free of React so they can be unit-tested
// in the node environment.

import type { HAStateObject } from './types';
import { capitalize } from './utils';

/** What kind of setpoint UI this thermostat needs. Attribute-driven rather
 *  than supported_features-driven: HA's climate feature bits are dynamic
 *  (they follow the current mode on modern integrations), while the
 *  attributes actually present are exactly what we can render and commit. */
export type SetpointModel =
  | { kind: 'single'; target: number }
  | { kind: 'range'; low: number; high: number }
  | null;

export function setpointModel(s: HAStateObject): SetpointModel {
  const low = s.attributes.target_temp_low;
  const high = s.attributes.target_temp_high;
  if (typeof low === 'number' && typeof high === 'number') {
    return { kind: 'range', low, high };
  }
  const target = s.attributes.temperature;
  if (typeof target === 'number') return { kind: 'single', target };
  return null;
}

/** Stepper increment. HA serializes the climate entity's step as
 *  `target_temp_step` (the Python property is target_temperature_step, but
 *  that name never appears in state attributes — reading it here once made
 *  every thermostat fall back to 0.5, and HA rounds half-steps away
 *  half-to-even, so single taps on a whole-degree thermostat were no-ops).
 *  0.5 matches HA's own default UI when the attribute is absent. */
export function tempStep(s: HAStateObject): number {
  const step = s.attributes.target_temp_step;
  return typeof step === 'number' && step > 0 ? step : 0.5;
}

export interface TempBounds { min: number; max: number }

/** Setpoint range from the entity's own min_temp / max_temp (always in its
 *  native unit). Null when the attributes are missing or degenerate — a
 *  guessed range must never clamp a real setpoint commit, so callers that
 *  write to the device get "unknown" rather than a heuristic. */
export function tempBounds(s: HAStateObject): TempBounds | null {
  const min = s.attributes.min_temp;
  const max = s.attributes.max_temp;
  if (typeof min === 'number' && typeof max === 'number' && min < max) {
    return { min, max };
  }
  return null;
}

/** Display-only range for the gauge arc. Without real bounds, guess the
 *  unit from the reading — a livable indoor °C reading never exceeds ~45,
 *  while °F is always ≥45. A wrong guess only miscolors the arc. */
export function gaugeBounds(s: HAStateObject): TempBounds {
  const bounds = tempBounds(s);
  if (bounds) return bounds;
  const cur = s.attributes.current_temperature;
  const fahrenheitGuess = typeof cur === 'number' && cur > 45;
  return fahrenheitGuess ? { min: 60, max: 85 } : { min: 15, max: 30 };
}

/** One stepper tap: value ± step, rounded to the step's own precision so
 *  repeated float adds can't drift (70.5 + 0.5 stays 71, never 70.99999…),
 *  then clamped — rounding after the clamp could push the result past a
 *  bound with more decimals than the step. Null bounds skip the clamp. */
export function stepValue(
  value: number, dir: 1 | -1, step: number, bounds: TempBounds | null,
): number {
  const decimals = Math.min(2, (String(step).split('.')[1] ?? '').length);
  const next = Number((value + dir * step).toFixed(decimals));
  if (!bounds) return next;
  return Math.max(bounds.min, Math.min(bounds.max, next));
}

/** "70" / "70.5" — no trailing zeros, no unit (the ° sign is layout). */
export function formatTemp(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** hvac_modes as a safe string list — HA types it as an array, but a broken
 *  custom integration can hand back anything, and both the view pills and
 *  the sheet buttons map over it. */
export function hvacModes(s: HAStateObject): string[] {
  const raw = s.attributes.hvac_modes;
  return Array.isArray(raw)
    ? raw.filter((m): m is string => typeof m === 'string')
    : [];
}

/** "Heating · 69.5° now" header line for the detail sheet. */
export function climateStateLine(s: HAStateObject): string {
  if (s.state === 'unavailable' || s.state === 'unknown') return 'Unavailable';
  const action = s.attributes.hvac_action;
  const label = capitalize(typeof action === 'string' && action ? action : s.state);
  const cur = s.attributes.current_temperature;
  return typeof cur === 'number' ? `${label} · ${formatTemp(cur)}° now` : label;
}

/** Accent per HVAC mode, matching the plugin's existing signal palette
 *  (heat amber like the gauge, cool cyan like the cooling arc). */
export function hvacModeColor(mode: string): string {
  switch (mode) {
    case 'heat': return '#fb923c';
    case 'cool': return '#38bdf8';
    case 'heat_cool': case 'auto': return '#4ade80';
    case 'dry': return '#fbbf24';
    case 'fan_only': return '#94a3b8';
    default: return 'rgba(255,255,255,0.6)'; // off + unknown modes
  }
}

/** Payload for climate.set_temperature. HA rejects a lone target_temp_low /
 *  target_temp_high — range commits must always carry the pair. */
export function setTemperaturePayload(
  model: { kind: 'single'; target: number } | { kind: 'range'; low: number; high: number },
): Record<string, number> {
  if (model.kind === 'single') return { temperature: model.target };
  // Never let the pair cross — HA errors on low > high.
  const low = Math.min(model.low, model.high);
  const high = Math.max(model.low, model.high);
  return { target_temp_low: low, target_temp_high: high };
}
