// Screenshots the real config modal's DISPLAY section, one shot per view.
// This is the audit step for the settings redesign: the built bundle, not the
// mockup, so drift shows up as a picture rather than as a claim.
//
//   npm run build && npm run e2e:setup
//   node e2e/shoot-editor.mjs [view ...]
//
// Writes e2e/.tmp/editor-<view>.png. With no arguments it walks every view.

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { chromium } from './playwright.mjs';

// Read from ALL_VIEWS rather than restating it. A hardcoded list would
// silently skip a newly added view, which is the one thing this audit exists
// to catch. src/view-capabilities.test.ts makes the same guarantee for the
// capability sets. Parsed as text because this is a plain .mjs script with no
// TypeScript loader.
function allViews() {
  const src = readFileSync('src/types.ts', 'utf8');
  const block = src.match(/export const ALL_VIEWS = \[([\s\S]*?)\] as const;/);
  if (!block) throw new Error('could not find ALL_VIEWS in src/types.ts');
  const views = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  if (!views.length) throw new Error('ALL_VIEWS parsed empty');
  return views;
}

const ALL = allViews();
const views = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

const HARNESS = pathToFileURL(path.resolve('e2e/editor-harness.html')).href;
mkdirSync('e2e/.tmp', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1100, height: 900 },
  deviceScaleFactor: 2,
});
page.on('console', (m) => { if (m.type() === 'error') console.log('  console:', m.text()); });
page.on('pageerror', (e) => console.log('  pageerror:', e.message));

for (const view of views) {
  await page.addInitScript((v) => {
    // Seeded from manifest.json's defaults, which is what the host hands a
    // freshly placed module. Without `columns` the slider reads "NaN of 4".
    window.__CONFIG__ = {
      view: v, entities: ['sensor.living_room_temperature'], columns: 2,
      showHeader: true, showControls: true, fastUpdates: true,
    };
  }, view);
  await page.goto(HARNESS);

  // The section renders a sidebar summary; the modal is behind its button.
  const opener = page.locator('button', { hasText: /configure|settings|open/i }).first();
  if (await opener.count()) await opener.click();
  await page.waitForTimeout(400);

  const display = page.locator('section', { hasText: /^Display/ }).first();
  const target = (await display.count()) ? display : page.locator('body');
  await target.screenshot({ path: `e2e/.tmp/editor-${view}.png` });
  const box = await target.boundingBox();
  console.log(`${view.padEnd(13)} ${box ? Math.round(box.height) + 'px' : 'no box'}`);
}

await browser.close();
