// Pixel-diffs two screenshots. Used to prove that a sizing change leaves the
// default Text size (14) rendering untouched:
//
//   node e2e/imgdiff.mjs e2e/.tmp/ref-card-grid-14.png e2e/.tmp/new-card-grid-14.png
//
// Prints the differing-pixel count and the bounding box of the changes, and
// exits 1 when the two images differ — so a sweep over several views can be
// driven straight from the exit code.

import fs from 'node:fs';
import { chromium } from './playwright.mjs';

/** Ignore the last bit of antialiasing noise; anything a person could see is
 *  well above this. */
const CHANNEL_TOLERANCE = 2;

const [a, b, ...rest] = process.argv.slice(2);

function fail(message) {
  console.error(`imgdiff: ${message}`);
  console.error('usage: node e2e/imgdiff.mjs <before.png> <after.png>');
  process.exit(2);
}

if (!a || !b || rest.length > 0) fail('expected exactly two image paths');
for (const p of [a, b]) {
  if (!fs.existsSync(p)) fail(`no such file: ${p}`);
}

const toDataUrl = (p) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const res = await page.evaluate(async ([aUrl, bUrl, tolerance]) => {
    const load = (src) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not decode image'));
      img.src = src;
    });
    const [ia, ib] = await Promise.all([load(aUrl), load(bUrl)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return {
        sizeMismatch: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}`,
      };
    }

    const canvas = document.createElement('canvas');
    canvas.width = ia.width;
    canvas.height = ia.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(ia, 0, 0);
    const da = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(ib, 0, 0);
    const db = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

    let differing = 0, maxDelta = 0;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
    for (let i = 0; i < da.length; i += 4) {
      const delta = Math.max(
        Math.abs(da[i] - db[i]),
        Math.abs(da[i + 1] - db[i + 1]),
        Math.abs(da[i + 2] - db[i + 2]),
      );
      if (delta <= tolerance) continue;
      differing++;
      if (delta > maxDelta) maxDelta = delta;
      const pixel = i / 4;
      const x = pixel % canvas.width;
      const y = Math.floor(pixel / canvas.width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return {
      differing,
      total: canvas.width * canvas.height,
      maxDelta,
      box: maxX < 0 ? null : { minX, minY, maxX, maxY },
    };
  }, [toDataUrl(a), toDataUrl(b), CHANNEL_TOLERANCE]);

  if (res.sizeMismatch) {
    console.log(`DIFFERENT SIZE  ${res.sizeMismatch}`);
    process.exitCode = 1;
  } else if (res.differing === 0) {
    console.log(`identical  (${res.total} pixels)`);
  } else {
    const { minX, minY, maxX, maxY } = res.box;
    console.log(
      `${res.differing} of ${res.total} pixels differ`
      + `  maxDelta=${res.maxDelta}`
      + `  box=(${minX},${minY})-(${maxX},${maxY})`,
    );
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
