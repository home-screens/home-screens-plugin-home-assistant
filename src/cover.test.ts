import { describe, expect, it } from 'vitest';
import {
  COVER_FEATURES, supportsPosition, supportsStop, supportsOpen, supportsClose,
  positionFraction, positionFromFraction, coverStateLine,
} from './cover';
import type { HAStateObject } from './types';

function cover(attributes: Record<string, unknown>, state = 'open'): HAStateObject {
  return {
    entity_id: 'cover.living_room_blinds', state,
    attributes: { friendly_name: 'Living Room Blinds', ...attributes },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

const FULL = COVER_FEATURES.OPEN | COVER_FEATURES.CLOSE
  | COVER_FEATURES.SET_POSITION | COVER_FEATURES.STOP;

describe('feature gates', () => {
  it('decodes the supported_features bitmask per control', () => {
    const s = cover({ supported_features: FULL });
    expect(supportsPosition(s)).toBe(true);
    expect(supportsStop(s)).toBe(true);
    expect(supportsOpen(s)).toBe(true);
    expect(supportsClose(s)).toBe(true);
  });

  it('gates position and stop off a minimal open/close cover', () => {
    const s = cover({ supported_features: COVER_FEATURES.OPEN | COVER_FEATURES.CLOSE });
    expect(supportsPosition(s)).toBe(false);
    expect(supportsStop(s)).toBe(false);
    expect(supportsOpen(s)).toBe(true);
    expect(supportsClose(s)).toBe(true);
  });

  it('gates open and close on their own bits for one-way covers', () => {
    const openOnly = cover({ supported_features: COVER_FEATURES.OPEN });
    expect(supportsOpen(openOnly)).toBe(true);
    expect(supportsClose(openOnly)).toBe(false);
    const closeOnly = cover({ supported_features: COVER_FEATURES.CLOSE });
    expect(supportsOpen(closeOnly)).toBe(false);
    expect(supportsClose(closeOnly)).toBe(true);
  });

  it('defaults a missing bitmask to open/close only', () => {
    const s = cover({});
    expect(supportsOpen(s)).toBe(true);
    expect(supportsClose(s)).toBe(true);
    expect(supportsPosition(s)).toBe(false);
    expect(supportsStop(s)).toBe(false);
  });
});

describe('positionFraction', () => {
  it('maps current_position to 0–1, clamped', () => {
    expect(positionFraction(cover({ current_position: 75 }))).toBe(0.75);
    expect(positionFraction(cover({ current_position: 130 }))).toBe(1);
    expect(positionFraction(cover({ current_position: -5 }))).toBe(0);
  });

  it('falls back to the state when position is unreported', () => {
    expect(positionFraction(cover({}, 'open'))).toBe(1);
    expect(positionFraction(cover({}, 'opening'))).toBe(1);
    expect(positionFraction(cover({}, 'closed'))).toBe(0);
    expect(positionFraction(cover({}, 'closing'))).toBe(0);
  });
});

describe('positionFromFraction', () => {
  it('commits whole 0–100 positions', () => {
    expect(positionFromFraction(0.754)).toBe(75);
    expect(positionFromFraction(0)).toBe(0);
    expect(positionFromFraction(1)).toBe(100);
  });
});

describe('coverStateLine', () => {
  it('shows motion, partial positions, and plain endpoints', () => {
    expect(coverStateLine(cover({ current_position: 75 }, 'open'))).toBe('Open · 75%');
    expect(coverStateLine(cover({ current_position: 100 }, 'open'))).toBe('Open');
    expect(coverStateLine(cover({ current_position: 0 }, 'closed'))).toBe('Closed');
    expect(coverStateLine(cover({}, 'opening'))).toBe('Opening…');
    expect(coverStateLine(cover({}, 'closing'))).toBe('Closing…');
    expect(coverStateLine(cover({}, 'unavailable'))).toBe('Unavailable');
  });
});
