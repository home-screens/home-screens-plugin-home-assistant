import { describe, expect, it } from 'vitest';
import {
  ALL_VIEWS, CONTROL_VIEWS, ENTITY_VIEWS, COMPACT_VIEWS, HISTORY_VIEWS,
  FULL_SCREEN_VIEWS, headerShown,
} from './types';
import type { HAView } from './types';

/**
 * The display settings each view offers, as one table.
 *
 * This is the spec the editor renders from, and it exists because a switch
 * shown where nothing reads the value is indistinguishable from a broken
 * feature: Compact mode used to render on all twelve views while four read
 * it, and 24-hour history on eleven while three drew it (and the fetch ran
 * on all eleven).
 *
 * When you add a view, this file fails until you have said, for each setting,
 * whether the view consumes it. Answer by checking the consumer named in the
 * comment on each set in types.ts, not by copying a neighbouring row.
 */
const MATRIX: Record<HAView, {
  controls: boolean; colors: boolean; compact: boolean; history: boolean;
}> = {
  //                controls  colors  compact  history
  'entity-card':  { controls: true,  colors: true,  compact: false, history: true },
  'entity-row':   { controls: true,  colors: true,  compact: false, history: false },
  'card-grid':    { controls: true,  colors: true,  compact: true,  history: true },
  'status-board': { controls: false, colors: true,  compact: false, history: false },
  room:           { controls: true,  colors: true,  compact: false, history: true },
  dashboard:      { controls: true,  colors: true,  compact: false, history: true },
  climate:        { controls: true,  colors: false, compact: false, history: false },
  media:          { controls: true,  colors: false, compact: false, history: false },
  cameras:        { controls: false, colors: false, compact: false, history: false },
  buttons:        { controls: true,  colors: false, compact: true,  history: false },
  alerts:         { controls: false, colors: false, compact: true,  history: false },
  batteries:      { controls: false, colors: false, compact: true,  history: false },
  power:          { controls: false, colors: false, compact: false, history: false },
  'energy-flow':  { controls: false, colors: false, compact: false, history: false },
  timeline:       { controls: false, colors: false, compact: false, history: false },
};

describe('view capabilities', () => {
  it('covers every view', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ALL_VIEWS].sort());
  });

  it.each(ALL_VIEWS)('%s offers exactly the settings it reads', (view) => {
    const want = MATRIX[view];
    expect(CONTROL_VIEWS.has(view)).toBe(want.controls);
    expect(ENTITY_VIEWS.has(view)).toBe(want.colors);
    expect(COMPACT_VIEWS.has(view)).toBe(want.compact);
    expect(HISTORY_VIEWS.has(view)).toBe(want.history);
  });

  // Show header and Fast updates are the two that are not view-specific:
  // index.tsx reads showHeader for everything except alerts, and the fast
  // poll is view-independent. Both are asserted here so the editor's two
  // remaining inline conditions are not the only record of that.
  it('leaves header and fast updates ungated by capability set', () => {
    const sets = [CONTROL_VIEWS, ENTITY_VIEWS, COMPACT_VIEWS, HISTORY_VIEWS];
    expect(sets.some((s) => s.size === ALL_VIEWS.length)).toBe(false);
  });
});

describe('headerShown', () => {
  it('starts on for widgets and off for full-screen views', () => {
    for (const view of ALL_VIEWS) {
      expect(headerShown(view, undefined)).toBe(!FULL_SCREEN_VIEWS.has(view));
    }
  });

  it('always honours an explicit choice', () => {
    expect(headerShown('dashboard', true)).toBe(true);
    expect(headerShown('card-grid', false)).toBe(false);
  });
});
