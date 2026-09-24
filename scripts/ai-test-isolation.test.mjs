import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, symlink, link } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { requireIsolatedTestServer, testServerOrigin } from './ai-test-isolation.mjs';

test('live tests cannot silently select production or a redirect-capable remote URL', () => {
  for (const server of [
    undefined,
    '',
    'http://example.com:4096',
    'http://127.0.0.1',
    'http://user@127.0.0.1:4096',
    'http://127.0.0.1:4096/path',
  ]) {
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
  database.exec(
    "CREATE TABLE session (id TEXT, time_updated INTEGER); INSERT INTO session VALUES ('test', 1)"
  );
  const source = new DatabaseSync(path.join(production, 'opencode.db'));
  source.exec(
    "CREATE TABLE session (id TEXT, time_updated INTEGER); INSERT INTO session VALUES ('production', 123)"
  );
  let reportedData = data;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        request.url === '/global/health'
          ? { healthy: true, version: '1.18.32' }
          : request.url.startsWith('/path')
            ? { data: reportedData }
            : {}
      )
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    source.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const verified = await requireIsolatedTestServer(url, '/fixture', testRoot, null);
  assert.equal(verified.serverPid, process.pid);
  assert.equal(verified.sourceDatabase, path.join(data, 'opencode.db'));

  reportedData = undefined;
  await assert.rejects(
    requireIsolatedTestServer(url, '/fixture', testRoot, null),
    /VARRO_AI_DATA_DIR/
  );
  const explicitlyVerified = await requireIsolatedTestServer(url, '/fixture', testRoot, data);
  assert.equal(explicitlyVerified.serverPid, process.pid);
  assert.equal(explicitlyVerified.sourceDatabase, path.join(data, 'opencode.db'));

  const unopenedData = path.join(testRoot, 'unopened');
  await mkdir(unopenedData);
  new DatabaseSync(path.join(unopenedData, 'opencode.db')).close();
  await assert.rejects(
    requireIsolatedTestServer(url, '/fixture', testRoot, unopenedData),
    /holds? source database/
  );
  // An open database is insufficient when a different process owns the listener.
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); process.stdout.write('ready'); process.stdin.resume();",
      path.join(unopenedData, 'opencode.db'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const holderExited = once(holder, 'exit');
  t.after(async () => {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill();
    await holderExited;
  });
  await Promise.race([
    once(holder.stdout, 'data'),
    holderExited.then(() => {
      throw new Error('Database holder exited before readiness');
    }),
  ]);
  try {
    await assert.rejects(
      requireIsolatedTestServer(url, '/fixture', testRoot, unopenedData),
      /holds? source database/
    );
  } finally {
    holder.kill();
    await holderExited;
  }
  await assert.rejects(
    requireIsolatedTestServer(url, '/fixture', testRoot, production),
    /separate OpenCode database/
  );
  reportedData = unopenedData;
  await assert.rejects(
    requireIsolatedTestServer(url, '/fixture', testRoot, null),
    /holds? source database/
  );

  reportedData = production;
  await assert.rejects(
    requireIsolatedTestServer(url, '/fixture', testRoot, data),
    /does not match/
  );
  await assert.rejects(
    requireIsolatedTestServer(url, '/fixture', testRoot, null),
    /separate OpenCode database/
  );
  const alias = path.join(testRoot, 'alias');
  await symlink(production, alias, process.platform === 'win32' ? 'junction' : 'dir');
  reportedData = alias;
  await assert.rejects(
    requireIsolatedTestServer(url, '/fixture', testRoot, null),
    /separate OpenCode database/
  );
  const hardAlias = path.join(testRoot, 'hard-alias');
  await mkdir(hardAlias);
  await link(path.join(production, 'opencode.db'), path.join(hardAlias, 'opencode.db'));
  reportedData = hardAlias;
  await assert.rejects(requireIsolatedTestServer(url, '/fixture', testRoot, null), /hard link/);
  assert.ok(requests.every((request) => request.method === 'GET'));
  assert.deepEqual(
    { ...source.prepare('SELECT * FROM session').get() },
    { id: 'production', time_updated: 123 }
  );
});

test('v2 HTML fallback uses native location/status while preserving database ownership checks', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'v2-isolation-')));
  const data = path.join(root, 'data/opencode');
  await mkdir(data, { recursive: true });
  const database = new DatabaseSync(path.join(data, 'opencode.db'));
  database.exec('CREATE TABLE fixture (id TEXT)');
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    const route = new URL(request.url, 'http://localhost').pathname;
    const responses = {
      '/api/status': { ready: true, version: '2.0.15' },
      '/api/location': { directory: '/fixture', project: { directory: '/fixture' } },
      '/api/session/active': { data: { ses_busy: { type: 'running' } } },
      '/api/shell': { data: [] },
    };
    if (!(route in responses)) {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>OpenCode</title>');
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(responses[route]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(requireIsolatedTestServer(url, '/fixture', root, null), /VARRO_AI_DATA_DIR/);
  const result = await requireIsolatedTestServer(url, '/fixture', root, data);
  assert.deepEqual(result.backend, { apiVersion: 2, version: '2.0.15' });
  assert.deepEqual(result.activeSessionIds, ['ses_busy']);
  assert.equal(result.serverPid, process.pid);
  assert.ok(requests.some((route) => route.includes('location%5Bdirectory%5D=%2Ffixture')));
  assert.ok(!requests.some((route) => route.startsWith('/path')));
});
