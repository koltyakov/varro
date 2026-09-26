import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  copyHostModelPreferences,
  copyProviderCredentials,
  copyProviderSettings,
} from './ai-test-host-settings.mjs';

test('inherits the curated model list without bringing host sessions or drafts into the editor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await mkdir(path.join(source, 'User/globalStorage'), { recursive: true });
  const filename = path.join(source, 'User/globalStorage/state.vscdb');
  const host = new DatabaseSync(filename);
  const preferences = {
    'varro.modelPreferences': { favorites: ['openai/test'] },
    'varro.modelPreferences.hostMigration.v1': true,
  };
  host.exec('CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB)');
  host
    .prepare('INSERT INTO ItemTable VALUES (?, ?)')
    .run(
      'koltyakov.varro',
      JSON.stringify({
        ...preferences,
        'varro.queuedMessages': ['private draft'],
        'varro.sessionSelectedModels': { production: 'openai/test' },
      })
    );
  host.close();
  const before = await readFile(filename);
  await copyHostModelPreferences(source, destination);
  assert.deepEqual(await readFile(filename), before);
  const copy = new DatabaseSync(path.join(destination, 'User/globalStorage/state.vscdb'), {
    readOnly: true,
  });
  try {
    assert.deepEqual(
      JSON.parse(
        copy.prepare('SELECT value FROM ItemTable WHERE key = ?').get('koltyakov.varro').value
      ),
      preferences
    );
  } finally {
    copy.close();
  }
});

test('inherits provider configuration and credentials without copying or changing sessions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const destination = path.join(root, 'destination');
  await mkdir(source);
  await mkdir(destination);
  const config = `{
    // Host provider settings include relative file references.
    "model": "openai/test",
    "providers": { "openai": { "settings": { "apiKey": "{file:./key}" } } },
    "mcp": { "servers": { "production": {} } },
  }`;
  await writeFile(path.join(source, 'opencode.jsonc'), config);
  await copyProviderSettings(source, destination);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'opencode.jsonc'), 'utf8')), {
    model: 'openai/test',
    providers: { openai: { settings: { apiKey: `{file:${path.join(source, 'key')}}` } } },
  });
  assert.equal(await readFile(path.join(source, 'opencode.jsonc'), 'utf8'), config);
  const sourcePath = path.join(source, 'opencode.db');
  const destinationPath = path.join(destination, 'opencode.db');
  const schema =
    'CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_created INTEGER)';
  const host = new DatabaseSync(sourcePath);
  host.exec(schema);
  host.exec('CREATE TABLE session (id TEXT, time_updated INTEGER)');
  host.exec("INSERT INTO session VALUES ('production', 123)");
  const oauth = JSON.stringify({
    type: 'oauth',
    access: 'test-access',
    refresh: 'test-refresh',
    metadata: { accountId: 'account' },
  });
  host
    .prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)')
    .run('provider', 'openai', oauth, 1, 100);
  host.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)').run('mcp', null, '{}', 1, 100);
  host.close();
  const isolated = new DatabaseSync(destinationPath);
  isolated.exec(schema);
  isolated.close();
  const before = await readFile(sourcePath);
  assert.equal(copyProviderCredentials(sourcePath, destinationPath), 1);
  assert.deepEqual(await readFile(sourcePath), before);
  const result = new DatabaseSync(destinationPath, { readOnly: true });
  try {
    assert.equal(result.prepare('SELECT value FROM credential').get().value, oauth);
    assert.equal(
      result.prepare("SELECT name FROM sqlite_master WHERE name = 'session'").get(),
      undefined
    );
    assert.equal(result.prepare('SELECT COUNT(*) AS count FROM credential').get().count, 1);
  } finally {
    result.close();
  }
});
