import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import packageJson from '../../package.json';

describe('development compatibility', () => {
  it('targets VS Code 1.107 APIs and documents the matching editor floor', async () => {
    const [readme, developmentGuide] = await Promise.all([
      readFile(resolve('README.md'), 'utf8'),
      readFile(resolve('docs/development.md'), 'utf8'),
    ]);

    expect(packageJson.engines.vscode).toBe('^1.107.0');
    expect(packageJson.devDependencies['@types/vscode']).toBe('1.107.0');
    expect(readme).toContain('1.107 or newer');
    expect(developmentGuide).toContain('1.107 or newer');
    expect(packageJson.contributes.views.varro).toEqual([
      expect.objectContaining({ id: 'varro.chat', type: 'webview' }),
    ]);
  });

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
    expect(workflow.match(/^\s*runs-on: ubuntu-24\.04$/gm)).toHaveLength(4);
    expect(workflow).not.toContain('ubuntu-latest');
    expect(workflow.match(/^\s*node-version-file: package\.json$/gm)).toHaveLength(4);
    expect(workflow).not.toContain('matrix.node-version');
    expect(workflow).not.toMatch(/^\s*node-version:/m);
    expect(readme).toContain(advertisedFloors);
    expect(developmentGuide).toContain(advertisedFloors);
  });

  it('uses the manifest toolchain pins in every workflow', async () => {
    const workflows = await Promise.all(
      ['ci', 'opencode-compatibility', 'windows-vscode-smoke'].map((name) =>
        readFile(resolve(`.github/workflows/${name}.yml`), 'utf8')
      )
    );

    expect(packageJson.volta.npm).toMatch(/^\d+\.\d+\.\d+$/);
    for (const workflow of workflows) {
      const setups = workflow.match(/uses: actions\/setup-node@/g) ?? [];
      expect(setups.length).toBeGreaterThan(0);
      expect(workflow.match(/^\s*node-version-file: package\.json$/gm)).toHaveLength(setups.length);
      expect(workflow).not.toMatch(/^\s*node-version:/m);
      expect(workflow).toContain(
        'npm install -g npm@$(node -p "require(\'./package.json\').volta.npm")'
      );
    }
  });

  it('allows direct Git dependencies and the locked install scripts for npm 12', async () => {
    const [npmrc, lockSource] = await Promise.all([
      readFile(resolve('.npmrc'), 'utf8'),
      readFile(resolve('package-lock.json'), 'utf8'),
    ]);
    // SAFETY: The repository's npm v3 lockfile records package versions and install-script flags.
    const lock = JSON.parse(lockSource) as {
      packages: Record<string, { version: string; hasInstallScript?: boolean }>;
    };
    const scripts = Object.entries(lock.packages)
      .filter(([path, entry]) => path && entry.hasInstallScript)
      .map(([path, entry]) => [`${path.split('node_modules/').at(-1)}@${entry.version}`, true]);

    expect(npmrc).toMatch(/^allow-git=root$/m);
    expect(packageJson.allowScripts).toEqual(Object.fromEntries(scripts));
  });

  it('runs Linux and Windows without matrices and runs E2E independently', async () => {
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
    expect(e2e).toContain('needs: e2e-history');
    expect(e2e).not.toContain('needs: build-and-test');
    expect(e2e).not.toContain('needs: windows');
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
    expect(job).toContain(
      `image: mcr.microsoft.com/playwright:v${packageJson.devDependencies['@playwright/test']}-noble`
    );
    expect(job).toContain(
      'run: node scripts/run-e2e.mjs --shard=${{ matrix.shard }}/${{ strategy.job-total }}'
    );
    expect(developmentGuide).toContain('four jobs with two workers each');
    expect(developmentGuide).toContain('Each spec file belongs to exactly one shard');
  });

  it('shares one timing snapshot across shards and saves timings only after successful E2E', async () => {
    const workflow = await readFile(resolve('.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain("workflow_id: 'ci.yml', branch, status: 'success'");
    expect(workflow).toContain('artifact-ids: ${{ needs.e2e-history.outputs.artifact-id }}');
    expect(workflow).toContain('run-id: ${{ needs.e2e-history.outputs.run-id }}');
    expect(workflow).toContain('path: tmp/e2e-sharding/history');
    expect(workflow).toContain('name: e2e-results-${{ matrix.shard }}');
    expect(workflow).toContain('tmp/e2e-sharding/assignment-${{ matrix.shard }}.json');
    expect(workflow).toContain('tmp/e2e-sharding/shard-${{ matrix.shard }}.txt');
    expect(workflow).toContain('pattern: e2e-results-*');
    const mergeJob = workflow.slice(workflow.indexOf('\n  e2e-timings:\n'));
    expect(mergeJob).toContain('needs: e2e\n');
    expect(mergeJob).not.toContain('if: always()');
    expect(mergeJob).toContain('name: e2e-timings');
  });
});
