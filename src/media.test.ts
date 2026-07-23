import { describe, expect, it } from 'vitest';
import {
  MEDIA_FEATURES, supportsPlayPause, supportsPrevious, supportsNext,
  supportsVolumeSlider, transportAvailable, supportsAnyTransport,
  volumeFraction, volumeFromFraction,
} from './media';
import type { HAStateObject } from './types';

function player(attributes: Record<string, unknown>, state = 'playing'): HAStateObject {
  return {
    entity_id: 'media_player.kitchen', state,
    attributes: { friendly_name: 'Kitchen Speaker', ...attributes },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

const FULL = MEDIA_FEATURES.PAUSE | MEDIA_FEATURES.VOLUME_SET
  | MEDIA_FEATURES.PREVIOUS_TRACK | MEDIA_FEATURES.NEXT_TRACK | MEDIA_FEATURES.PLAY;

describe('feature gates', () => {
  it('decodes the supported_features bitmask per control', () => {
    const s = player({ supported_features: FULL, volume_level: 0.4 });
    expect(supportsPlayPause(s)).toBe(true);
    expect(supportsPrevious(s)).toBe(true);
    expect(supportsNext(s)).toBe(true);
    expect(supportsVolumeSlider(s)).toBe(true);
  });

  it('shows play-pause when only one of PLAY/PAUSE is advertised', () => {
    expect(supportsPlayPause(player({ supported_features: MEDIA_FEATURES.PAUSE }))).toBe(true);
    expect(supportsPlayPause(player({ supported_features: MEDIA_FEATURES.PLAY }))).toBe(true);
    expect(supportsPlayPause(player({ supported_features: MEDIA_FEATURES.NEXT_TRACK }))).toBe(false);
  });

  it('hides everything when the bitmask is missing', () => {
    const s = player({ volume_level: 0.4 });
    expect(supportsPlayPause(s)).toBe(false);
    expect(supportsPrevious(s)).toBe(false);
    expect(supportsNext(s)).toBe(false);
    expect(supportsVolumeSlider(s)).toBe(false);
  });

  it('needs a live volume_level for the slider, not just the bit', () => {
    expect(supportsVolumeSlider(player({ supported_features: MEDIA_FEATURES.VOLUME_SET })))
      .toBe(false);
  });
});

describe('supportsAnyTransport', () => {
  it('is true with any single control and false with no feature bits', () => {
    expect(supportsAnyTransport(player({ supported_features: MEDIA_FEATURES.PLAY }))).toBe(true);
    expect(supportsAnyTransport(player({
      supported_features: MEDIA_FEATURES.VOLUME_SET, volume_level: 0.4,
    }))).toBe(true);
    expect(supportsAnyTransport(player({}))).toBe(false);
    expect(supportsAnyTransport(player({ supported_features: 0 }))).toBe(false);
    // Volume bit without a live level renders no button either.
    expect(supportsAnyTransport(player({ supported_features: MEDIA_FEATURES.VOLUME_SET })))
      .toBe(false);
  });
});

describe('transportAvailable', () => {
  it('renders for anything alive, hides for off/gone players', () => {
    expect(transportAvailable(player({}, 'playing'))).toBe(true);
    expect(transportAvailable(player({}, 'paused'))).toBe(true);
    expect(transportAvailable(player({}, 'idle'))).toBe(true);
    expect(transportAvailable(player({}, 'off'))).toBe(false);
    expect(transportAvailable(player({}, 'standby'))).toBe(false);
    expect(transportAvailable(player({}, 'unavailable'))).toBe(false);
  });
});

describe('volume math', () => {
  it('clamps the thumb fraction and nulls when unreported', () => {
    expect(volumeFraction(player({ volume_level: 0.35 }))).toBe(0.35);
    expect(volumeFraction(player({ volume_level: 1.2 }))).toBe(1);
    expect(volumeFraction(player({}))).toBeNull();
  });

  it('commits two-decimal volume_level values', () => {
    expect(volumeFromFraction(0.333333)).toBe(0.33);
    expect(volumeFromFraction(-0.1)).toBe(0);
    expect(volumeFromFraction(1.1)).toBe(1);
  });
});
