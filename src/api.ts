// Home Assistant REST API client — every call goes through the host's
// pluginFetch proxy so the token stays server-side and we get caching +
// rate-limiting + SSRF protection. The plugin never touches HA directly.

import type {
  HAStateObject, HAConfig, HAArea, HAServicesByDomain,
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
  opts: { method?: string; payload?: unknown; cacheTtlMs?: number } = {},
): Promise<Response> {
  const { method = 'GET', payload, cacheTtlMs } = opts;
  const sdk = window.__HS_SDK__;
  if (!sdk?.pluginFetch) throw new Error('Home Screens SDK unavailable');
  return sdk.pluginFetch(PLUGIN_ID, {
    url: makeUrl(haUrl, path),
    method,
    headers: payload != null ? { 'Content-Type': 'application/json' } : {},
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

export async function fetchState(
  haUrl: string, entityId: string,
): Promise<HAStateObject | null> {
  const res = await haFetch(haUrl, `/api/states/${encodeURIComponent(entityId)}`, { cacheTtlMs: 0 });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch ${entityId}: ${res.status}`);
  return (await res.json()) as HAStateObject;
}

// Registry endpoints are WebSocket-only in HA — use the template API to
// pull area IDs and their entity members. Returns a sorted array.
export async function fetchAreas(haUrl: string): Promise<HAArea[]> {
  const template = `{% set ns = namespace(areas=[]) %}{% for aid in areas() %}{% set ns.areas = ns.areas + [{'area_id': aid, 'name': area_name(aid), 'entities': area_entities(aid) | list}] %}{% endfor %}{{ ns.areas | tojson }}`;
  const res = await haFetch(haUrl, '/api/template', {
    method: 'POST',
    payload: { template },
    cacheTtlMs: 60_000,
  });
  if (!res.ok) throw new Error(`Failed to fetch areas: ${res.status}`);
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as HAArea[];
    return parsed.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function fetchServices(haUrl: string): Promise<HAServicesByDomain[]> {
  const res = await haFetch(haUrl, '/api/services', { cacheTtlMs: 300_000 });
  if (!res.ok) throw new Error(`Failed to fetch services: ${res.status}`);
  return (await res.json()) as HAServicesByDomain[];
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
  const res = await haFetch(haUrl, `/api/services/${domain}/${service}`, {
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

/** Compact history for sparklines. HA recorder keeps ~10 days of short-term
 *  data by default. Returns the raw HA nested-array shape. */
export async function fetchHistory(
  haUrl: string, entityId: string, hours: number,
): Promise<HAStateObject[][]> {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const path = `/api/history/period/${encodeURIComponent(since)}?filter_entity_id=${encodeURIComponent(entityId)}&minimal_response&no_attributes`;
  const res = await haFetch(haUrl, path, { cacheTtlMs: 60_000 });
  if (!res.ok) throw new Error(`Failed to fetch history: ${res.status}`);
  return (await res.json()) as HAStateObject[][];
}

/** Build the proxied camera snapshot URL. Returns a string the <img> can
 *  point at directly — but note that a plain <img src> bypasses our
 *  pluginFetch proxy and won't get the auth header. Use fetchCameraBlob
 *  when you need the actual image bytes. */
export async function fetchCameraSnapshot(
  haUrl: string, entityId: string,
): Promise<Blob> {
  const res = await haFetch(haUrl, `/api/camera_proxy/${encodeURIComponent(entityId)}?time=${Date.now()}`, { cacheTtlMs: 0 });
  if (!res.ok) throw new Error(`Camera snapshot failed: ${res.status}`);
  return await res.blob();
}
