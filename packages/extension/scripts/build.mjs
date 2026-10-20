/**
 * Build driver for the Celeste extension.
 *
 * Runs one Vite pass per bundle (see `vite.config.ts` for why), copies the
 * static assets from `public/` into `dist/`, and embeds the React client as
 * the browser side panel.
 *
 *   node scripts/build.mjs           # production build
 *   node scripts/build.mjs --watch   # rebuild on change
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '..', '..');
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

/**
 * Copies the built React client into `dist/panel/` so the extension can host
 * it as a side panel. The client's asset names are fixed (see the UI's vite
 * config) so `public/sidepanel.html` can reference them statically.
 */
function copyPanel() {
  const uiDist = path.join(repoRoot, 'packages', 'ui', 'dist');
  if (!existsSync(uiDist)) {
    console.warn('[celeste:extension] UI not built — skipping side panel');
    return;
  }
  const target = path.join(root, 'dist', 'panel');
  mkdirSync(target, { recursive: true });
  cpSync(uiDist, target, { recursive: true });
  console.log('[celeste:extension] side panel client copied → dist/panel/');
}

/**
 * Chrome caches an unpacked extension's service-worker script inside the
 * profile and only refreshes it when the extension's version changes. Without
 * this stamp a rebuilt `background.js` silently keeps running the previous
 * code until the browser is launched into a brand-new profile — which looks
 * exactly like a fix that does not work.
 *
 * The stamp lives in `dist/` only: `public/manifest.json` keeps the real
 * product version.
 */
function stampVersion() {
  const file = path.join(root, 'dist', 'manifest.json');
  if (!existsSync(file)) return;

  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const now = Date.now();
  const day = Math.floor(now / 86_400_000) % 1000;
  const second = Math.floor((now % 86_400_000) / 1000) % 65_535;
  manifest.version = `0.${day}.${second}`;

  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[celeste:extension] manifest version stamped ${manifest.version}`);
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

copyPanel();
stampVersion();

console.log('[celeste:extension] build complete → dist/');
