import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPluginSettings, settingsHaUrl, saveSettingsHaUrl } from './settings';

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

describe('saveSettingsHaUrl', () => {
  it('saves the trimmed URL through the SDK writer', async () => {
    const set = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('window', { __HS_SDK__: { setPluginSettings: set } });
    expect(await saveSettingsHaUrl('  http://ha.local:8123  ')).toEqual({ ok: true });
    expect(set).toHaveBeenCalledWith('home-assistant', { haUrl: 'http://ha.local:8123' });
  });

  it('reports a friendly error when the host has no settings writer', async () => {
    vi.stubGlobal('window', { __HS_SDK__: {} });
    const result = await saveSettingsHaUrl('http://ha.local:8123');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot save/i);
  });

  it('surfaces the host error and never rejects', async () => {
    const set = vi.fn().mockResolvedValue({ ok: false, error: 'HTTP 400' });
    vi.stubGlobal('window', { __HS_SDK__: { setPluginSettings: set } });
    expect(await saveSettingsHaUrl('http://ha.local:8123')).toEqual({ ok: false, error: 'HTTP 400' });

    const throwing = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('window', { __HS_SDK__: { setPluginSettings: throwing } });
    expect(await saveSettingsHaUrl('http://ha.local:8123')).toEqual({ ok: false, error: 'boom' });
  });
});
