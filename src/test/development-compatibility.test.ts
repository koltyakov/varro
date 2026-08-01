import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';
import packageLock from '../../package-lock.json';

describe('development compatibility', () => {
  it('provides standards-compatible CSS identifier escaping in tests', () => {
    expect(CSS.escape('a b#c')).toBe('a\\ b\\#c');
    expect(CSS.escape('0a')).toBe('\\30 a');
    expect(CSS.escape('\0')).toBe('\uFFFD');
    expect(CSS.escape('-')).toBe('\\-');
  });

  it('pins the Node 22.12-compatible Vite 8.2 toolchain', () => {
    expect(packageJson.devDependencies).toMatchObject({
      vite: '8.2.0',
      rolldown: '1.2.0',
      '@napi-rs/wasm-runtime': '1.1.6',
    });
    expect(packageLock.packages['node_modules/vite']?.version).toBe('8.2.0');
    expect(packageLock.packages['node_modules/rolldown']?.version).toBe('1.2.0');
    expect(packageLock.packages['node_modules/@rolldown/binding-wasm32-wasi']?.version).toBe(
      '1.2.0'
    );
    expect(packageLock.packages['node_modules/@napi-rs/wasm-runtime']?.version).toBe('1.1.6');
  });

  it('runs CI at the exact advertised Node floors', async () => {
    const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toContain('node-version: [22.12.0, 24.0.0]');
    expect(workflow).not.toMatch(/^\s*node-version:\s+(?:22|24)\s*$/m);
  });
});
