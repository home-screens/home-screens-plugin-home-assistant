// Secrets client — centralizes access to the host's plugin-secrets admin
// endpoint so callers don't scatter hard-coded URLs and so transport errors
// surface instead of silently collapsing to 'no token configured'.
//
// The host exposes PUT / GET at /api/plugins/secrets/:pluginId. If a future
// SDK ships a typed wrapper (window.__HS_SDK__.getSecretStatus / setSecret),
// this is the single file to rewrite.

import { PLUGIN_ID } from './api';

const ENDPOINT = `/api/plugins/secrets/${encodeURIComponent(PLUGIN_ID)}`;

export type SecretStatusResult =
  | { ok: true; configured: boolean }
  | { ok: false; error: string };

export async function fetchSecretStatus(): Promise<SecretStatusResult> {
  try {
    const res = await fetch(ENDPOINT);
    if (!res.ok) return { ok: false, error: `Secrets endpoint returned HTTP ${res.status}` };
    const data = (await res.json()) as { keys?: Record<string, unknown> };
    return { ok: true, configured: Boolean(data?.keys?.ha_token) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Secrets endpoint unreachable' };
  }
}

export type SaveSecretResult = { ok: true } | { ok: false; error: string };

export async function saveHaToken(value: string): Promise<SaveSecretResult> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'ha_token', value }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Save failed' };
  }
}
