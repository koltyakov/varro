import pkg from 'esbuild';
import { copyFileSync, readFileSync, rmSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  smokeLoadExtensionBundle,
  smokeThumbnailWorker,
  verifyExtensionBundleMetafile,
} from './scripts/verify-extension-bundle.mjs';
import { thumbnailWorkerBuildOptions } from './scripts/build-thumbnail-worker.mjs';
import { buildNotificationSound } from './scripts/build-notification-sound.mjs';
import { verifyMacOSNotifierAsset } from './scripts/build-macos-notifier.mjs';

const { build, context } = pkg;
const projectRoot = dirname(fileURLToPath(import.meta.url));
const isWatch = process.argv.includes('--watch');
const extensionOutfile = resolve(projectRoot, 'dist/extension/extension.js');
const { version } = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));

rmSync(dirname(extensionOutfile), { force: true, recursive: true });

const verifySelfContainedBundle = {
  name: 'verify-self-contained-extension-bundle',
  setup(buildContext) {
    buildContext.onEnd(async (result) => {
      if (result.errors.length > 0) return;
      buildNotificationSound(dirname(extensionOutfile));
      await verifyMacOSNotifierAsset();
      for (const extension of ['zip', 'json']) {
        copyFileSync(
          resolve(projectRoot, `assets/notifications/varro-notifier.${extension}`),
          resolve(dirname(extensionOutfile), `macos-notifier.${extension}`)
        );
      }
      verifyExtensionBundleMetafile(result.metafile);
      if (!isWatch) await smokeLoadExtensionBundle(extensionOutfile);
    });
  },
};

const common = {
  entryPoints: [resolve(projectRoot, 'src/extension/extension.ts')],
  outfile: extensionOutfile,
  bundle: true,
  define: { __VARRO_VERSION__: JSON.stringify(version) },
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
  const thumbnailContext = await context(
    thumbnailWorkerBuildOptions(dirname(extensionOutfile), true)
  );
  await thumbnailContext.watch();
  const ctx = await context({
    ...common,
    logLevel: 'info',
  });
  await ctx.watch();
  // oxlint-disable-next-line no-console
  console.log('[esbuild] watching extension...');
} else {
  await build(thumbnailWorkerBuildOptions(dirname(extensionOutfile)));
  await smokeThumbnailWorker(dirname(extensionOutfile));
  await build(common);
  // oxlint-disable-next-line no-console
  console.log('[esbuild] built extension');
}
