import pkg from 'esbuild';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  smokeLoadExtensionBundle,
  verifyExtensionBundleMetafile,
} from './scripts/verify-extension-bundle.mjs';

const { build, context } = pkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const extensionOutfile = resolve(__dirname, 'dist/extension/extension.js');

const verifySelfContainedBundle = {
  name: 'verify-self-contained-extension-bundle',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      verifyExtensionBundleMetafile(result.metafile);
      if (!isWatch) await smokeLoadExtensionBundle(extensionOutfile);
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
  metafile: true,
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
