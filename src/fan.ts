// Pure fan-capability helpers backing the fan detail sheet (controls.tsx).
// Kept free of React so they can be unit-tested in the node environment.

import type { HAStateObject } from './types';

// fan supported_features bits (HA FanEntityFeature).
export const FAN_FEATURES = {
  SET_SPEED: 1,
  OSCILLATE: 2,
  DIRECTION: 4,
  PRESET_MODE: 8,
} as const;

function featureBits(s: HAStateObject): number {
  const f = s.attributes.supported_features;
  return typeof f === 'number' ? f : 0;
}

/** Whether this fan takes a speed at all. The feature bit alone decides it:
 *  a fan that is off often publishes no `percentage`, and requiring one would
 *  hide the slider exactly when you need it to pick a speed. `speedFraction`
 *  positions the thumb from the on/off state in that case. */
export function supportsSpeed(s: HAStateObject): boolean {
  return (featureBits(s) & FAN_FEATURES.SET_SPEED) !== 0;
}

/** Percentage granularity. HA publishes `percentage_step` as 100 / speed
 *  count, so a 3-speed fan reports 33.33 and must land on 33/67/100 — a
 *  slider committing 41% would just get rounded by the integration. */
export function speedStep(s: HAStateObject): number {
  const step = s.attributes.percentage_step;
  return typeof step === 'number' && step > 0 && step <= 100 ? step : 1;
}

/** 0–1 thumb position, clamped. Falls back to the on/off state for fans
 *  that report no percentage. */
export function speedFraction(s: HAStateObject): number {
  const pct = s.attributes.percentage;
  if (typeof pct === 'number' && !Number.isNaN(pct)) {
    return Math.max(0, Math.min(1, pct / 100));
  }
  return s.state === 'on' ? 1 : 0;
}

/** set_percentage payload from a slider fraction, snapped to the entity's
 *  speed steps. Percentage 0 is HA's own "off" for this service. */
export function percentageFromFraction(fraction: number, step = 1): number {
  const raw = Math.max(0, Math.min(100, fraction * 100));
  if (step <= 1) return Math.round(raw);
  const snapped = Math.round(raw / step) * step;
  return Math.max(0, Math.min(100, Math.round(snapped)));
}

/** "On · 67%" / "Off" header line for the detail sheet. */
export function fanStateLine(s: HAStateObject): string {
  if (s.state === 'unavailable' || s.state === 'unknown') return 'Unavailable';
  if (s.state !== 'on') return 'Off';
  const pct = s.attributes.percentage;
  // 100% adds nothing over "On"; the in-between speeds are the signal.
  if (typeof pct === 'number' && pct > 0 && pct < 100) return `On · ${Math.round(pct)}%`;
  return 'On';
}
