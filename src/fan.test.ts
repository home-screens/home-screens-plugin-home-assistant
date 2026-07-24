import { describe, expect, it } from 'vitest';
import {
  FAN_FEATURES, supportsSpeed, speedStep, speedFraction,
  percentageFromFraction, fanStateLine,
} from './fan';
import type { HAStateObject } from './types';

function fan(attributes: Record<string, unknown>, state = 'on'): HAStateObject {
  return {
    entity_id: 'fan.bedroom', state,
    attributes: { friendly_name: 'Bedroom Fan', ...attributes },
    last_changed: '2026-07-01T00:00:00Z', last_updated: '2026-07-01T00:00:00Z',
  };
}

describe('supportsSpeed', () => {
  it('reads the feature bit', () => {
    expect(supportsSpeed(fan({ supported_features: FAN_FEATURES.SET_SPEED, percentage: 66 }))).toBe(true);
    expect(supportsSpeed(fan({ percentage: 66 }))).toBe(false);
  });

  it('still offers the slider to a speed fan that is off with no percentage', () => {
    expect(supportsSpeed(fan({ supported_features: FAN_FEATURES.SET_SPEED }, 'off'))).toBe(true);
  });

  it('gates an on/off fan out of the slider', () => {
    expect(supportsSpeed(fan({ supported_features: FAN_FEATURES.OSCILLATE, percentage: 100 }))).toBe(false);
    expect(supportsSpeed(fan({}))).toBe(false);
  });
});

describe('speedStep', () => {
  it('reads percentage_step and falls back to 1', () => {
    expect(speedStep(fan({ percentage_step: 33.333333 }))).toBeCloseTo(33.333333);
    expect(speedStep(fan({}))).toBe(1);
    expect(speedStep(fan({ percentage_step: 0 }))).toBe(1);
    expect(speedStep(fan({ percentage_step: 140 }))).toBe(1);
  });
});

describe('speedFraction', () => {
  it('maps percentage to 0–1, clamped', () => {
    expect(speedFraction(fan({ percentage: 66 }))).toBeCloseTo(0.66);
    expect(speedFraction(fan({ percentage: 130 }))).toBe(1);
    expect(speedFraction(fan({ percentage: -5 }))).toBe(0);
  });

  it('falls back to the on/off state', () => {
    expect(speedFraction(fan({}, 'on'))).toBe(1);
    expect(speedFraction(fan({}, 'off'))).toBe(0);
  });
});

describe('percentageFromFraction', () => {
  it('commits whole percentages when the fan is continuous', () => {
    expect(percentageFromFraction(0.417)).toBe(42);
    expect(percentageFromFraction(0)).toBe(0);
    expect(percentageFromFraction(1)).toBe(100);
  });

  it('snaps to the entity speed steps for a 3-speed fan', () => {
    const step = 100 / 3;
    expect(percentageFromFraction(0.1, step)).toBe(0);
    expect(percentageFromFraction(0.3, step)).toBe(33);
    expect(percentageFromFraction(0.5, step)).toBe(67);
    expect(percentageFromFraction(0.9, step)).toBe(100);
    expect(percentageFromFraction(1, step)).toBe(100);
  });
});

describe('fanStateLine', () => {
  it('shows in-between speeds and plain on/off', () => {
    expect(fanStateLine(fan({ percentage: 66 }))).toBe('On · 66%');
    expect(fanStateLine(fan({ percentage: 100 }))).toBe('On');
    expect(fanStateLine(fan({ percentage: 0 }, 'off'))).toBe('Off');
    expect(fanStateLine(fan({}, 'unavailable'))).toBe('Unavailable');
  });
});
