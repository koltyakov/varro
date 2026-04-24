import pkg from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const { build, context } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');

const common = {
  entryPoints: [resolve(__dirname, 'src/extension/extension.ts')],
  bundle: true,
  outfile: resolve(__dirname, 'dist/extension/extension.js'),
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: isWatch,
  minify: !isWatch,
};

if (isWatch) {
  const ctx = await context({
    ...common,
    logLevel: 'info',
  });
  await ctx.watch();
  // oxlint-disable-next-line no-console
  console.log('[esbuild] watching extension...');
} else {
  await build(common);
  // oxlint-disable-next-line no-console
  console.log('[esbuild] built extension');
}
