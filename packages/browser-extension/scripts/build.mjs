import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(PKG_ROOT, 'dist');

rmSync(DIST_DIR, { recursive: true, force: true });
mkdirSync(DIST_DIR, { recursive: true });

copyFileSync(join(PKG_ROOT, 'manifest.json'), join(DIST_DIR, 'manifest.json'));
copyFileSync(join(PKG_ROOT, 'sidepanel.html'), join(DIST_DIR, 'sidepanel.html'));

const common = {
  bundle: true,
  target: 'es2022',
  platform: 'browser',
  sourcemap: false,
  legalComments: 'none',
};

await Promise.all([
  build({
    ...common,
    entryPoints: [join(PKG_ROOT, 'src', 'sw.ts')],
    outfile: join(DIST_DIR, 'sw.js'),
    format: 'esm',
  }),
  build({
    ...common,
    entryPoints: [join(PKG_ROOT, 'src', 'sidepanel.ts')],
    outfile: join(DIST_DIR, 'sidepanel.js'),
    format: 'esm',
  }),
  build({
    ...common,
    entryPoints: [join(PKG_ROOT, 'src', 'content.ts')],
    outfile: join(DIST_DIR, 'content.js'),
    format: 'iife',
  }),
  build({
    ...common,
    entryPoints: [join(PKG_ROOT, 'src', 'coordinator.ts')],
    outfile: join(DIST_DIR, 'coordinator.js'),
    format: 'esm',
  }),
]);
