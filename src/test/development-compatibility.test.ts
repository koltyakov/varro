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
    expect(workflow.match(/^\s*node-version: 24\.21\.0$/gm)).toHaveLength(3);
    expect(workflow).not.toContain('matrix.node-version');
    expect(workflow).not.toMatch(/^\s*node-version:\s+(?:22|24)\s*$/m);
    expect(readme).toContain(advertisedFloors);
    expect(developmentGuide).toContain(advertisedFloors);
  });

  it('runs Linux and Windows without matrices and gates E2E on both jobs', async () => {
    const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
    const linuxStart = workflow.indexOf('\n  build-and-test:\n');
    const windowsStart = workflow.indexOf('\n  windows:\n');
    const e2eStart = workflow.indexOf('\n  e2e:\n');
    expect(linuxStart).toBeGreaterThan(-1);
    expect(windowsStart).toBeGreaterThan(linuxStart);
    expect(e2eStart).toBeGreaterThan(windowsStart);
    for (const job of [
      workflow.slice(linuxStart, windowsStart),
      workflow.slice(windowsStart, e2eStart),
    ]) {
      expect(job).not.toMatch(/^    (?:strategy|needs):/m);
      expect(job).toContain('run: npm ci --no-audit --no-fund');
    }
    const e2e = workflow.slice(e2eStart);
    expect(e2e).toContain('needs: [build-and-test, windows]');
    expect(e2e).not.toMatch(/^    if:/m);
  });

  it('trusts the mounted E2E checkout before browser script tests run', async () => {
    const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
    const jobStart = workflow.indexOf('\n  e2e:\n');
    expect(jobStart).toBeGreaterThan(-1);
    const job = workflow.slice(jobStart);
    const checkout = job.indexOf('uses: actions/checkout@');
    const trust = job.indexOf('run: git config --global --add safe.directory "$GITHUB_WORKSPACE"');
    const browserTests = job.indexOf('run: npm run test:scripts:browser');

    expect(checkout).toBeGreaterThan(-1);
    expect(trust).toBeGreaterThan(checkout);
    expect(browserTests).toBeGreaterThan(trust);
  });

  it('runs fresh unit, script, and coverage suites without test-result caching', async () => {
    const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
    expect(workflow).not.toContain('uses: actions/cache@');
    expect(workflow).not.toContain('tmp/test-cache');
    expect(workflow).not.toContain(':cached');
    expect(workflow).toContain('run: npm run test:coverage\n');
    expect(workflow).toContain('run: npm run test:scripts\n');
    expect(workflow).toContain('run: npm run test\n');
    expect(workflow).toContain('run: npm run test:scripts:browser\n');
    expect(Object.keys(packageJson.scripts)).not.toContain('test:affected');
    expect(Object.keys(packageJson.scripts).filter((name) => name.endsWith(':cached'))).toEqual([]);
  });

  it('runs E2E on four shards with a matrix-derived shard count', async () => {
    const [workflow, developmentGuide] = await Promise.all([
      readFile(resolve('.github/workflows/ci.yml'), 'utf8'),
      readFile(resolve('docs/development.md'), 'utf8'),
    ]);

    const e2eStart = workflow.indexOf('\n  e2e:\n');
    expect(e2eStart).toBeGreaterThan(-1);
    const job = workflow.slice(e2eStart);
    expect(job).toContain('shard: [1, 2, 3, 4]');
    expect(job).toContain('fail-fast: false');
    expect(job).toContain('timeout-minutes: 20');
    expect(job).toContain('image: mcr.microsoft.com/playwright:v1.63.0-noble');
    expect(job).toContain(
      'run: node scripts/run-e2e.mjs --shard=${{ matrix.shard }}/${{ strategy.job-total }}'
    );
    expect(developmentGuide).toContain('four jobs with two workers each');
  });
});
