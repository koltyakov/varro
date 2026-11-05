import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeRunCreatedFiles } from './ai-fuzzy-fixture-cleanup.mjs';

const relative = 'packages/core/test/wildcard.test.ts';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const proof = (file) => ({
  type: 'tool',
  tool: 'patch',
  state: { status: 'completed', metadata: { files: [{ file, status: 'added' }] } },
});

async function fixture(t) {
  const temporary = path.join(os.tmpdir(), 'opencode');
  await mkdir(temporary, { recursive: true });
  const directory = await mkdtemp(path.join(temporary, 'fixture-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'fixture');
  await mkdir(workspace);
  const git = (...args) =>
    execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' }).trimEnd();
  git('init', '-q');
  await writeFile(path.join(workspace, 'existing.ts'), 'original\n');
  git('add', 'existing.ts');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'baseline'
  );
  const baseline = { head: git('rev-parse', 'HEAD'), status: '' };
  await mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
  await writeFile(path.join(workspace, relative), 'run-created test\n');
  const options = {
    workspace,
    baseline,
    parts: [proof(relative)],
    exitEvidence: {
      head: baseline.head,
      baseline: baseline.head,
      untracked: [relative],
      contents: { [relative]: hash('run-created test\n') },
    },
    evidencePath: path.join(directory, 'cleanup.json'),
  };
  return { options, git, directory, file: path.join(workspace, relative) };
}

test('removes the recorded run-created wildcard test and preserves recovery evidence', async (t) => {
  const { options, git, file } = await fixture(t);
  assert.deepEqual(await removeRunCreatedFiles(options), [relative]);
  await assert.rejects(access(file), { code: 'ENOENT' });
  assert.equal(git('status', '--short'), '');
  assert.equal(await readFile(path.join(options.workspace, 'existing.ts'), 'utf8'), 'original\n');
  const saved = JSON.parse(await readFile(options.evidencePath, 'utf8'));
  assert.equal(
    Buffer.from(saved.files[0].originalBase64, 'base64').toString(),
    'run-created test\n'
  );
  assert.deepEqual(saved.removed, [relative]);
});

test('accepts completed patch metadata with the exact absolute fixture path', async (t) => {
  const { options, file } = await fixture(t);
  options.parts = [proof(file)];
  assert.deepEqual(await removeRunCreatedFiles(options), [relative]);
});

test('does not delete any addition when another untracked path has no creation evidence', async (t) => {
  const { options, file } = await fixture(t);
  const other = 'unrelated.ts';
  await writeFile(path.join(options.workspace, other), 'unrelated\n');
  options.exitEvidence.untracked.push(other);
  options.exitEvidence.contents[other] = hash('unrelated\n');
  await assert.rejects(removeRunCreatedFiles(options), /No completed patch creation evidence/);
  assert.equal(await readFile(file, 'utf8'), 'run-created test\n');
  assert.equal(await readFile(path.join(options.workspace, other), 'utf8'), 'unrelated\n');
  await assert.rejects(access(options.evidencePath), { code: 'ENOENT' });
});

test('refuses edits or new untracked paths after the exit snapshot', async (t) => {
  for (const change of ['content', 'paths']) {
    const { options, file } = await fixture(t);
    if (change === 'content') await writeFile(file, 'later user edit\n');
    else await writeFile(path.join(options.workspace, 'later.ts'), 'later\n');
    await assert.rejects(removeRunCreatedFiles(options), /changed since/);
    await access(file);
  }
});

test('refuses dirty or changed baselines and mismatched exit evidence', async (t) => {
  for (const field of ['dirty', 'head', 'exit']) {
    const { options, file } = await fixture(t);
    if (field === 'dirty') options.baseline.status = '?? pre-existing.ts';
    if (field === 'head') options.baseline.head = '0'.repeat(40);
    if (field === 'exit') options.exitEvidence.head = '0'.repeat(40);
    await assert.rejects(removeRunCreatedFiles(options), /unchanged clean baseline/);
    await access(file);
  }
});

test('rejects incomplete, non-creation and outside-workspace patch evidence', async (t) => {
  for (const kind of ['running', 'modified', 'truncated', 'outside']) {
    const { options, file } = await fixture(t);
    if (kind === 'running') options.parts[0].state.status = 'running';
    if (kind === 'modified') options.parts[0].state.metadata.files[0].status = 'modified';
    if (kind === 'truncated') options.parts[0].state.metadata.truncated = true;
    if (kind === 'outside') options.parts[0].state.metadata.files[0].file = '../wildcard.test.ts';
    await assert.rejects(removeRunCreatedFiles(options), /No completed patch creation evidence/);
    await access(file);
  }
});

test('refuses symlinks and hardlinks without touching external files', async (t) => {
  for (const kind of ['symlink', 'hardlink']) {
    const { options, file, directory } = await fixture(t);
    const external = path.join(directory, 'external.ts');
    await writeFile(external, 'external\n');
    await rm(file);
    if (kind === 'symlink') await symlink(external, file);
    else await link(external, file);
    options.exitEvidence.contents[relative] = hash('external\n');
    await assert.rejects(removeRunCreatedFiles(options), /symlinks, hardlinks/);
    assert.equal(await readFile(external, 'utf8'), 'external\n');
  }
});

test('requires evidence outside the fixture and saves it before unlinking', async (t) => {
  for (const kind of ['inside', 'unwritable']) {
    const { options, file, directory } = await fixture(t);
    options.evidencePath =
      kind === 'inside'
        ? path.join(options.workspace, 'evidence.json')
        : path.join(directory, 'missing', 'evidence.json');
    await assert.rejects(removeRunCreatedFiles(options));
    assert.equal(await readFile(file, 'utf8'), 'run-created test\n');
  }
});
