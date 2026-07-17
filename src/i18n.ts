// Kiosk-string translation helper over the host SDK's translate().
//
// The host registers ONE dictionary per session under the namespace
// `plugin:home-assistant` (the first tag in the active locale's fallback
// chain that the manifest `translations` map covers) and returns the RAW KEY
// on any miss. So every call site passes its English string as the fallback:
// it covers hosts older than plugin i18n, tests (no window), and a key
// missing from a partial dictionary, without ever flashing a dotted key on
// the family display.

const NAMESPACE = 'plugin:home-assistant';

export function tr(
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
): string {
  const full = `${NAMESPACE}.${key}`;
  const translate = typeof window !== 'undefined' ? window.__HS_SDK__?.translate : undefined;
  if (translate) {
    const out = translate(full, vars);
    if (out !== full) return out;
  }
  return vars ? interpolate(fallback, vars) : fallback;
}

/** Same `{name}` substitution the host applies, for the fallback path. */
function interpolate(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
