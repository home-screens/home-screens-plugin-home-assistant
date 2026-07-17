// Plugin-level settings (manifest `settingsSchema` values), read and written
// through the host SDK. The connection is configured ONCE at plugin scope —
// shared by every module instance, the headless StateProvider, and condition
// key search. Modules carry no connection config of their own; their
// ConfigSection edits this store inline (setPluginSettings, editor-only).
//
// `haUrl` is the connection identity throughout the plugin: it keys the
// fast-poll hubs, the display cache entries, and the memo deps. It enters
// module code at one choke point — normalizeConfig — so the settings-sourced
// URL flows to those exact sites; there is no second identity concept.

import { PLUGIN_ID } from './shared-state';

/** Read this plugin's settings from the host. {} on hosts without the SDK
 *  member (tests, previews) — every field read must carry its own default. */
export function getPluginSettings(): Record<string, unknown> {
  const get = window.__HS_SDK__?.getPluginSettings;
  if (typeof get !== 'function') return {};
  try {
    return get(PLUGIN_ID) ?? {};
  } catch {
    return {};
  }
}

/** The plugin-level server address ('' when unset). */
export function settingsHaUrl(): string {
  const value = getPluginSettings().haUrl;
  return typeof value === 'string' ? value.trim() : '';
}

export type SaveSettingsResult = { ok: true } | { ok: false; error: string };

/** Save the plugin-level server address (editor-only; merge semantics on the
 *  host side, so sibling settings like fastUpdates are untouched). The host
 *  pushes the stored values into its settings map before resolving, so
 *  `settingsHaUrl()` reads the new value immediately after `ok`. */
export async function saveSettingsHaUrl(url: string): Promise<SaveSettingsResult> {
  const set = window.__HS_SDK__?.setPluginSettings;
  if (typeof set !== 'function') {
    return { ok: false, error: 'This Home Screens version cannot save plugin settings here.' };
  }
  try {
    const result = await set(PLUGIN_ID, { haUrl: url.trim() });
    if (result?.ok) return { ok: true };
    return { ok: false, error: result?.error || 'Save failed' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Save failed' };
  }
}
