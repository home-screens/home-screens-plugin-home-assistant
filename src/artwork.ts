// Validation for HA's `entity_picture` attribute — media artwork, person
// portraits, anything else Home Assistant hands us as an image path.

import type { CSSProperties } from 'react';

//
// HA returns `entity_picture` as a string it controls. Before interpolating
// it into a CSS `background-image` we validate the shape — only http(s) or
// root-relative paths — to keep a hostile/compromised HA from injecting CSS
// payloads or `javascript:` URLs. Root-relative paths (the common case:
// `/api/media-player-image/...` for artwork, `/api/image/serve/...` or
// `/local/...` for person portraits) are resolved against haUrl so the
// browser hits the HA origin, not the Home Screens host app — otherwise the
// host 404s the image and the fallback shows silently. All three of those HA
// endpoints serve unauthenticated (media artwork carries its own signed
// token), so a plain <img>/background-image works without the proxy.
//
// The returned string is guaranteed not to contain any CSS-structural
// character, so callers can safely wrap it in `url("…")`.
export function safeEntityPicture(raw: unknown, haUrl: string): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url) return null;
  // Reject parens/quotes/whitespace (url-token terminators), semicolons
  // (declaration terminators), angle brackets, backslashes, and all ASCII
  // control characters. Anything past this filter is safe to drop into a
  // quoted url("…") value.
  if (/[()"'\s;<>\\]/.test(url)) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(url)) return null;
  if (url.startsWith('/')) {
    if (!haUrl) return null;
    return haUrl.replace(/\/+$/, '') + url;
  }
  return /^https?:\/\//i.test(url) ? url : null;
}

/** Longhand background properties for a validated picture URL. Callers spread
 *  this rather than building the shorthand, so the URL is delivered as an
 *  encoded attribute string rather than spliced into the shorthand parser —
 *  defense in depth against CSS injection. */
export function pictureBackground(
  url: string, opts: { position?: string; size?: string } = {},
): CSSProperties {
  return {
    backgroundImage: `url("${url}")`,
    backgroundPosition: opts.position ?? 'center',
    backgroundSize: opts.size ?? 'cover',
    backgroundRepeat: 'no-repeat',
  };
}
