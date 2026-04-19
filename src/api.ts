// Home Assistant REST API client — every call goes through the host's
// pluginFetch proxy so the token stays server-side and we get caching +
// rate-limiting + SSRF protection. The plugin never touches HA directly.

import type {
  HAStateObject, HAConfig, HAArea,
} from './types';

export const PLUGIN_ID = 'home-assistant';

const AUTH_HEADER = { Authorization: 'Bearer {{ha_token}}' };

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
  return sdk.pluginFetch(PLUGIN_ID, {
    url: makeUrl(haUrl, path),
    method,
    headers: mergedHeaders,
    payload: payload != null ? JSON.stringify(payload) : undefined,
    secretInjections: { header: AUTH_HEADER },
    cacheTtlMs,
  });
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
  const res = await haFetch(haUrl, '/api/template', {
    method: 'POST',
    payload: { template },
    cacheTtlMs: 60_000,
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
