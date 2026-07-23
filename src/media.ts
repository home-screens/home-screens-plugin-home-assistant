// Pure media_player-capability helpers backing the MediaView transport row
// and volume slider. Kept free of React so they can be unit-tested in the
// node environment.

import type { HAStateObject } from './types';

// media_player supported_features bits (HA MediaPlayerEntityFeature).
export const MEDIA_FEATURES = {
  PAUSE: 1,
  VOLUME_SET: 4,
  PREVIOUS_TRACK: 16,
  NEXT_TRACK: 32,
  PLAY: 16384,
} as const;

function featureBits(s: HAStateObject): number {
  const f = s.attributes.supported_features;
  return typeof f === 'number' ? f : 0;
}

/** Either PLAY or PAUSE is enough — media_play_pause resolves the other
 *  side, and players commonly advertise just one of the two. */
export function supportsPlayPause(s: HAStateObject): boolean {
  return (featureBits(s) & (MEDIA_FEATURES.PLAY | MEDIA_FEATURES.PAUSE)) !== 0;
}

export function supportsPrevious(s: HAStateObject): boolean {
  return (featureBits(s) & MEDIA_FEATURES.PREVIOUS_TRACK) !== 0;
}

export function supportsNext(s: HAStateObject): boolean {
  return (featureBits(s) & MEDIA_FEATURES.NEXT_TRACK) !== 0;
}

/** Volume slider needs the bit AND a live volume_level to position the
 *  thumb — a slider with no known position would commit surprises. */
export function supportsVolumeSlider(s: HAStateObject): boolean {
  return (featureBits(s) & MEDIA_FEATURES.VOLUME_SET) !== 0
    && typeof s.attributes.volume_level === 'number';
}

/** Transport is pointless while the player is off or gone — idle/paused
 *  players still show it (play can start a queued source). */
export function transportAvailable(s: HAStateObject): boolean {
  return !['off', 'unavailable', 'unknown', 'standby'].includes(s.state);
}

/** Whether the transport row would render any button at all — a player
 *  advertising no feature bits should get no row, not an empty one. */
export function supportsAnyTransport(s: HAStateObject): boolean {
  return supportsPlayPause(s) || supportsPrevious(s) || supportsNext(s)
    || supportsVolumeSlider(s);
}

/** 0–1 thumb position, clamped; null when the player reports no volume. */
export function volumeFraction(s: HAStateObject): number | null {
  const v = s.attributes.volume_level;
  if (typeof v !== 'number' || Number.isNaN(v)) return null;
  return Math.max(0, Math.min(1, v));
}

/** volume_set payload value from a slider fraction. Two decimals matches
 *  HA's own step and keeps the optimistic patch comparable to what HA
 *  echoes back. */
export function volumeFromFraction(fraction: number): number {
  return Math.max(0, Math.min(1, Math.round(fraction * 100) / 100));
}
