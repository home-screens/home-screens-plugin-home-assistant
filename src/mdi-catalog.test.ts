import { describe, expect, it } from 'vitest';
import { lookupMdiIcon } from './mdi-catalog';

const catalog = { mdiFan: 'M1 1z', mdiFanOff: 'M2 2z', mdiNumeric1Box: 'M3 3z' };

describe('lookupMdiIcon', () => {
  it('finds typed names in any pasted form, returning the canonical ref', () => {
    expect(lookupMdiIcon(catalog, 'fan-off')).toEqual({ ref: 'mdi:fan-off', path: 'M2 2z' });
    expect(lookupMdiIcon(catalog, 'MDI:Fan-Off')).toEqual({ ref: 'mdi:fan-off', path: 'M2 2z' });
    expect(lookupMdiIcon(catalog, 'mdi-numeric-1-box')).toEqual({ ref: 'mdi:numeric-1-box', path: 'M3 3z' });
  });

  it('reads a name the built-in set also has as the Home Assistant icon', () => {
    expect(lookupMdiIcon(catalog, 'fan')).toEqual({ ref: 'mdi:fan', path: 'M1 1z' });
  });

  it('misses cleanly, including on names inherited from Object', () => {
    expect(lookupMdiIcon(catalog, 'fan-of')).toBeUndefined();
    expect(lookupMdiIcon(catalog, 'constructor')).toBeUndefined();
    expect(lookupMdiIcon(catalog, 'to-string')).toBeUndefined();
    expect(lookupMdiIcon(catalog, '')).toBeUndefined();
  });
});
