// Plugin-level settings (manifest `settingsSchema` values), read through the
// host SDK. Settings are saved in the host's plugin manager and shared by
// every module instance AND the headless StateProvider — the plugin-wide
// fallback for connection config, so new instances need zero per-module
// setup.
//
// `haUrl` is the connection identity throughout the plugin: it keys the
// fast-poll hubs, the display cache entries, and the memo deps. The fallback
// is applied at the two normalization choke points (normalizeConfig for the
// display component, resolveHaUrl in ConfigSection) so a settings-sourced
// URL flows to those exact sites — never a second identity concept.

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

/** Effective HA URL for a module instance: its own config value wins, the
 *  plugin-level setting fills the gap. */
export function resolveHaUrl(moduleHaUrl: unknown): string {
  const own = typeof moduleHaUrl === 'string' ? moduleHaUrl.trim() : '';
  return own || settingsHaUrl();
}
