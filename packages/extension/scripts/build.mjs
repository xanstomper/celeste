/**
 * Build driver for the Celeste extension.
 *
 * Runs one Vite pass per bundle (see `vite.config.ts` for why) and makes sure
 * the static assets from `public/` land in `dist/`.
 *
 *   node scripts/build.mjs           # production build
 *   node scripts/build.mjs --watch   # rebuild on change
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(root, 'vite.config.ts');

const TARGETS = ['background', 'content', 'page-hook', 'popup'];
const watch = process.argv.includes('--watch');

/** Regenerate the PNG icons when they are missing. */
async function ensureIcons() {
  const icon = path.join(root, 'public', 'icons', 'icon128.png');
  if (existsSync(icon)) return;
  console.log('[celeste:extension] icons missing — generating…');
  const { generateIcons } = await import('./gen-icons.mjs');
  generateIcons(path.join(root, 'public', 'icons'));
}

await ensureIcons();

for (const mode of TARGETS) {
  console.log(`[celeste:extension] building ${mode}…`);
  await build({
    root,
    mode,
    configFile,
    logLevel: 'warn',
    ...(watch ? { build: { watch: {} } } : {}),
  });
}

console.log('[celeste:extension] build complete → dist/');
