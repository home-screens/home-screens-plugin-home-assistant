// Playwright resolver. This plugin doesn't depend on Playwright itself — the
// harness borrows the copy (and the already-downloaded browsers) from the
// host app checked out beside this repo. A local install wins if there is one.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATES = [
  'playwright',
  path.resolve(here, '../../home-screens/node_modules/playwright'),
];

let loaded = null;
for (const id of CANDIDATES) {
  try {
    loaded = require(id);
    break;
  } catch {
    // try the next candidate
  }
}

if (!loaded) {
  throw new Error(
    'Playwright not found. Install it here (npm i -D playwright) or check out '
    + 'the home-screens host app beside this repo.',
  );
}

export const { chromium } = loaded;
