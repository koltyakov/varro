// @ts-check
import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyExtensionBundleMetafile } from './verify-extension-bundle.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {import('esbuild').BuildOptions} */
export function thumbnailWorkerBuildOptions(outputDirectory, watch = false) {
  const wasm = require.resolve('@imagemagick/magick-wasm/magick.wasm');
  const packageRoot = resolve(dirname(wasm), '../..');
  return {
    entryPoints: [join(root, 'src/extension/image-thumbnail-worker.ts')],
    outfile: join(outputDirectory, 'thumbnail-worker.js'),
    bundle: true,
    format: 'cjs',
    mainFields: ['module', 'main'],
    platform: 'node',
    target: 'node22',
    metafile: true,
    minify: !watch,
    sourcemap: watch,
    plugins: [
      {
        name: 'thumbnail-assets',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) return;
            if (!result.metafile)
              throw new Error('Thumbnail worker build did not produce a metafile');
            verifyExtensionBundleMetafile(result.metafile);
            await mkdir(outputDirectory, { recursive: true });
            await Promise.all([
              copyFile(wasm, join(outputDirectory, 'thumbnail-codec.wasm')),
              copyFile(
                join(packageRoot, 'LICENSE'),
                join(outputDirectory, 'thumbnail-LICENSE.txt')
              ),
              copyFile(join(packageRoot, 'NOTICE'), join(outputDirectory, 'thumbnail-NOTICE.txt')),
            ]);
          });
        },
      },
    ],
  };
}
