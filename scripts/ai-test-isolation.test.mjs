import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, link } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { requireIsolatedTestServer, testServerOrigin } from './ai-test-isolation.mjs';

test('live tests cannot silently select production or a redirect-capable remote URL', () => {
  for (const server of [undefined, '', 'http://example.com:4096', 'http://127.0.0.1',
    'http://user@127.0.0.1:4096', 'http://127.0.0.1:4096/path']) {
    assert.throws(() => testServerOrigin(server));
  }
  assert.equal(testServerOrigin('http://127.0.0.1:49001/'), 'http://127.0.0.1:49001');
});

test('requires a distinct test database held by the actual listener and rejects production aliases', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'test-isolation-'));
  const root = await realpath(temporary);
  const testRoot = path.join(root, 'tests');
  const data = path.join(testRoot, 'data/opencode');
  const production = path.join(root, 'production');
  await mkdir(data, { recursive: true });
  await mkdir(production);
  const database = new DatabaseSync(path.join(data, 'opencode.db'));
  database.exec('CREATE TABLE session (id TEXT, time_updated INTEGER); INSERT INTO session VALUES (\'test\', 1)');
  const source = new DatabaseSync(path.join(production, 'opencode.db'));
  source.exec('CREATE TABLE session (id TEXT, time_updated INTEGER); INSERT INTO session VALUES (\'production\', 123)');
  let reportedData = data;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url.startsWith('/path') ? { data: reportedData } : {}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    source.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const verified = await requireIsolatedTestServer(url, '/fixture', testRoot);
  assert.equal(verified.serverPid, process.pid);
  assert.equal(verified.sourceDatabase, path.join(data, 'opencode.db'));

  const unopenedData = path.join(testRoot, 'unopened');
  await mkdir(unopenedData);
  new DatabaseSync(path.join(unopenedData, 'opencode.db')).close();
  reportedData = unopenedData;
  await assert.rejects(requireIsolatedTestServer(url, '/fixture', testRoot), /holds source database/);

  reportedData = production;
  await assert.rejects(requireIsolatedTestServer(url, '/fixture', testRoot), /separate OpenCode database/);
  const alias = path.join(testRoot, 'alias');
  await symlink(production, alias);
  reportedData = alias;
  await assert.rejects(requireIsolatedTestServer(url, '/fixture', testRoot), /separate OpenCode database/);
  const hardAlias = path.join(testRoot, 'hard-alias');
  await mkdir(hardAlias);
  await link(path.join(production, 'opencode.db'), path.join(hardAlias, 'opencode.db'));
  reportedData = hardAlias;
  await assert.rejects(requireIsolatedTestServer(url, '/fixture', testRoot), /hard link/);
  assert.ok(requests.every((request) => request.method === 'GET'));
  assert.deepEqual({ ...source.prepare('SELECT * FROM session').get() }, { id: 'production', time_updated: 123 });
});
