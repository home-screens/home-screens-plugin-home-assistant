// Module-wide color. The companion to scale.tsx: that one carries the host's
// Text size into the display tree, this one carries its Text color.
//
// Why this exists: the host hands the module `style.textColor` and expects
// the module to use it. Every neutral in this plugin used to be a literal
// `rgba(255, 255, 255, α)`, so a user who set a dark text color for a light
// background got a module of white text on white — unreadable, with no way
// to fix it from the style panel.
//
// Two primitives cover almost everything:
//
//   fg(α)     the host's text color at an alpha. Body text, dim labels,
//             hairline borders, and the faint washes cards are built from
//             are all this. At the default #ffffff it reproduces the old
//             literals exactly, which is why the shipped look is unchanged.
//   shade(α)  the surface side — black behind light text, white behind dark
//             text. Legibility scrims over charts and artwork.
//
// What is NOT derived: the semantic hues. Amber means "on", red means
// "attention", green means "went through". Those survive a theme change, so
// they are palettes rather than functions — one set tuned for light text on
// a dark surface (the shipped look), one for dark text on a light surface.

import React from 'react';
import type { HAButtonTone } from './types';

// ── Color parsing ───────────────────────────────────────────────────────────

/** Parse `#rgb`, `#rrggbb`, `rgb()`, or `rgba()` into an [r, g, b] triple.
 *  Returns null for anything else (named colors, `color-mix()`, gibberish
 *  from a hand-edited config) so callers can fall back rather than render a
 *  broken color string. */
export function parseColor(input: string): [number, number, number] | null {
  const value = input.trim();

  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(value);
  if (short) {
    return [
      parseInt(short[1] + short[1], 16),
      parseInt(short[2] + short[2], 16),
      parseInt(short[3] + short[3], 16),
    ];
  }

  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  }

  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(value);
  if (fn) {
    const rgb: [number, number, number] = [
      Math.round(Number(fn[1])), Math.round(Number(fn[2])), Math.round(Number(fn[3])),
    ];
    if (rgb.every((c) => Number.isFinite(c) && c >= 0 && c <= 255)) return rgb;
  }

  return null;
}

/** One DOM probe per distinct string. The host re-renders the module on every
 *  state tick and the answer never changes. */
const resolved = new Map<string, string | null>();

/** The same color in a form `parseColor` can read, or null if it isn't a
 *  color at all.
 *
 *  The host's color picker accepts anything the browser calls valid and
 *  stores the string verbatim, so `black`, `hsl(0 0% 10%)`, `#000000cc`, and
 *  `rgb(0 0 0 / 50%)` all reach us. Guessing white for those is the exact
 *  white-on-white failure this file exists to prevent, so anything the
 *  regexes above can't read goes to the browser, which is the only thing that
 *  knows what `rebeccapurple` is. Outside a DOM (unit tests) there is no
 *  browser to ask and the caller falls back as before. */
export function resolveColor(input: string): string | null {
  if (parseColor(input)) return input;

  const cached = resolved.get(input);
  if (cached !== undefined) return cached;

  let out: string | null = null;
  if (typeof document !== 'undefined' && document.body) {
    const probe = document.createElement('div');
    probe.style.color = input;
    // An invalid value leaves the property untouched; without this check the
    // computed style below would hand back the inherited color and turn
    // gibberish into whatever the page happens to be using.
    if (probe.style.color !== '') {
      // A detached element has no computed style, so the probe has to be in
      // the document. `display: none` keeps it out of layout.
      probe.style.display = 'none';
      document.body.appendChild(probe);
      try {
        const computed = getComputedStyle(probe).color;
        out = parseColor(computed) ? computed : null;
      } finally {
        probe.remove();
      }
    }
  }
  resolved.set(input, out);
  return out;
}

/** Perceived brightness, 0–1 (Rec. 601 luma — cheap and good enough to answer
 *  "is this light or dark?"). */
export function luminance(rgb: [number, number, number]): number {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

// ── Palettes ────────────────────────────────────────────────────────────────

/** One semantic hue in three weights:
 *
 *  base  the vivid form — icons, status dots, chart strokes, hairlines.
 *  text  the quiet form, for a label sitting on a surface tinted with this
 *        same hue (where the tint already carries the meaning).
 *  loud  the form for a label that has to carry the meaning on its own, on
 *        the plain module surface: "3 need charging", an active mode pill.
 */
export interface Accent {
  base: string;
  text: string;
  loud: string;
}

export type AccentName =
  | 'amber' | 'orange' | 'red' | 'green' | 'blue' | 'purple' | 'sky';

/** Surface treatment for a card or tile carrying a tone. */
export interface ToneSurface {
  background: string;
  borderColor: string;
  color: string;
}

export type CardToneName = 'default' | 'on' | 'active' | 'alert';

export interface Theme {
  /** True when the module paints light text on a dark surface — the shipped
   *  look, and what every hue below is tuned for by default. */
  dark: boolean;
  /** The host's text color at an alpha. */
  fg: (alpha?: number) => string;
  /** The surface side, opposite the text. Scrims and washes. */
  shade: (alpha: number) => string;
  accent: Record<AccentName, Accent>;
  /** Success and failure, which are states rather than palette choices. */
  ok: string;
  danger: string;
  /** Domain-tone card surfaces (light on, climate active, sensor alert). */
  cardTone: Record<CardToneName, ToneSurface>;
  /** Look-rule tone surfaces, the same palette in card language. */
  ruleTone: Record<Exclude<HAButtonTone, 'default'>, ToneSurface>;
  /** Button tile colors. */
  buttonTone: Record<HAButtonTone, { accent: string; chipBg: string; holdText: string }>;
  /** Alert tile colors — buttons' palette plus a tinted title. */
  alertTone: Record<HAButtonTone, { accent: string; chipBg: string; title: string }>;
  /** The detail sheet paints its own surface over the module, so it needs
   *  its own background rather than a wash of the module's. */
  sheet: { backdrop: string; panel: string; border: string; shadow: string };
  /** Alert tiles float over the photo screen with no module surface behind
   *  them, so they carry their own scrim — dark under light text, light
   *  under dark text, legible over any wallpaper either way. */
  alertTile: { surface: string; acked: string; border: string; ackedBorder: string; shadow: string };
}

// Light text on a dark surface. Every value here is the literal this plugin
// shipped with, so the default module is unchanged to the pixel.
const DARK_ACCENTS: Record<AccentName, Accent> = {
  amber: { base: '#fbbf24', text: '#fde68a', loud: '#fcd34d' },
  orange: { base: '#fb923c', text: '#fed7aa', loud: '#fdba74' },
  red: { base: '#f87171', text: '#fecaca', loud: '#fca5a5' },
  green: { base: '#4ade80', text: '#bbf7d0', loud: '#86efac' },
  blue: { base: '#60a5fa', text: '#bfdbfe', loud: '#93c5fd' },
  purple: { base: '#c084fc', text: '#e9d5ff', loud: '#d8b4fe' },
  sky: { base: '#38bdf8', text: '#bae6fd', loud: '#7dd3fc' },
};

// Dark text on a light surface. The vivid forms drop two Tailwind steps so
// they hold up as icons and hairlines on white; the text forms drop far
// enough to read as body copy.
const LIGHT_ACCENTS: Record<AccentName, Accent> = {
  amber: { base: '#d97706', text: '#92400e', loud: '#b45309' },
  orange: { base: '#ea580c', text: '#9a3412', loud: '#c2410c' },
  red: { base: '#dc2626', text: '#991b1b', loud: '#b91c1c' },
  green: { base: '#16a34a', text: '#166534', loud: '#15803d' },
  blue: { base: '#2563eb', text: '#1e40af', loud: '#1d4ed8' },
  purple: { base: '#9333ea', text: '#6b21a8', loud: '#7e22ce' },
  sky: { base: '#0284c7', text: '#075985', loud: '#0369a1' },
};

/** A palette color at an alpha. Exported because a few effects (the lock
 *  card's hold sweep, the buttons view's) need to tint an accent themselves
 *  rather than pick a prepared surface. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = parseColor(color);
  if (!rgb) return color;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
}

const rgbaOf = withAlpha;

export function makeTheme(textColor: string): Theme {
  // White is the last resort, for a value even the browser rejects. Anything
  // it can read — including the named colors and modern syntaxes the host's
  // picker accepts — is resolved first, so a dark Text color always produces
  // the dark-on-light palette rather than white text on a pale module.
  const resolvedText = resolveColor(textColor);
  const rgb = (resolvedText !== null ? parseColor(resolvedText) : null) ?? [255, 255, 255];
  const dark = luminance(rgb) >= 0.5;
  const accent = dark ? DARK_ACCENTS : LIGHT_ACCENTS;
  const ok = dark ? '#22c55e' : '#15803d';
  const danger = dark ? '#ef4444' : '#b91c1c';

  const fg = (alpha = 1): string => (
    alpha >= 1
      ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
      : `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
  );
  const shade = (alpha: number): string => (
    dark ? `rgba(0, 0, 0, ${alpha})` : `rgba(255, 255, 255, ${alpha})`
  );

  /** A tinted card surface: the hue washed over the module, a hairline of
   *  the same hue, and text in the hue's readable form.
   *
   *  `wash` is the color that carries the tint, which is not always the
   *  accent's own base — the alert surfaces use the vivid danger red while
   *  their text uses the softer red. `tail` is the gradient's far stop:
   *  most tones fade into their own hue, amber fades into the text color. */
  const surface = (opts: {
    wash: string; fill: number; border: number;
    tail: 'hue' | 'fg'; tailAlpha: number; color: string;
  }): ToneSurface => ({
    background: 'linear-gradient(135deg, '
      + `${rgbaOf(opts.wash, opts.fill)}, `
      + `${opts.tail === 'hue' ? rgbaOf(opts.wash, opts.tailAlpha) : fg(opts.tailAlpha)})`,
    borderColor: rgbaOf(opts.wash, opts.border),
    color: opts.color,
  });

  const amberSurface = (): ToneSurface => surface({
    wash: accent.amber.base, fill: 0.12, border: 0.22,
    tail: 'fg', tailAlpha: 0.03,
    color: dark ? '#fef3c7' : accent.amber.text,
  });
  const alertSurface = (): ToneSurface => surface({
    wash: danger, fill: 0.12, border: 0.26,
    tail: 'hue', tailAlpha: 0.02, color: accent.red.text,
  });

  return {
    dark,
    fg,
    shade,
    accent,
    ok,
    danger,

    cardTone: {
      default: {
        background: fg(0.04),
        borderColor: fg(0.08),
        color: fg(0.75),
      },
      // Amber for "on" deliberately matches the look-rule amber, so a
      // rule-tinted card and a domain-tinted card sit together.
      on: amberSurface(),
      active: surface({
        wash: accent.orange.base, fill: 0.14, border: 0.28,
        tail: 'hue', tailAlpha: 0.04, color: accent.orange.text,
      }),
      alert: alertSurface(),
    },

    ruleTone: {
      amber: amberSurface(),
      red: alertSurface(),
      blue: surface({
        wash: accent.blue.base, fill: 0.13, border: 0.28,
        tail: 'hue', tailAlpha: 0.02, color: accent.blue.text,
      }),
      green: surface({
        wash: accent.green.base, fill: 0.12, border: 0.26,
        tail: 'hue', tailAlpha: 0.02, color: accent.green.text,
      }),
      purple: surface({
        wash: accent.purple.base, fill: 0.13, border: 0.28,
        tail: 'hue', tailAlpha: 0.02, color: accent.purple.text,
      }),
    },

    buttonTone: {
      default: { accent: fg(0.8), chipBg: fg(0.06), holdText: fg(1) },
      amber: { accent: accent.amber.base, chipBg: rgbaOf(accent.amber.base, 0.14), holdText: accent.amber.text },
      blue: { accent: accent.blue.base, chipBg: rgbaOf(accent.blue.base, 0.14), holdText: accent.blue.text },
      green: { accent: accent.green.base, chipBg: rgbaOf(accent.green.base, 0.14), holdText: accent.green.text },
      purple: { accent: accent.purple.base, chipBg: rgbaOf(accent.purple.base, 0.14), holdText: accent.purple.text },
      red: { accent: accent.red.base, chipBg: rgbaOf(accent.red.base, 0.14), holdText: accent.red.loud },
    },

    sheet: dark ? {
      backdrop: 'rgba(8,11,20,0.72)',
      panel: 'linear-gradient(180deg, rgba(30,36,54,0.96), rgba(21,26,40,0.98))',
      border: '1px solid rgba(255,255,255,0.1)',
      shadow: '0 24px 60px rgba(0,0,0,0.5)',
    } : {
      backdrop: 'rgba(241,245,249,0.78)',
      panel: 'linear-gradient(180deg, rgba(255,255,255,0.98), rgba(241,245,249,0.99))',
      border: '1px solid rgba(15,23,42,0.12)',
      shadow: '0 24px 60px rgba(15,23,42,0.22)',
    },

    alertTile: dark ? {
      surface: 'rgba(13, 18, 32, 0.72)',
      acked: 'rgba(20, 35, 26, 0.8)',
      border: 'rgba(255,255,255,0.1)',
      ackedBorder: withAlpha(accent.green.base, 0.35),
      shadow: '0 10px 30px rgba(0,0,0,0.35)',
    } : {
      surface: 'rgba(255, 255, 255, 0.86)',
      acked: 'rgba(236, 253, 240, 0.9)',
      border: 'rgba(15,23,42,0.12)',
      ackedBorder: withAlpha(accent.green.base, 0.4),
      shadow: '0 10px 30px rgba(15,23,42,0.18)',
    },

    alertTone: {
      default: { accent: fg(0.6), chipBg: fg(0.08), title: fg(1) },
      amber: { accent: accent.amber.base, chipBg: rgbaOf(accent.amber.base, 0.16), title: accent.amber.text },
      blue: { accent: accent.blue.base, chipBg: rgbaOf(accent.blue.base, 0.16), title: accent.blue.text },
      green: { accent: accent.green.base, chipBg: rgbaOf(accent.green.base, 0.16), title: accent.green.text },
      purple: { accent: accent.purple.base, chipBg: rgbaOf(accent.purple.base, 0.16), title: accent.purple.text },
      red: { accent: accent.red.base, chipBg: rgbaOf(accent.red.base, 0.16), title: accent.red.text },
    },
  };
}

/** The shipped look: white text on a dark surface. Used as the context
 *  default so anything rendered outside a provider — the config modal's
 *  preview pane, which paints its own dark frame — keeps it. */
export const DEFAULT_THEME = makeTheme('#ffffff');

const ThemeContext = React.createContext<Theme>(DEFAULT_THEME);

export function ThemeProvider({ textColor, children }: {
  textColor: string; children: React.ReactNode;
}) {
  const theme = React.useMemo(() => makeTheme(textColor), [textColor]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return React.useContext(ThemeContext);
}
