import { readFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { dirname } from 'node:path';
import vm from 'node:vm';

const ALLOWED_RUNTIME_MODULES = new Set(['vscode']);
for (const name of builtinModules) {
  ALLOWED_RUNTIME_MODULES.add(name);
  if (!name.startsWith('node:')) ALLOWED_RUNTIME_MODULES.add(`node:${name}`);
}

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
      if (!ALLOWED_RUNTIME_MODULES.has(imported.path)) {
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
    typeof module.exports.activate !== 'function' ||
    typeof module.exports.deactivate !== 'function'
  ) {
    throw new Error('Extension bundle smoke load did not expose activation entry points');
  }
}
