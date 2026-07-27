// Measures how the rendered module reacts to the host's "Text size" style.
// Mounts the real dist bundle in the harness at two font sizes and reports
// the computed pixel size of every text node, so a module that ignores
// style.fontSize shows up as two identical columns.
//
//   npm run build && npm run e2e:setup      # once, after a clean checkout
//   node e2e/measure.mjs [view] [--sheet] [--shot name]
//
// --locale <tag> renders through that translations/<tag>.json dictionary,
// the way the host registers one; --tz <zone> supplies the host timezone.
// --sheet long-presses the first card to open its detail sheet before
// measuring; --light styles the module for a light wallpaper (dark text on a
// near-white surface), which is the check that nothing is hardcoded white;
// --history turns on the 24-hour charts, which are the only markup that draws
// its own colors and so the part --light most needs to reach; --shot writes
// e2e/.tmp/<name>-<fontSize>.png for each case.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from './playwright.mjs';

const view = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'card-grid';
const shotIdx = process.argv.indexOf('--shot');
const shotName = shotIdx > -1 ? process.argv[shotIdx + 1] : null;

const HARNESS = pathToFileURL(path.resolve('e2e/harness.html')).href;

const localeIdx = process.argv.indexOf('--locale');
const localeTag = localeIdx > -1 ? process.argv[localeIdx + 1] : null;
const pseudo = process.argv.includes('--pseudo');

/** Wrap every English string in guillemets, keeping placeholders intact. A
 *  rendered string with no guillemets never went through tr() — it is either
 *  Home Assistant's own data (entity names, raw states, numbers) or a
 *  hardcoded literal that no locale can reach. This is how the climate
 *  view's "target 70°" turned up after the key audit said everything was
 *  covered: the audit checks keys that exist, not strings that don't. */
function pseudoize(node) {
  if (typeof node === 'string') return `«${node}»`;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = pseudoize(v);
  return out;
}

const EN = JSON.parse(readFileSync(path.resolve('translations/en-US.json'), 'utf8'));
const DICT = pseudo
  ? pseudoize(EN)
  : localeTag
    ? JSON.parse(readFileSync(path.resolve(`translations/${localeTag}.json`), 'utf8'))
    : null;
const tzIdx = process.argv.indexOf('--tz');
const TZ = tzIdx > -1 ? process.argv[tzIdx + 1] : null;

// Each view gets the entities it actually renders — a media view fed only
// lights measures nothing.
const ENTITIES = {
  media: ['media_player.den'],
  climate: ['climate.hallway'],
  'entity-card': ['sensor.outdoor_temp'],
  'entity-row': ['sensor.outdoor_temp'],
  power: ['sensor.house_power'],
  batteries: [],
  default: [
    'light.living_room', 'sensor.outdoor_temp', 'climate.hallway',
    'binary_sensor.front_door', 'lock.front_door', 'cover.garage',
    'fan.office', 'person.jamie',
  ],
};

const CONFIG = {
  view,
  haUrl: 'http://ha.test:8123',
  entities: ENTITIES[view] ?? ENTITIES.default,
  refreshInterval: 30,
  showHeader: true,
  columns: 2,
  showControls: true,
  compactMode: false,
  fastUpdates: false,
  // Off by default so the baseline screenshots stay comparable; --history is
  // what reaches the sparklines, the hero chart's scrim, and the power view's
  // Low/Avg/High row. The power view fetches history regardless.
  showHistory: process.argv.includes('--history'),
  // domain + service are what normalizeButtons requires; a row missing
  // either is dropped and the view renders its empty state instead.
  buttons: [
    { id: 'b1', label: 'Movie Night', icon: 'play', tone: 'purple', domain: 'scene', service: 'turn_on', entityId: 'scene.movie', holdToRun: false },
    { id: 'b2', label: 'Close Garage', icon: 'garage', tone: 'red', domain: 'cover', service: 'close_cover', entityId: 'cover.garage', holdToRun: true },
  ],
  alerts: [
    { id: 'a1', title: 'Front door is open', entityId: 'binary_sensor.front_door', icon: 'door', tone: 'red', operator: 'is', value: 'on' },
  ],
  lookRules: [],
  autoTones: true,
};

// --light styles the module the way a user would for a light wallpaper:
// dark text on a near-white surface. Everything in the module derives from
// these two, so it is the check that nothing is hardcoded white.
const light = process.argv.includes('--light');

const STYLE = (fontSize) => ({
  fontSize,
  fontFamily: 'system-ui, sans-serif',
  textColor: light ? '#111827' : '#ffffff',
  backgroundColor: light ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.35)',
  borderRadius: 16,
  padding: 0,
  opacity: 1,
  backdropBlur: 6,
});

// A 4K screen with the module scaled up proportionally: the same module box
// the user drew on a 1080p canvas, twice as big in every direction.
const CASES = [
  { label: '1080p @ fontSize 14', fontSize: 14, box: { left: 40, top: 40, width: 420, height: 520 } },
  { label: '4K @ fontSize 40', fontSize: 40, box: { left: 40, top: 40, width: 840, height: 1040 } },
];

const openSheet = process.argv.includes('--sheet');

async function measure(page, kase) {
  await page.goto(HARNESS);
  await page.evaluate(([dict, tz]) => {
    if (dict) window.__DICT__ = dict;
    if (tz) window.__TZ__ = tz;
  }, [DICT, TZ]);
  await page.evaluate(
    ([config, style, box]) => window.__mount__(config, style, box),
    [CONFIG, STYLE(kase.fontSize), kase.box],
  );
  await page.waitForTimeout(600);
  if (openSheet) {
    // Long-press the first card to open its detail sheet — the same gesture
    // the kiosk uses (450ms hold), so the sheet under test is the real one.
    // Pressing the label bubbles to the card's own pointer handlers.
    const card = page.getByText('Living Room', { exact: true }).first();
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  return page.evaluate(() => {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        const text = Array.from(child.childNodes)
          .filter((n) => n.nodeType === 3)
          .map((n) => n.textContent.trim())
          .join(' ')
          .trim();
        if (text) {
          const cs = getComputedStyle(child);
          out.push({
            text: text.slice(0, 28),
            px: Math.round(parseFloat(cs.fontSize) * 10) / 10,
            color: cs.color,
          });
        }
        walk(child);
      }
    };
    walk(document.getElementById('module'));
    return out;
  });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 1 });

// Freeze the clock. Cards render "17h ago" off Date.now(), so without this a
// baseline captured before an hour rolls over and one captured after it
// differ by a glyph, and a pixel diff blames whatever change is in flight.
// MOCK_NOW is 30 minutes after the canned states' last_changed.
const MOCK_NOW = Date.parse('2026-07-26T10:30:00Z');
await page.addInitScript((now) => {
  const RealDate = Date;
  // eslint-disable-next-line no-global-assign
  Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  };
  Date.parse = RealDate.parse;
  Date.UTC = RealDate.UTC;
}, MOCK_NOW);
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console error]', m.text()); });
page.on('pageerror', (e) => console.log('  [page error]', e.message));

const results = [];
for (const kase of CASES) {
  results.push({ kase, rows: await measure(page, kase) });
  if (shotName) {
    await page.screenshot({ path: `e2e/.tmp/${shotName}-${kase.fontSize}.png` });
  }
}

const [a, b] = results;
console.log(`\nview: ${view}`);
console.log(`${'text'.padEnd(30)} ${a.kase.label.padEnd(22)} ${b.kase.label}`);
console.log('-'.repeat(80));
const n = Math.max(a.rows.length, b.rows.length);
let scaled = 0, fixed = 0;
for (let i = 0; i < n; i++) {
  const ra = a.rows[i], rb = b.rows[i];
  if (!ra || !rb) { console.log(`${(ra?.text ?? rb?.text ?? '?').padEnd(30)} ${String(ra?.px ?? '-').padEnd(22)} ${rb?.px ?? '-'}  (mismatched tree)`); continue; }
  const same = ra.px === rb.px;
  if (same) fixed++; else scaled++;
  console.log(`${ra.text.padEnd(30)} ${String(ra.px).padEnd(22)} ${rb.px}   ${same ? 'FIXED' : `x${(rb.px / ra.px).toFixed(2)}`}`);
}
console.log('-'.repeat(80));
console.log(`scaled: ${scaled}   ignored style.fontSize: ${fixed}`);

// A module that honours the host's Text color paints its neutral text in
// that color at some alpha. Anything else is either a semantic accent
// (amber "on", red alert) or a hardcoded literal — the report separates
// them by listing what it found, since only a person can tell them apart.
const [tr_, tg, tb] = STYLE(14).textColor.match(/\w\w/g).map((h) => parseInt(h, 16));
const derived = new RegExp(`^rgba?\\(${tr_}, ?${tg}, ?${tb}\\b`);
const offPalette = [...new Set(a.rows.map((r) => r.color).filter((c) => !derived.test(c)))];
console.log(`text in the host's Text color: ${a.rows.filter((r) => derived.test(r.color)).length}/${a.rows.length}`);
if (offPalette.length) console.log(`other colors used: ${offPalette.join('  ')}`);
if (pseudo) {
  const unmarked = a.rows.map((r) => r.text).filter((t) => !t.includes('«'));
  console.log(`strings that never reached tr(): ${unmarked.length ? unmarked.join(' | ') : 'none'}`);
}
console.log('');

await browser.close();
