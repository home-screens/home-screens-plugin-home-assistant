import { describe, expect, it } from 'vitest';
import { exceedsSlop, fractionFromX, fractionFromY } from './controls';

// The pointer-event plumbing in controls.tsx needs a DOM; these tests pin
// the pure geometry it delegates to — the slider's clientX→fraction math
// and the long-press slop radius.

describe('fractionFromX', () => {
  it('maps clientX linearly across the track, clamped to 0–1', () => {
    expect(fractionFromX(150, 100, 100, 0.5)).toBe(0.5);
    expect(fractionFromX(100, 100, 100, 0.5)).toBe(0);
    expect(fractionFromX(200, 100, 100, 0.5)).toBe(1);
    expect(fractionFromX(40, 100, 100, 0.5)).toBe(0);
    expect(fractionFromX(260, 100, 100, 0.5)).toBe(1);
  });

  it('falls back to the live fraction when the track has no width', () => {
    expect(fractionFromX(150, 100, 0, 0.42)).toBe(0.42);
    expect(fractionFromX(150, 100, -5, 0.42)).toBe(0.42);
  });
});

describe('exceedsSlop', () => {
  it('measures radial distance, not per-axis', () => {
    expect(exceedsSlop(8, 0)).toBe(false);  // exactly on the 8px radius
    expect(exceedsSlop(9, 0)).toBe(true);
    expect(exceedsSlop(6, 6)).toBe(true);   // diagonal exceeds though each axis is under
    expect(exceedsSlop(-9, 0)).toBe(true);  // sign-independent
  });

  it('honors a custom slop radius', () => {
    expect(exceedsSlop(3, 4, 5)).toBe(false); // 3-4-5: exactly on the radius
    expect(exceedsSlop(3, 4.1, 5)).toBe(true);
  });
});

describe('fractionFromY', () => {
  it('maps clientY so the top of the track is 1 and the bottom 0', () => {
    expect(fractionFromY(100, 100, 200, 0.5)).toBe(1);
    expect(fractionFromY(300, 100, 200, 0.5)).toBe(0);
    expect(fractionFromY(150, 100, 200, 0.5)).toBe(0.75);
    expect(fractionFromY(40, 100, 200, 0.5)).toBe(1);
    expect(fractionFromY(400, 100, 200, 0.5)).toBe(0);
  });

  it('falls back to the live fraction when the track has no height', () => {
    expect(fractionFromY(150, 100, 0, 0.42)).toBe(0.42);
    expect(fractionFromY(150, 100, -5, 0.42)).toBe(0.42);
  });
});
