import { describe, expect, it } from 'vitest';
import { makeScale, BASE_FONT_SIZE } from './scale';

describe('makeScale', () => {
  it('leaves every dimension untouched at the plugin default size', () => {
    const u = makeScale(BASE_FONT_SIZE);
    expect(u.factor).toBe(1);
    for (const px of [9, 10, 12.5, 14, 24, 44, 100, 480]) {
      expect(u(px)).toBe(px);
    }
  });

  it('scales in proportion to the host Text size', () => {
    const u = makeScale(28);
    expect(u.factor).toBe(2);
    expect(u(10)).toBe(20);
    expect(u(24)).toBe(48);
  });

  it('rounds to hundredths so styles stay stable across renders', () => {
    // 40/14 is a repeating decimal — the raw product is 28.571428…
    expect(makeScale(40)(10)).toBe(28.57);
  });

  it('falls back to the default size for a missing or nonsensical style', () => {
    for (const bad of [0, -12, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(makeScale(bad).factor).toBe(1);
    }
  });
});

describe('touch targets', () => {
  it('grows with everything else when the module scales up', () => {
    expect(makeScale(28).touch(44)).toBe(88);
  });

  it('never shrinks a fingertip target below 44px', () => {
    // The host allows a Text size of 8, which would otherwise take a 44px
    // button down to 25px.
    const u = makeScale(8);
    expect(u(44)).toBeCloseTo(25.14);
    expect(u.touch(44)).toBe(44);
    expect(u.touch(52)).toBe(44);
  });

  it('holds a target authored smaller than the floor at its own size', () => {
    // A 30px chip is not a fingertip target to begin with; the floor must
    // not inflate it.
    expect(makeScale(8).touch(30)).toBe(30);
  });
});
