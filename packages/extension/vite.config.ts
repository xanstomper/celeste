import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * Celeste extension build.
 *
 * MV3 needs two different module formats:
 *   - `background.js` is an ES module (the service worker is `"type": "module"`)
 *   - `content.js`, `page-hook.js` and `popup.js` are classic IIFE bundles
 *     (content scripts and the popup cannot be ES modules)
 *
 * Rollup cannot emit two formats from a single multi-entry build, so the
 * build is split into one Vite pass per entry. `scripts/build.mjs` drives the
 * passes; each pass selects its entry through the Vite `mode`.
 */

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * `@celeste/protocol` is a workspace package. It is aliased to the package
 * *source* (not `dist/`) so that the extension can be built before the
 * protocol package has been compiled — the root `pnpm build` builds the
 * extension first.
 */
const PROTOCOL_SRC = path.resolve(rootDir, '../protocol/src/index.ts');

export const INPUTS = {
  background: path.resolve(rootDir, 'src/background.ts'),
  content: path.resolve(rootDir, 'src/content.ts'),
  'page-hook': path.resolve(rootDir, 'src/page-hook.ts'),
  popup: path.resolve(rootDir, 'src/popup/popup.ts'),
} as const;

export type BuildTarget = keyof typeof INPUTS;

const TARGETS = Object.keys(INPUTS) as BuildTarget[];
/** Targets that must be emitted as classic scripts. */
const IIFE_TARGETS: BuildTarget[] = ['content', 'page-hook', 'popup'];

function isTarget(value: string | undefined): value is BuildTarget {
  return value !== undefined && Object.prototype.hasOwnProperty.call(INPUTS, value);
}

export default defineConfig(({ mode }) => {
  const target: BuildTarget = isTarget(mode) ? mode : 'background';
  const isIife = IIFE_TARGETS.includes(target);
  // Only the first pass empties `dist/`; the later passes add to it.
  const isPrimary = target === TARGETS[0];

  return {
    root: rootDir,
    base: './',
    resolve: {
      alias: {
        '@celeste/protocol': PROTOCOL_SRC,
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    build: {
      target: 'chrome116',
      outDir: 'dist',
      emptyOutDir: isPrimary,
      publicDir: isPrimary ? 'public' : false,
      sourcemap: false,
      minify: 'esbuild',
      reportCompressedSize: false,
      rollupOptions: {
        // One entry per pass; see the note above.
        input: { [target]: INPUTS[target] },
        output: {
          ...(isIife ? { name: `__celeste_${target.replace(/-/g, '_')}`, extend: true } : {}),
          format: isIife ? 'iife' : 'es',
          entryFileNames: `${target}.js`,
          inlineDynamicImports: true,
        },
      },
    },
  };
});
