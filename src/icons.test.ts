import { describe, expect, it } from 'vitest';
import * as mdi from '@mdi/js';
import { canonicalMdiRef, mdiExportName, ruleIcon } from './icons';

describe('canonicalMdiRef', () => {
  it('accepts the forms people paste and returns the one Home Assistant stores', () => {
    expect(canonicalMdiRef('mdi:fan-off')).toBe('mdi:fan-off');
    expect(canonicalMdiRef(' MDI:Fan-Off ')).toBe('mdi:fan-off');
    expect(canonicalMdiRef('mdi-fan-off')).toBe('mdi:fan-off');
    expect(canonicalMdiRef('fan')).toBe('mdi:fan');
  });

  it('rejects text that is not shaped like an icon name', () => {
    for (const bad of ['', 'mdi:', 'fan off', 'fan--off', '-fan', 'fan_off', 'mdi:fan/off']) {
      expect(canonicalMdiRef(bad)).toBeUndefined();
    }
  });
});

describe('mdiExportName', () => {
  // Names with digits are where a slug and its @mdi/js export are easiest to
  // get wrong; check them against the real package.
  it.each([
    ['mdi:fan-off', 'mdiFanOff'],
    ['mdi:numeric-1-box', 'mdiNumeric1Box'],
    ['mdi:ev-plug-ccs1', 'mdiEvPlugCcs1'],
    ['mdi:video-4k-box', 'mdiVideo4kBox'],
    ['mdi:account-alert-outline', 'mdiAccountAlertOutline'],
  ])('%s → %s, which @mdi/js exports', (ref, name) => {
    expect(mdiExportName(ref)).toBe(name);
    expect(typeof (mdi as Record<string, unknown>)[name]).toBe('string');
  });
});

describe('ruleIcon', () => {
  const path = 'M12 2L2 22h20z';

  it('reads null as "no icon" and anything unusable as "keep the normal one"', () => {
    expect(ruleIcon(null, undefined)).toBeNull();
    expect(ruleIcon(undefined, undefined)).toBeUndefined();
    expect(ruleIcon(42, path)).toBeUndefined();
    expect(ruleIcon('not-an-icon', undefined)).toBeUndefined();
  });

  it('reads a built-in name as the built-in glyph', () => {
    expect(ruleIcon('garage', undefined)).toBe('garage');
    expect(ruleIcon('fan', path)).toBe('fan');
  });

  it('needs the mdi: prefix and a real path for a Home Assistant icon', () => {
    expect(ruleIcon('mdi:fan-off', path)).toEqual({ ref: 'mdi:fan-off', path });
    expect(ruleIcon('fan-off', path)).toBeUndefined();
    expect(ruleIcon('mdi:fan-off', undefined)).toBeUndefined();
    expect(ruleIcon('mdi:fan-off', 'javascript:alert(1)')).toBeUndefined();
    expect(ruleIcon('mdi:fan-off', 'M'.repeat(20_000))).toBeUndefined();
  });

  it('accepts every path @mdi/js actually ships', () => {
    const rejected = Object.entries(mdi as Record<string, string>)
      .filter(([name, p]) => name.startsWith('mdi') && ruleIcon('mdi:x', p) === undefined);
    expect(rejected).toEqual([]);
  });
});
