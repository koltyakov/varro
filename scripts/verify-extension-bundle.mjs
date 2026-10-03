// @ts-check
import { readFile } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

export function verifyExtensionBundleMetafile(metafile) {
  if (!metafile?.outputs || Object.keys(metafile.outputs).length === 0) {
    throw new Error('Extension build did not produce metafile output data');
  }

  const rejected = [];
  for (const [outputPath, output] of Object.entries(metafile.outputs)) {
    for (const imported of output.imports || []) {
      if (!imported.external) {
        rejected.push(`${outputPath}: ${imported.kind} ${imported.path} (separate output)`);
        continue;
      }
      if (imported.path !== 'vscode' && !isBuiltin(imported.path)) {
        const reason =
          imported.kind === 'dynamic-import' ? 'unresolved dynamic import' : 'external';
        rejected.push(`${outputPath}: ${imported.kind} ${imported.path} (${reason})`);
      }
    }
  }

  if (rejected.length > 0) {
    throw new Error(`Extension bundle is not self-contained:\n${rejected.join('\n')}`);
  }
}

export async function smokeLoadExtensionBundle(bundlePath) {
  const source = await readFile(bundlePath, 'utf-8');
  const module = { exports: {} };
  const require = createRequire(bundlePath);
  const vscode = {
    window: {
      createOutputChannel: () => ({
        appendLine() {},
        dispose() {},
        show() {},
      }),
    },
  };
  const load = (specifier) => (specifier === 'vscode' ? vscode : require(specifier));
  const wrapped = `(function (exports, require, module, __filename, __dirname) { ${source}\n});`;
  const execute = new vm.Script(wrapped, { filename: bundlePath }).runInThisContext();
  execute(module.exports, load, module, bundlePath, dirname(bundlePath));

  if (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The VM-loaded CommonJS boundary must expose callable extension entry points.
    typeof module.exports.activate !== 'function' ||
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The VM-loaded CommonJS boundary must expose callable extension entry points.
    typeof module.exports.deactivate !== 'function'
  ) {
    throw new Error('Extension bundle smoke load did not expose activation entry points');
  }
}

/** Run against staged assets too: a resolvable JS bundle alone does not prove WASM packaging. */
export async function smokeThumbnailWorker(extensionDirectory) {
  const worker = new Worker(join(extensionDirectory, 'thumbnail-worker.js'));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Packaged thumbnail worker timed out')),
        15_000
      );
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Packaged thumbnail worker exited before responding (${code})`));
      });
      worker.once('message', (response) => {
        clearTimeout(timer);
        const bytes = response.bytes && Buffer.from(response.bytes);
        if (
          response.id !== 1 ||
          !bytes ||
          bytes.length > 256 * 1024 ||
          bytes.toString('ascii', 0, 4) !== 'RIFF' ||
          bytes.toString('ascii', 8, 12) !== 'WEBP'
        ) {
          reject(new Error('Packaged thumbnail worker did not generate a WebP thumbnail'));
        } else resolve(undefined);
      });
      // A complete 1x1 GIF, requiring a real decode and WebP encode with an empty cache.
      const bytes = Uint8Array.from(
        Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
      );
      worker.postMessage({ id: 1, bytes, format: 'gif' }, [bytes.buffer]);
    });
  } finally {
    await worker.terminate();
  }
}
