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
    expect(workflow).toContain('node-version: [24.21.0]');
    expect(workflow).not.toMatch(/^\s*node-version:\s+(?:22|24)\s*$/m);
    expect(readme).toContain(advertisedFloors);
    expect(developmentGuide).toContain(advertisedFloors);
  });

  it('trusts the mounted E2E checkout before cached tests inspect Git files', async () => {
    const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
    const jobStart = workflow.indexOf('\n  e2e:\n');
    expect(jobStart).toBeGreaterThan(-1);
    const job = workflow.slice(jobStart);
    const checkout = job.indexOf('uses: actions/checkout@');
    const trust = job.indexOf('run: git config --global --add safe.directory "$GITHUB_WORKSPACE"');
    const cachedTests = job.indexOf('run: npm run test:scripts:browser:cached');

    expect(checkout).toBeGreaterThan(-1);
    expect(trust).toBeGreaterThan(checkout);
    expect(cachedTests).toBeGreaterThan(trust);
  });
});
