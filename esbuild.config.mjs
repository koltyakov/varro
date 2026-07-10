import pkg from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const { build, context } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const extensionOutfile = resolve(__dirname, 'dist/extension/extension.js');

const verifySelfContainedBundle = {
  name: 'verify-self-contained-extension-bundle',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      const output = await readFile(extensionOutfile, 'utf-8');
      if (/\brequire\(\s*(['"])\.{1,2}\//.test(output)) {
        throw new Error('Extension bundle contains a relative runtime require');
      }
    });
  },
};

const common = {
  entryPoints: [resolve(__dirname, 'src/extension/extension.ts')],
  outfile: extensionOutfile,
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  mainFields: ['module', 'main'],
  platform: 'node',
  plugins: [verifySelfContainedBundle],
  target: 'node22',
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
