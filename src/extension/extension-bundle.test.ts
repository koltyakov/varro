import { builtinModules } from 'node:module';
import { describe, expect, it } from 'vitest';
import { verifyExtensionBundleMetafile } from '../../scripts/verify-extension-bundle.mjs';

function metafile(imports: Array<{ path: string; kind: string; external?: boolean }>) {
  return {
    inputs: {},
    outputs: {
      'dist/extension/extension.js': {
        bytes: 1,
        exports: ['activate', 'deactivate'],
        inputs: {},
        imports,
      },
    },
  };
}

describe('extension bundle verification', () => {
  it('allows vscode and bare or node-prefixed builtins', () => {
    expect(() =>
      verifyExtensionBundleMetafile(
        metafile([
          { path: 'vscode', kind: 'require-call', external: true },
          { path: 'fs/promises', kind: 'require-call', external: true },
          { path: 'node:path', kind: 'require-call', external: true },
        ])
      )
    ).not.toThrow();
  });

  it('preserves builtins that are only available with the node prefix', () => {
    const nodeOnly = builtinModules.find((name) => name.startsWith('node:'));
    expect(nodeOnly).toBeTruthy();

    expect(() =>
      verifyExtensionBundleMetafile(
        metafile([{ path: nodeOnly!, kind: 'require-call', external: true }])
      )
    ).not.toThrow();
    expect(() =>
      verifyExtensionBundleMetafile(
        metafile([{ path: nodeOnly!.slice('node:'.length), kind: 'require-call', external: true }])
      )
    ).toThrow('Extension bundle is not self-contained');
  });

  it.each([
    [{ path: 'left-pad', kind: 'require-call', external: true }, 'left-pad'],
    [{ path: './lazy-plugin.js', kind: 'dynamic-import', external: true }, 'dynamic import'],
    [{ path: './extension-chunk.js', kind: 'import-statement' }, 'separate output'],
  ])('rejects runtime dependency %j', (imported, message) => {
    expect(() => verifyExtensionBundleMetafile(metafile([imported]))).toThrow(message);
  });

  it('requires metafile output data', () => {
    expect(() => verifyExtensionBundleMetafile({ inputs: {}, outputs: {} })).toThrow(
      'did not produce metafile output data'
    );
  });
});
