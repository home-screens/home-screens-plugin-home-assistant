// Guards the gap this suite exists because of: the plugin shipped 7 locales
// and 19 keys while the detail sheets, empty states, and relative time were
// all hardcoded English. A `tr()` call with no matching key silently renders
// its English fallback on a German display, which is invisible in review.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIGHT_SWATCHES } from './light';

const SRC = join(__dirname);
const TRANSLATIONS = join(__dirname, '..', 'translations');

/** Every `tr('some.key', ...)` in the source, with the file it came from. */
function usedKeys(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of readdirSync(SRC)) {
    if (!/\.tsx?$/.test(file) || file.includes('.test.')) continue;
    const text = readFileSync(join(SRC, file), 'utf8');
    for (const m of text.matchAll(/\btr\(\s*'([a-zA-Z][\w.]*)'/g)) {
      found.set(m[1], file);
    }
  }
  return found;
}

function flatten(value: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (value == null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v != null && typeof v === 'object') {
      for (const nested of flatten(v, `${prefix}${k}.`)) out.add(nested);
    } else {
      out.add(`${prefix}${k}`);
    }
  }
  return out;
}

function locale(file: string): Set<string> {
  return flatten(JSON.parse(readFileSync(join(TRANSLATIONS, file), 'utf8')));
}

const LOCALES = readdirSync(TRANSLATIONS).filter((f) => f.endsWith('.json'));

describe('translation coverage', () => {
  it('ships more than one locale to check', () => {
    expect(LOCALES.length).toBeGreaterThan(1);
    expect(LOCALES).toContain('en-US.json');
  });

  it('has a key for every tr() call in the source', () => {
    const english = locale('en-US.json');
    const missing = [...usedKeys()]
      .filter(([key]) => !english.has(key))
      .map(([key, file]) => `${key} (${file})`);
    expect(missing).toEqual([]);
  });

  it.each(LOCALES)('%s covers exactly the English keys', (file) => {
    const english = [...locale('en-US.json')].sort();
    expect([...locale(file)].sort()).toEqual(english);
  });

  // swatchLabel builds its key from a template literal, which the tr()
  // scan above cannot see, so the swatch list is checked by hand.
  it.each(LOCALES)('%s names every light swatch', (file) => {
    const keys = locale(file);
    const missing = LIGHT_SWATCHES
      .map((sw) => `light.swatch.${sw.key}`)
      .filter((key) => !keys.has(key));
    expect(missing).toEqual([]);
  });

  it.each(LOCALES)('%s keeps every placeholder its English string uses', (file) => {
    const english = JSON.parse(readFileSync(join(TRANSLATIONS, 'en-US.json'), 'utf8'));
    const translated = JSON.parse(readFileSync(join(TRANSLATIONS, file), 'utf8'));
    const read = (obj: unknown, path: string): string => path
      .split('.')
      .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], obj) as string;

    const wrong: string[] = [];
    for (const key of flatten(english)) {
      const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
      const want = placeholders(read(english, key));
      const got = placeholders(read(translated, key));
      // A dropped {count} renders a sentence with a hole in it; a renamed one
      // renders the literal braces on the display.
      if (want !== got) wrong.push(`${key}: expected ${want || '(none)'}, got ${got || '(none)'}`);
    }
    expect(wrong).toEqual([]);
  });
});
