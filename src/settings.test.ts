import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPluginSettings, settingsHaUrl, resolveHaUrl } from './settings';

function stubSettings(settings: unknown): void {
  vi.stubGlobal('window', {
    __HS_SDK__: { getPluginSettings: vi.fn().mockReturnValue(settings) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getPluginSettings', () => {
  it('returns {} when the SDK member is missing (tests, previews)', () => {
    vi.stubGlobal('window', { __HS_SDK__: {} });
    expect(getPluginSettings()).toEqual({});
  });

  it('returns {} when the SDK member throws or returns null', () => {
    vi.stubGlobal('window', {
      __HS_SDK__: { getPluginSettings: vi.fn().mockImplementation(() => { throw new Error('boom'); }) },
    });
    expect(getPluginSettings()).toEqual({});

    stubSettings(null);
    expect(getPluginSettings()).toEqual({});
  });
});

describe('settingsHaUrl', () => {
  it('trims the configured value', () => {
    stubSettings({ haUrl: '  http://ha.local:8123  ' });
    expect(settingsHaUrl()).toBe('http://ha.local:8123');
  });

  it('coerces non-string values to empty', () => {
    stubSettings({ haUrl: 42 });
    expect(settingsHaUrl()).toBe('');
    stubSettings({});
    expect(settingsHaUrl()).toBe('');
  });
});

describe('resolveHaUrl', () => {
  it('prefers the per-module value over the plugin setting', () => {
    stubSettings({ haUrl: 'http://plugin.local:8123' });
    expect(resolveHaUrl('http://module.local:8123')).toBe('http://module.local:8123');
  });

  it('falls back to the plugin setting when the module value is empty or whitespace', () => {
    stubSettings({ haUrl: 'http://plugin.local:8123' });
    expect(resolveHaUrl('')).toBe('http://plugin.local:8123');
    expect(resolveHaUrl('   ')).toBe('http://plugin.local:8123');
    expect(resolveHaUrl(undefined)).toBe('http://plugin.local:8123');
  });

  it('coerces a non-string module value to the fallback, and empty when neither is set', () => {
    stubSettings({ haUrl: 'http://plugin.local:8123' });
    expect(resolveHaUrl(42)).toBe('http://plugin.local:8123');
    stubSettings({});
    expect(resolveHaUrl(42)).toBe('');
  });
});
