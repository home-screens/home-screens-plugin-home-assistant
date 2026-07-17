// Home Assistant REST API client — every call goes through the host's
// pluginFetch proxy so the token stays server-side and we get caching +
// rate-limiting + SSRF protection. The plugin never touches HA directly.

import type {
  HAStateObject, HAConfig, HAArea,
} from './types';
import { parseStateKey, stringifyAttributeValue } from './shared-state';

export const PLUGIN_ID = 'home-assistant';

const AUTH_HEADER = { Authorization: 'Bearer {{ha_token}}' };

/** Reject a hung proxy call after this long. Neither the host's pluginFetch
 *  nor its server-side proxy carries a timeout, so a never-settling upstream
 *  request would otherwise wedge a polling lane's inflight latch forever
 *  (fast-poll hub, StateProvider, and the widget poll all latch). */
const FETCH_TIMEOUT_MS = 30_000;

function normalizeUrl(haUrl: string): string {
  // Strip trailing slash so joins are predictable.
  return haUrl.replace(/\/+$/, '');
}

function makeUrl(haUrl: string, path: string): string {
  return `${normalizeUrl(haUrl)}${path}`;
}

async function haFetch(
  haUrl: string,
  path: string,
  opts: {
    method?: string;
    payload?: unknown;
    cacheTtlMs?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const { method = 'GET', payload, cacheTtlMs, headers } = opts;
  const sdk = window.__HS_SDK__;
  if (!sdk?.pluginFetch) throw new Error('Home Screens SDK unavailable');
  const mergedHeaders: Record<string, string> = { ...(headers ?? {}) };
  if (payload != null && mergedHeaders['Content-Type'] == null) {
    mergedHeaders['Content-Type'] = 'application/json';
  }
  const fetched = sdk.pluginFetch(PLUGIN_ID, {
    url: makeUrl(haUrl, path),
    method,
    headers: mergedHeaders,
    payload: payload != null ? JSON.stringify(payload) : undefined,
    secretInjections: { header: AUTH_HEADER },
    cacheTtlMs,
  });
  // pluginFetch accepts no AbortSignal, so the underlying request cannot be
  // cancelled; the race just guarantees the caller settles (a late response
  // is discarded, and Promise.race keeps the rejection handled).
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${path}`)),
      FETCH_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([fetched, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface ConnectionResult {
  ok: boolean;
  version?: string;
  locationName?: string;
  unitSystem?: 'metric' | 'imperial';
  entityCount?: number;
  error?: string;
}

export async function testConnection(haUrl: string): Promise<ConnectionResult> {
  if (!haUrl) return { ok: false, error: 'No URL configured' };
  // Reject obviously-wrong URLs before hitting the proxy — saves a round trip
  // and gives the user a clearer hint.
  try {
    const parsed = new URL(haUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'URL must start with http:// or https://' };
    }
  } catch {
    return { ok: false, error: 'URL is not valid. Example: http://homeassistant.local:8123' };
  }

  try {
    const [cfgRes, statesRes] = await Promise.all([
      haFetch(haUrl, '/api/config', { cacheTtlMs: 0 }),
      haFetch(haUrl, '/api/states', { cacheTtlMs: 0 }),
    ]);
    if (!cfgRes.ok) {
      return { ok: false, error: await readErrorMessage(cfgRes) };
    }
    const cfg = (await cfgRes.json()) as HAConfig;
    const states = statesRes.ok ? ((await statesRes.json()) as HAStateObject[]) : [];
    // Detect unit system: HA uses "°C" for metric, "°F" for imperial on /api/config.
    const unit = cfg.unit_system?.temperature === '°F' ? 'imperial' : 'metric';
    return {
      ok: true,
      version: cfg.version,
      locationName: cfg.location_name,
      unitSystem: unit,
      entityCount: states.length,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' };
  }
}

// The proxy returns JSON `{error: "..."}` on rejection — distinguish that
// from HA's own non-200 responses so the user sees a useful message.
async function readErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  // Proxy errors are JSON with an `error` field. HA's errors are usually
  // empty bodies or plain text auth messages.
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.error === 'string') {
      return `Proxy rejected request: ${parsed.error}`;
    }
  } catch { /* not JSON — likely HA */ }

  if (res.status === 401) return 'Invalid access token — regenerate at HA → Profile → Security';
  if (res.status === 403) return 'HA rejected the token (403 Forbidden)';
  if (res.status === 404) return 'HA endpoint not found (404). Is this URL really Home Assistant?';
  return `HA returned HTTP ${res.status}`;
}

export async function fetchStates(
  haUrl: string, refreshMs: number,
): Promise<HAStateObject[]> {
  // Cache window scaled to refresh interval so repeat polls are cheap.
  const ttl = Math.max(5_000, Math.min(refreshMs, 300_000));
  const res = await haFetch(haUrl, '/api/states', { cacheTtlMs: ttl });
  if (!res.ok) throw new Error(`Failed to fetch states: ${res.status}`);
  return (await res.json()) as HAStateObject[];
}

// Registry endpoints are WebSocket-only in HA — use the template API to
// pull area IDs and their entity members. Most entities are attached to an
// area via their *device* rather than directly, so we union area_entities
// with the entity lists of area_devices and de-duplicate. Returns a sorted
// array.
export async function fetchAreas(haUrl: string): Promise<HAArea[]> {
  // Jinja2's `{% set %}` inside a `{% for %}` is block-scoped — a bare
  // `{% set ents = ents + … %}` in the device loop silently discards its
  // mutation. Wrap `ents` in its own namespace so the device-entity union
  // actually survives the inner loop.
  const template = `{% set ns = namespace(areas=[]) %}`
    + `{% for aid in areas() %}`
    + `{% set inner = namespace(ents=area_entities(aid) | list) %}`
    + `{% for d in area_devices(aid) %}`
    + `{% set inner.ents = inner.ents + (device_entities(d) | list) %}`
    + `{% endfor %}`
    + `{% set ns.areas = ns.areas + [{'area_id': aid, 'name': area_name(aid), 'entities': inner.ents | unique | list}] %}`
    + `{% endfor %}`
    + `{{ ns.areas | tojson }}`;
  // The proxy caches GETs only, so a TTL on this POST would be a no-op; 0
  // makes the no-cache reality explicit. Callers that hit this repeatedly
  // memoize the result themselves (display cache in index.tsx, module-scope
  // area cache in search.ts).
  const res = await haFetch(haUrl, '/api/template', {
    method: 'POST',
    payload: { template },
    cacheTtlMs: 0,
  });
  if (!res.ok) throw new Error(`Failed to fetch areas: ${res.status}`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The template endpoint returned a non-JSON body — typically a Jinja
    // error bubbled up as plain text. Surface it so callers can decide
    // whether to log/display rather than silently pretending "no areas".
    throw new Error(
      `Template endpoint returned non-JSON: ${text.slice(0, 120) || '(empty)'}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Template endpoint returned unexpected shape (expected array)');
  }
  return (parsed as HAArea[]).sort((a, b) => a.name.localeCompare(b.name));
}

/** Batched value fetch for the fast-poll lane. Refs are demanded-key strings
 *  — `<entity_id>` for a state, `<entity_id>:<attribute>` for one attribute
 *  — and one template call answers all of them, so request count stays flat
 *  no matter how many refs are tracked. Callers must pre-validate refs with
 *  isPublishableStateKey — its charset (no quotes, no backslash) is what
 *  makes the JSON.stringify embedding Jinja-safe. Attribute refs use
 *  `state_attr` and come back null when the entity or attribute is missing
 *  or non-scalar; state refs always come back as strings (HA answers
 *  'unknown' for nonexistent ids — the provider's known-set gates that).
 *  cacheTtlMs is irrelevant (the proxy only caches GETs) but passed as 0
 *  to make the no-cache intent explicit. */
export async function fetchEntityRefs(
  haUrl: string,
  refs: readonly string[],
): Promise<Array<{ ref: string; value: string | null }>> {
  if (refs.length === 0) return [];
  // Jinja has no `null` literal, so state refs embed an empty attribute
  // string ('' is falsy in Jinja) instead of JSON null.
  const pairs = refs.map((ref) => {
    const { entityId, attribute } = parseStateKey(ref) ?? { entityId: ref, attribute: null };
    return [entityId, attribute ?? ''];
  });
  const template = `{% set ns = namespace(out=[]) %}`
    + `{% for it in ${JSON.stringify(pairs)} %}`
    + `{% set ns.out = ns.out + [{'e': it[0], 'a': it[1], 'v': (state_attr(it[0], it[1]) if it[1] else states(it[0]))}] %}`
    + `{% endfor %}`
    + `{{ ns.out | tojson }}`;
  const res = await haFetch(haUrl, '/api/template', {
    method: 'POST',
    payload: { template },
    cacheTtlMs: 0,
  });
  if (!res.ok) throw new Error(`Failed to fetch entity states: ${res.status}`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Template endpoint returned non-JSON: ${text.slice(0, 120) || '(empty)'}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Template endpoint returned unexpected shape (expected array)');
  }
  return (parsed as Array<{ e: string; a: string; v: unknown }>).map(({ e, a, v }) => ({
    ref: a ? `${e}:${a}` : e,
    // Attribute values go through the same scalar gate as the full poll so
    // the two lanes agree on what is publishable; state refs are strings by
    // construction and pass through untouched.
    value: a ? stringifyAttributeValue(v) : (typeof v === 'string' ? v : null),
  }));
}

/** Call a service. Response includes the changed entity states — callers
 *  should apply these to the display cache for instant UI feedback. */
export async function callService(
  haUrl: string,
  domain: string,
  service: string,
  entityId: string,
  extra: Record<string, unknown> = {},
): Promise<HAStateObject[]> {
  const path = `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`;
  const res = await haFetch(haUrl, path, {
    method: 'POST',
    payload: { entity_id: entityId, ...extra },
    cacheTtlMs: 0,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Service ${domain}.${service} failed: ${res.status} ${txt.slice(0, 120)}`);
  }
  // 200 with array of changed states.
  return (await res.json()) as HAStateObject[];
}

/** Fetch a single camera snapshot as a blob. cacheTtlMs=0 disables proxy
 *  caching so every poll returns a fresh frame — no query-string buster
 *  needed. */
export async function fetchCameraSnapshot(
  haUrl: string, entityId: string,
): Promise<Blob> {
  const path = `/api/camera_proxy/${encodeURIComponent(entityId)}`;
  const res = await haFetch(haUrl, path, { cacheTtlMs: 0 });
  if (!res.ok) throw new Error(`Camera snapshot failed: ${res.status}`);
  return await res.blob();
}
