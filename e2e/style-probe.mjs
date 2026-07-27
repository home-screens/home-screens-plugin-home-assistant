// Checks the host style properties the module is supposed to honour, by
// reading computed style off the real bundle rather than by reading the
// source. Each case states what the host does for a built-in module and
// asserts the plugin does the same.
//
//   npm run build && node e2e/style-probe.mjs

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from './playwright.mjs';

const HARNESS = pathToFileURL(path.resolve('e2e/harness.html')).href;

// The host's DEFAULT_MODULE_STYLE merged with this plugin's manifest
// defaultStyle — what an actual placed module carries.
const HOST_DEFAULTS = {
  fontSize: 14,
  fontFamily: 'inter, system-ui, sans-serif',
  textColor: '#ffffff',
  backgroundColor: 'rgba(0, 0, 0, 0.35)',
  borderRadius: 16,
  padding: 0,
  opacity: 1,
  backdropBlur: 6,
  borderWidth: 1,
  borderColor: 'rgba(255, 255, 255, 0.15)',
  shadowSize: 8,
};

const BASE_CONFIG = {
  view: 'card-grid',
  haUrl: 'http://ha.test:8123',
  entities: ['light.living_room', 'sensor.attic_probe'],
  refreshInterval: 30,
  showHeader: true,
  columns: 2,
  showControls: true,
  compactMode: false,
  fastUpdates: false,
  showHistory: false,
  buttons: [],
  alerts: [{
    id: 'a1', title: 'Front door is open', entityId: 'binary_sensor.front_door',
    icon: 'door', tone: 'red', operator: 'is', value: 'on',
  }],
  lookRules: [],
  autoTones: true,
};

const MOCK_NOW = Date.parse('2026-07-26T10:30:00Z');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 800 } });
await page.addInitScript((now) => {
  const RealDate = Date;
  Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(now); else super(...args); }
    static now() { return now; }
  };
  Date.parse = RealDate.parse;
  Date.UTC = RealDate.UTC;
}, MOCK_NOW);

async function render({ config = {}, style = {}, tz = null }) {
  await page.goto(HARNESS);
  await page.evaluate((z) => { if (z) window.__TZ__ = z; }, tz);
  await page.evaluate(([c, s]) => window.__mount__(c, s, {
    left: 20, top: 20, width: 420, height: 520,
  }), [{ ...BASE_CONFIG, ...config }, { ...HOST_DEFAULTS, ...style }]);
  await page.waitForTimeout(500);
  return page.evaluate(() => {
    const root = document.getElementById('module').firstElementChild;
    const cs = getComputedStyle(root);
    return {
      border: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
      borderColor: cs.borderTopColor,
      boxShadow: cs.boxShadow,
      background: cs.backgroundColor,
      opacity: cs.opacity,
      backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
      text: document.getElementById('module').innerText.replace(/\s+/g, ' ').trim(),
    };
  });
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`);
};

// 1. Border and shadow, which the plugin used to drop entirely.
{
  const r = await render({});
  check('borderWidth/borderColor reach the module',
    r.border === '1px solid' && r.borderColor === 'rgba(255, 255, 255, 0.15)',
    `border=${r.border} ${r.borderColor}`);
  check('shadowSize reaches the module',
    r.boxShadow !== 'none' && r.boxShadow.includes('inset'),
    `boxShadow=${r.boxShadow.slice(0, 70)}…`);
}

// 2. The alerts view is chromeless: it floats over the photo screen, so a
//    border or shadow would draw a box around nothing.
{
  const r = await render({ config: { view: 'alerts' } });
  check('chromeless alerts view skips border and shadow',
    r.border === '0px none' && r.boxShadow === 'none' && r.background === 'rgba(0, 0, 0, 0)',
    `border=${r.border} shadow=${r.boxShadow} bg=${r.background}`);
}

// 3. With blur on, opacity must ride in the background's alpha. Element
//    opacity over an opaque background hides the blur entirely in Chrome —
//    the workaround the host's ModuleWrapper documents.
{
  const r = await render({ style: { backgroundColor: '#101828', opacity: 0.8, backdropBlur: 12 } });
  const alpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(r.background)?.[1];
  check('opacity is baked into the background when blur is on',
    r.opacity === '1' && alpha === '0.8' && r.backdrop.includes('blur'),
    `opacity=${r.opacity} background=${r.background} backdrop=${r.backdrop}`);
}

// 3b. An already-translucent background keeps its own alpha, scaled — the
//     plugin's default is rgba(0,0,0,0.35) and must not jump to opaque.
{
  const r = await render({ style: { backgroundColor: 'rgba(0, 0, 0, 0.4)', opacity: 0.5, backdropBlur: 12 } });
  const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(r.background)?.[1]);
  check('a translucent background keeps its own alpha, scaled',
    Math.abs(alpha - 0.2) < 0.001,
    `background=${r.background} (0.4 × 0.5 = 0.2)`);
}

// 3c. With blur off, opacity stays on the element, as before.
{
  const r = await render({ style: { backgroundColor: '#101828', opacity: 0.6, backdropBlur: 0 } });
  check('with blur off, opacity stays on the element',
    r.opacity === '0.6' && r.background === 'rgb(16, 24, 40)',
    `opacity=${r.opacity} background=${r.background}`);
}

// 4. The host timezone reaches the one place that formats a calendar date:
//    a state older than a week. Two zones a day apart must disagree.
{
  const east = await render({ tz: 'Pacific/Kiritimati' });   // UTC+14
  const west = await render({ tz: 'Pacific/Midway' });       // UTC-11
  // The label renders uppercase via CSS, which innerText reflects.
  const date = (t) => {
    const m = /ATTIC PROBE[\s\S]*?°F\s+([A-Za-z]{3} \d+)/.exec(t);
    if (!m) throw new Error(`stale-entity date not found in: ${t}`);
    return m[1];
  };
  const e = date(east.text), w = date(west.text);
  check('host timezone reaches the stale-entity date',
    e !== w,
    `UTC+14 → ${e}   UTC-11 → ${w}`);
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exitCode = 1;
