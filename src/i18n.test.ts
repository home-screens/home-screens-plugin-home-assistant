import { afterEach, describe, expect, it, vi } from 'vitest';
import { tr } from './i18n';

// The suite runs in the node environment, so `window` does not exist unless a
// test stubs it — which is exactly the older-host / test-harness fallback
// path tr() must survive.

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubTranslate(impl: (key: string, vars?: Record<string, string | number>) => string) {
  vi.stubGlobal('window', { __HS_SDK__: { translate: impl } });
}

describe('tr', () => {
  it('returns the English fallback when there is no window (tests, SSR)', () => {
    expect(tr('alerts.gotIt', 'Got it!')).toBe('Got it!');
  });

  it('returns the English fallback when the host has no translate (older host)', () => {
    vi.stubGlobal('window', { __HS_SDK__: {} });
    expect(tr('buttons.done', 'Done!')).toBe('Done!');
  });

  it('uses the host translation when translate resolves the key', () => {
    stubTranslate((key) => (key === 'plugin:home-assistant.alerts.gotIt' ? 'Alles klar!' : key));
    expect(tr('alerts.gotIt', 'Got it!')).toBe('Alles klar!');
  });

  it('falls back when translate misses and returns the raw key', () => {
    stubTranslate((key) => key);
    expect(tr('alerts.gotIt', 'Got it!')).toBe('Got it!');
  });

  it('passes vars through to the host translation', () => {
    stubTranslate((key, vars) =>
      key === 'plugin:home-assistant.alerts.more' ? `und ${vars?.count} weitere` : key,
    );
    expect(tr('alerts.more', 'and {count} more', { count: 3 })).toBe('und 3 weitere');
  });

  it('interpolates vars into the fallback on the no-host path', () => {
    expect(tr('alerts.more', 'and {count} more', { count: 5 })).toBe('and 5 more');
    expect(tr('alerts.more', 'and {count} more {missing}', { count: 5 })).toBe('and 5 more {missing}');
  });
});
