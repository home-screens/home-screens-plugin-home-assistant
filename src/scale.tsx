// Module-wide sizing. Every dimension on the display surface — type, gaps,
// padding, icons, touch targets — is authored at the size it should be when
// the host's "Text size" style is at this plugin's default, then run through
// the scale this module provides.
//
// Why this exists: the host scales a module by handing it style.fontSize
// (the Text size slider, 8–72) and expecting the module's contents to follow.
// Built-in modules get that for free by expressing everything in `em` off the
// module root. This plugin's cards are absolute layouts — a 24px value over
// an 18px icon inside a 100px-tall card — where `em` compounds unpredictably
// through nested font sizes. A single numeric factor applied at each call
// site does the same job without the compounding, and it works for SVG
// width/height attributes and clamp() bounds too, which `em` handles poorly.
//
// A display at 4K is the case that made this necessary: the user sizes the
// module to fill a quarter of a 3840×2160 screen, and without this every card
// stays the size it was on a 1080p canvas.

import React from 'react';

/** The font size this plugin's dimensions are authored against — the
 *  manifest's `defaultStyle.fontSize`. At this setting the scale factor is
 *  exactly 1 and every module renders pixel-for-pixel as it always has. */
export const BASE_FONT_SIZE = 14;

/** Smallest touch target we will ever draw, in px. The host allows text
 *  sizes down to 8, which would shrink a 44px button to 25px — under a
 *  fingertip on a wall-mounted kiosk. Interactive surfaces use `touch()`
 *  and grow but never shrink. */
const MIN_TOUCH_PX = 44;

export interface Scale {
  /** Scale an authored pixel dimension. */
  (px: number): number;
  /** Scale an interactive surface, never below its authored size. */
  touch: (px: number) => number;
  /** The raw multiplier, for the rare call site that needs it. */
  factor: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function makeScale(fontSize: number): Scale {
  // A missing or nonsensical style.fontSize must not collapse the module.
  const safe = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : BASE_FONT_SIZE;
  const factor = safe / BASE_FONT_SIZE;
  const scale = ((px: number) => round(px * factor)) as Scale;
  // Shrinks with the rest of the module until it hits a fingertip's worth of
  // target, then stops. Anything authored smaller than that floor (a 30px
  // chip) simply never shrinks below its authored size.
  scale.touch = (px: number) => round(
    Math.max(px * factor, Math.min(px, MIN_TOUCH_PX)),
  );
  scale.factor = factor;
  return scale;
}

/** Identity scale. Used as the context default so anything rendered outside
 *  a provider — the config modal's preview pane, which has its own fixed
 *  320px frame — keeps its authored sizes. */
export const UNSCALED = makeScale(BASE_FONT_SIZE);

const ScaleContext = React.createContext<Scale>(UNSCALED);

export function ScaleProvider({ fontSize, children }: {
  fontSize: number; children: React.ReactNode;
}) {
  const scale = React.useMemo(() => makeScale(fontSize), [fontSize]);
  return <ScaleContext.Provider value={scale}>{children}</ScaleContext.Provider>;
}

export function useScale(): Scale {
  return React.useContext(ScaleContext);
}
