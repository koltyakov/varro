import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

describe('development compatibility', () => {
  it('provides standards-compatible CSS identifier escaping in tests', () => {
    expect(CSS.escape('a b#c')).toBe('a\\ b\\#c');
    expect(CSS.escape('0a')).toBe('\\30 a');
    expect(CSS.escape('\0')).toBe('\uFFFD');
    expect(CSS.escape('-')).toBe('\\-');
  });

  it('keeps CI pinned and documents the supported Node floors', async () => {
    const [workflow, readme, developmentGuide] = await Promise.all([
      readFile(resolve('.github/workflows/ci.yml'), 'utf8'),
      readFile(resolve('README.md'), 'utf8'),
      readFile(resolve('docs/development.md'), 'utf8'),
    ]);
    const advertisedFloors = '22.22.2+ on Node 22, or Node 24.15.0+';

    expect(packageJson.engines.node).toBe('^22.22.2 || >=24.15.0');
    expect(workflow).toContain('node-version: [24.18.1]');
    expect(workflow).not.toMatch(/^\s*node-version:\s+(?:22|24)\s*$/m);
    expect(readme).toContain(advertisedFloors);
    expect(developmentGuide).toContain(advertisedFloors);
  });
});
