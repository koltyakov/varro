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

  it('pins the Vite 8.2 toolchain', () => {
    expect(packageJson.devDependencies).toMatchObject({
      vite: '8.2.0',
      rolldown: '1.2.2',
      '@napi-rs/wasm-runtime': '1.2.2',
    });
    expect(packageLock.packages['node_modules/vite']?.version).toBe('8.2.0');
    expect(packageLock.packages['node_modules/rolldown']?.version).toBe('1.2.2');
    expect(packageLock.packages['node_modules/@napi-rs/wasm-runtime']?.version).toBe('1.2.2');
  });

  it('runs CI at the exact advertised Node floors', async () => {
    const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');

    expect(workflow).toContain('node-version: [22.22.2, 24.15.0]');
    expect(workflow).not.toMatch(/^\s*node-version:\s+(?:22|24)\s*$/m);
  });
});
