import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const entryPoint = fileURLToPath(import.meta.resolve('oxlint-plugin-anti-slop'));
const packageRoot = dirname(dirname(entryPoint));

await build({
  entryPoints: [entryPoint],
  outfile: resolve(packageRoot, 'dist/index.mjs'),
  bundle: true,
  external: ['@oxlint/plugins'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
});
