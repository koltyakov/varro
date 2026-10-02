import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReversibleFixtureEdit } from './ai-fuzzy-fixture-edit.mjs';

async function fixture(t, original = 'existing dirty content\n') {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'varro-reversible-edit-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const file = path.join(workspace, 'timeout.ts');
  const evidencePath = path.join(workspace, 'evidence.json');
  await writeFile(file, original);
  const edit = new ReversibleFixtureEdit(workspace, 'timeout.ts', 'VFZ AI18 transient test');
  await edit.prepare(evidencePath);
  return { workspace, file, evidencePath, edit };
}

test('restores only the authorized path and preserves pre-existing dirty bytes', async (t) => {
  const { workspace, file, evidencePath, edit } = await fixture(t);
  const other = path.join(workspace, 'other.ts');
  await writeFile(other, 'unrelated edit');
  await writeFile(file, edit.edited);
  const result = await edit.restore(evidencePath);
  assert.equal(result.expectedEdit, true);
  assert.equal(result.restored, true);
  assert.equal(await readFile(file, 'utf8'), 'existing dirty content\n');
  assert.equal(await readFile(other, 'utf8'), 'unrelated edit');
  assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')), result);
});

test('retains original recovery bytes before a child can start or outlive the controller', async (t) => {
  const { file, evidencePath, edit } = await fixture(t);
  await writeFile(file, edit.edited);
  const saved = JSON.parse(await readFile(evidencePath, 'utf8'));
  assert.equal(saved.prepared, true);
  assert.equal(saved.restored, false);
  assert.equal(Buffer.from(saved.originalBase64, 'base64').toString(), 'existing dirty content\n');
  assert.deepEqual(Buffer.from(saved.expectedBase64, 'base64'), edit.edited);
});

test('preserves CRLF, missing final newline, and unchanged model output', async (t) => {
  for (const original of ['one\r\ntwo\r\n', 'one\r\ntwo', 'one']) {
    const { file, evidencePath, edit } = await fixture(t, original);
    const unchanged = await edit.restore(evidencePath);
    assert.equal(unchanged.unchanged, true);
    await writeFile(file, edit.edited);
    assert.equal((await edit.restore(evidencePath)).expectedEdit, true);
    assert.equal(await readFile(file, 'utf8'), original);
  }
});

test('retains unexpected model content as evidence instead of promoting it to an expected edit', async (t) => {
  const { file, evidencePath, edit } = await fixture(t);
  await writeFile(file, 'model replaced the whole file');
  const result = await edit.restore(evidencePath);
  assert.equal(result.expectedEdit, false);
  assert.equal(result.unchanged, false);
  assert.equal(result.restored, true);
  assert.equal(
    Buffer.from(result.observedBase64, 'base64').toString(),
    'model replaced the whole file'
  );
  assert.equal(await readFile(file, 'utf8'), 'existing dirty content\n');
});

test('does not restore without first retaining evidence', async (t) => {
  const { workspace, file, edit } = await fixture(t);
  await writeFile(file, edit.edited);
  await assert.rejects(edit.restore(path.join(workspace, 'missing', 'evidence.json')), {
    code: 'ENOENT',
  });
  assert.deepEqual(await readFile(file), edit.edited);
});

test('refuses path traversal and markers with injected newlines', () => {
  assert.throws(() => new ReversibleFixtureEdit('/fixture', '../outside', 'marker'), /traversal/);
  assert.throws(
    () => new ReversibleFixtureEdit('/fixture', 'file', 'marker\nextra'),
    /single-line/
  );
});

test('refuses a hardlinked target rather than changing another file through restoration', async (t) => {
  const { workspace, file, edit, evidencePath } = await fixture(t);
  const other = path.join(workspace, 'hardlink.ts');
  await link(file, other);
  await writeFile(file, 'unexpected shared content');
  await assert.rejects(edit.restore(evidencePath), /hardlinks/);
  assert.equal(await readFile(other, 'utf8'), 'unexpected shared content');
});

test('refuses a parent junction redirect before restoring any external content', async (t) => {
  const { workspace, file, edit, evidencePath } = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), 'varro-external-edit-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const linked = path.join(workspace, 'linked');
  await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(path.join(external, 'timeout.ts'), 'external content');
  edit.file = path.join(linked, 'timeout.ts');
  await assert.rejects(edit.restore(evidencePath), /escaped/);
  assert.equal(await readFile(path.join(external, 'timeout.ts'), 'utf8'), 'external content');
  assert.equal(await readFile(file, 'utf8'), 'existing dirty content\n');
});
