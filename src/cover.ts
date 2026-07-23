// Pure cover-capability helpers backing the detail sheet (controls.tsx).
// Kept free of React so they can be unit-tested in the node environment.

import type { HAStateObject } from './types';

// cover supported_features bits (HA CoverEntityFeature).
export const COVER_FEATURES = {
  OPEN: 1,
  CLOSE: 2,
  SET_POSITION: 4,
  STOP: 8,
} as const;

/** A missing bitmask (older HA, odd integrations) defaults to plain
 *  open/close — every cover can do that, while position/stop stay gated
 *  on an explicit bit. */
function featureBits(s: HAStateObject): number {
  const f = s.attributes.supported_features;
  return typeof f === 'number' ? f : (COVER_FEATURES.OPEN | COVER_FEATURES.CLOSE);
}

export function supportsPosition(s: HAStateObject): boolean {
  return (featureBits(s) & COVER_FEATURES.SET_POSITION) !== 0;
}

export function supportsStop(s: HAStateObject): boolean {
  return (featureBits(s) & COVER_FEATURES.STOP) !== 0;
}

// Open and close are gated separately — a cover advertising only one of
// the bits (curtain that only retracts, vent that only opens) must not
// render a button whose service call HA will reject.
export function supportsOpen(s: HAStateObject): boolean {
  return (featureBits(s) & COVER_FEATURES.OPEN) !== 0;
}

export function supportsClose(s: HAStateObject): boolean {
  return (featureBits(s) & COVER_FEATURES.CLOSE) !== 0;
}

/** 0–1 slider position (0 = closed, 1 = open). Falls back to the state
 *  when current_position is absent mid-motion or on covers that only
 *  report open/closed. */
export function positionFraction(s: HAStateObject): number {
  const pos = s.attributes.current_position;
  if (typeof pos === 'number' && !Number.isNaN(pos)) {
    return Math.max(0, Math.min(1, pos / 100));
  }
  return s.state === 'open' || s.state === 'opening' ? 1 : 0;
}

/** set_cover_position payload value from a slider fraction. */
export function positionFromFraction(fraction: number): number {
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/** "Open · 75%" / "Closing…" header line for the detail sheet. */
export function coverStateLine(s: HAStateObject): string {
  if (s.state === 'unavailable' || s.state === 'unknown') return 'Unavailable';
  if (s.state === 'opening') return 'Opening…';
  if (s.state === 'closing') return 'Closing…';
  const label = s.state === 'open' ? 'Open' : s.state === 'closed' ? 'Closed' : s.state;
  const pos = s.attributes.current_position;
  // 0/100 add nothing over Open/Closed; in-between positions are the signal.
  if (typeof pos === 'number' && pos > 0 && pos < 100) return `${label} · ${pos}%`;
  return label;
}
