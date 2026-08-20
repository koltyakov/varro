/* oxlint-disable anti-slop/no-module-mocking -- This guard verifies the generated bundle through its import boundary. */
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  showWarningMessage: vi.fn(),
  executeCommand: vi.fn(() => Promise.resolve()),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('vscode', () => ({
  window: { showWarningMessage: mocks.showWarningMessage },
  commands: { executeCommand: mocks.executeCommand },
}));
vi.mock('./logger', () => ({ logger: mocks.logger }));

import {
  GeneratedDependencyTreeGuard,
  findUnignoredGeneratedDependencyTrees,
} from './generated-dependency-tree-guard';

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'varro-generated-tree-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  return root;
}

function dependency(root: string, relativePath = 'node_modules/pkg/index.js') {
  const path = join(root, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'module.exports = {};\n');
}

afterEach(() => {
  mocks.showWarningMessage.mockReset();
  mocks.executeCommand.mockClear();
  mocks.logger.warn.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('generated dependency tree guard', () => {
  it('detects root and nested unignored node_modules trees', async () => {
    const root = repository();
    dependency(root);
    dependency(root, 'packages/app/node_modules/pkg/index.js');

    await expect(findUnignoredGeneratedDependencyTrees(root)).resolves.toEqual([
      'node_modules',
      'packages/app/node_modules',
    ]);
  });

  it('detects common Python virtual environment trees', async () => {
    const root = repository();
    dependency(root, '.venv/lib/python3.12/site-packages/pkg/__init__.py');
    dependency(root, 'packages/api/venv/lib/python3.12/site-packages/pkg/__init__.py');
    dependency(root, '.tox/py312/lib/python3.12/site-packages/pkg/__init__.py');

    await expect(findUnignoredGeneratedDependencyTrees(root)).resolves.toEqual([
      '.tox',
      '.venv',
      'packages/api/venv',
    ]);
  });

  it('detects unignored __pycache__ trees', async () => {
    const root = repository();
    dependency(root, 'src/__pycache__/module.cpython-312.pyc');

    await expect(findUnignoredGeneratedDependencyTrees(root)).resolves.toEqual(['src/__pycache__']);
  });

  it('ignores trees excluded by Git', async () => {
    const root = repository();
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
    dependency(root);

    await expect(findUnignoredGeneratedDependencyTrees(root)).resolves.toEqual([]);
  });

  it('does not flag tracked dependency files', async () => {
    const root = repository();
    dependency(root);
    execFileSync('git', ['-C', root, 'add', '--force', 'node_modules/pkg/index.js']);

    await expect(findUnignoredGeneratedDependencyTrees(root)).resolves.toEqual([]);
  });

  it('caches Send Anyway for an unchanged tree fingerprint', async () => {
    const root = repository();
    dependency(root);
    mocks.showWarningMessage.mockResolvedValue('Send Anyway');
    const guard = new GeneratedDependencyTreeGuard();

    await expect(guard.confirmPromptAdmission(root)).resolves.toBe(true);
    await expect(guard.confirmPromptAdmission(root)).resolves.toBe(true);

    expect(mocks.showWarningMessage).toHaveBeenCalledOnce();
  });

  it('cancels admission and opens Source Control on request', async () => {
    const root = repository();
    dependency(root);
    mocks.showWarningMessage.mockResolvedValue('Open Source Control');

    await expect(new GeneratedDependencyTreeGuard().confirmPromptAdmission(root)).resolves.toBe(
      false
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith('workbench.view.scm');
  });
});
