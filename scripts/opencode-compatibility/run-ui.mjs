import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { executeVscodeCommand, reserveLoopbackPort, writeVscodeLaunchMetadata } from '../vscode-launch-process.mjs';

const project = resolve(import.meta.dirname, '../..');
const binary = process.env.VARRO_OPENCODE_TEST_BINARY;
if (!binary) throw new Error('Set VARRO_OPENCODE_TEST_BINARY to the released CLI being tested');
const executable = process.env.VARRO_VSCODE_EXECUTABLE || '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const parent = join(project, 'artifacts/ai-test-data');
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'v2-ui-'));
const profiles = join(tmpdir(), 'opencode');
await mkdir(profiles, { recursive: true });
const profile = await mkdtemp(join(profiles, 'vui-'));
const workspace = join(root, 'workspace');
const database = join(root, 'data', 'opencode.db');
for (const path of [workspace, join(workspace, '.vscode'), join(root, 'data'), join(root, 'home'), join(profile, 'user'), join(profile, 'extensions')]) await mkdir(path, { recursive: true });
assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: workspace }).status, 0);
const port = await reserveLoopbackPort();
const debugPort = await reserveLoopbackPort();
const serverUrl = `http://127.0.0.1:${port}`;
const errors = [];
const requests = [];
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const source = Buffer.concat(chunks).toString();
  const body = source ? JSON.parse(source) : {};
  requests.push({ path: request.url, model: body.model, stream: body.stream });
  if (body.model === 'unauthorized') {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'UI fixture authentication rejected', type: 'authentication_error', code: 'invalid_api_key' } }));
    return;
  }
  if (!body.stream) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: 'completion-ui', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'UI adapter reply.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const content of ['UI ', 'adapter ', 'reply.']) {
    response.write(`data: ${JSON.stringify({ id: 'completion-ui', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    await delay(100);
  }
  response.end(`data: ${JSON.stringify({ id: 'completion-ui', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((done) => provider.listen(0, '127.0.0.1', done));
const modelUrl = `http://127.0.0.1:${provider.address().port}/v1`;
await writeFile(join(workspace, 'opencode.json'), JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture', agents: { title: { model: 'fixture/fixture' } }, provider: {
  fixture: { npm: '@ai-sdk/openai-compatible', name: 'UI fixture', options: { baseURL: modelUrl, apiKey: 'fixture-only' }, models: { fixture: { name: 'UI fixture model', limit: { context: 32000, output: 1000 } }, unauthorized: { name: 'UI authorization failure', limit: { context: 32000, output: 1000 } } } },
  recovery: { npm: '@ai-sdk/openai-compatible', name: 'UI recovery fixture', options: { baseURL: modelUrl, apiKey: 'fixture-only' }, models: { recovery: { name: 'UI recovery model', limit: { context: 32000, output: 1000 } } } },
  openai: { options: { baseURL: modelUrl } },
  missing: { name: 'Missing provider fixture', models: { broken: { name: 'UI preflight failure', limit: { context: 32000, output: 1000 } } } },
} }));
await writeFile(join(workspace, '.vscode/settings.json'), JSON.stringify({ 'varro.server.command': resolve(binary), 'varro.server.port': port, 'varro.server.autoUpdate': false, 'security.workspace.trust.enabled': false, 'workbench.startupEditor': 'none', 'telemetry.telemetryLevel': 'off' }));
const env = { PATH: process.env.PATH, TMPDIR: tmpdir(), HOME: join(root, 'home'), XDG_DATA_HOME: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'), XDG_CACHE_HOME: join(root, 'cache'), OPENCODE_DB: database, OPENCODE_TEST_HOME: join(root, 'home'), VARRO_TEST_SERVER_URL: serverUrl };
const code = spawn(executable, ['--no-sandbox', '--disable-gpu-sandbox', '--password-store=basic', '--use-mock-keychain', '--disable-updates', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(profile, 'user')}`, `--extensions-dir=${join(profile, 'extensions')}`, `--extensionDevelopmentPath=${project}`, workspace], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
let codeLog = '';
code.stdout.on('data', (data) => { codeLog = (codeLog + data).slice(-20000); });
code.stderr.on('data', (data) => { codeLog = (codeLog + data).slice(-20000); });
let browser;
let frame;
let authorization;
const ownedServerPids = new Set();
const ownsDatabase = (pid) => spawnSync('lsof', ['-t', '-a', '-p', String(pid), database], { encoding: 'utf8' }).stdout.trim().split(/\s+/).includes(String(pid));
const sessions = new Set();
const events = [];
const stream = new AbortController();
const api = async (method, path, body) => {
  const options = { method, headers: { Authorization: authorization, 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) };
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') options.body = JSON.stringify(body);
  const response = await fetch(serverUrl + path, options);
  if (response.status === 204) return null;
  if (response.status === 404 && method === 'DELETE') return null;
  if (!response.ok) throw new Error(`Fixture ${method} ${path}: ${response.status}`);
  return response.json();
};
const serverInfo = async () => {
  const response = await fetch(serverUrl + '/api/info', { headers: { Authorization: authorization }, redirect: 'error', signal: AbortSignal.timeout(10000) });
  return response.ok ? response.json() : api('GET', '/api/status');
};
const findFrame = async () => {
  for (let attempt = 0; attempt < 150; attempt++) {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      for (const candidate of page.frames()) {
        if (await candidate.locator('.model-picker-btn').first().isVisible().catch(() => false)) return candidate;
      }
    }
    await delay(200);
  }
  throw new Error('The isolated Varro composer did not appear');
};
let outcome;
try {
  await writeVscodeLaunchMetadata(join(root, 'launch.json'), { pid: code.pid, executable, profileRoot: profile, userDataDir: join(profile, 'user'), extensionsDir: join(profile, 'extensions'), workspace, remoteDebuggingPort: debugPort });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); break; } catch { await delay(200); }
  }
  assert.ok(browser, `Could not connect to the isolated editor: ${codeLog}`);
  for (let attempt = 0; ; attempt++) {
    try { await executeVscodeCommand(debugPort, 'View: Focus on Varro View'); break; }
    catch (error) { if (attempt >= 100) throw error; await delay(200); }
  }
  frame = await findFrame();
  let lease;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { lease = JSON.parse(await readFile(join(tmpdir(), `varro-opencode-server-${port}.json`), 'utf8')); if (lease.password) break; } catch {}
    await delay(200);
  }
  assert.ok(lease?.password, 'The v2 fixture did not create an authenticated ownership lease');
  assert.equal(lease.port, port);
  assert.equal(await realpath(database), database);
  assert.equal((await stat(database)).nlink, 1);
  const owner = spawnSync('lsof', ['-t', '-a', '-p', String(lease.pid), database], { encoding: 'utf8' });
   assert.ok(owner.stdout.trim().split(/\s+/).includes(String(lease.pid)), 'The fixture listener does not hold the isolated database');
   ownedServerPids.add(lease.pid);
  authorization = `Basic ${Buffer.from(`opencode:${lease.password}`).toString('base64')}`;
   assert.equal((await serverInfo()).pid, lease.pid);
  assert.equal((await api('GET', '/api/session')).data.length, 0);
  void (async () => {
    const response = await fetch(serverUrl + '/api/event', { headers: { Authorization: authorization }, signal: stream.signal });
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += new TextDecoder().decode(chunk);
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const text = buffer.slice(0, end).split('\n').find((line) => line.startsWith('data:'))?.slice(5);
        buffer = buffer.slice(end + 2);
        if (!text) continue;
        const event = JSON.parse(text);
        events.push(event);
        if (event.type === 'session.created') sessions.add(event.data.sessionID);
      }
    }
  })().catch((error) => { if (!stream.signal.aborted) errors.push(error.message); });
  await frame.locator('.model-picker-btn').click();
  await frame.locator('.model-picker-item').filter({ hasText: 'UI fixture model' }).click();
  await frame.getByLabel('Select agent', { exact: true }).click();
  await frame.locator('.agent-popover').getByText('Build', { exact: true }).click();
  const composer = frame.locator('[role="textbox"][aria-multiline="true"]').first();
  await composer.fill('UI healthy probe.');
  await composer.press('Enter');
  await expect(frame.locator('.chat-turn-assistant')).toContainText('UI adapter reply.', { timeout: 30000 });
  await expect(frame.locator('.chat-turn-assistant').last()).toBeVisible();
  await frame.page().screenshot({ path: join(root, 'healthy.png') });
  await frame.locator('.model-picker-btn').click();
  await frame.locator('.model-picker-item').filter({ hasText: 'UI preflight failure' }).click();
  await composer.fill('UI failed probe.');
  await composer.press('Enter');
  await expect(frame.locator('.assistant-message-flow-item-error')).toBeVisible({ timeout: 30000 });
  await expect(frame.locator('.chat-turn-user')).toHaveCount(2);
  await frame.page().screenshot({ path: join(root, 'failed-visible.png') });
  await frame.locator('.model-picker-btn').click();
  await frame.locator('.model-picker-item').filter({ hasText: 'UI authorization failure' }).click();
  await composer.fill('UI authentication probe.');
  await composer.press('Enter');
  await expect(frame.locator('.assistant-message-flow-item-error').last()).toContainText('Re-authenticate', { timeout: 30000 });
  await expect(frame.locator('.assistant-message-flow-item-error').last().getByRole('button', { name: 'Re-authenticate', exact: true })).toBeVisible();
  await expect(frame.locator('.chat-turn-user')).toHaveCount(3);
  await expect(frame.locator('.assistant-message-flow-item-error')).toHaveCount(2);
  await frame.page().screenshot({ path: join(root, 'auth-failure.png') });
  await frame.locator('.model-picker-btn').click();
  await frame.locator('.model-picker-item').filter({ hasText: 'UI recovery model' }).click();
  await composer.fill('UI recovery probe.');
  await composer.press('Enter');
  await expect(frame.locator('.chat-turn-assistant').last()).toContainText('UI adapter reply.', { timeout: 30000 });
  await expect(frame.locator('.chat-turn-assistant').last()).toBeVisible();
  await expect(frame.locator('.chat-turn-user')).toHaveCount(4);
  await frame.getByLabel('Back to sessions').first().click();
  await frame.locator('.session-item').first().click();
  await expect(frame.locator('.assistant-message-flow-item-error')).toHaveCount(2, { timeout: 10000 });
  await expect(frame.locator('.chat-turn-user')).toHaveCount(4);
  await frame.page().screenshot({ path: join(root, 'reopened.png') });
  stream.abort();
  const previousFrame = frame;
  await executeVscodeCommand(debugPort, 'Developer: Reload Window');
  await expect.poll(() => previousFrame.isDetached(), { timeout: 15000 }).toBe(true);
  frame = await findFrame();
  await expect(frame.locator('.assistant-message-flow-item-error')).toHaveCount(2, { timeout: 20000 });
  await expect(frame.locator('.chat-turn-user')).toHaveCount(4);
  await frame.page().screenshot({ path: join(root, 'reloaded.png') });
  const renewed = JSON.parse(await readFile(join(tmpdir(), `varro-opencode-server-${port}.json`), 'utf8'));
  const renewedOwner = spawnSync('lsof', ['-t', '-a', '-p', String(renewed.pid), database], { encoding: 'utf8' });
   assert.ok(renewedOwner.stdout.trim().split(/\s+/).includes(String(renewed.pid)));
   ownedServerPids.add(renewed.pid);
  authorization = `Basic ${Buffer.from(`opencode:${renewed.password}`).toString('base64')}`;
   assert.equal((await serverInfo()).pid, renewed.pid);
   await frame.getByLabel('Back to sessions').first().click();
   const activeSession = frame.locator('.session-item:not(.recycle-bin-item)').first();
   await activeSession.click({ button: 'right' });
   await frame.getByText('Move to Recycle Bin', { exact: true }).click();
   await expect(frame.locator('.session-item:not(.recycle-bin-item)')).toHaveCount(0);
   if (await frame.getByLabel('Expand Recycle Bin', { exact: true }).isVisible()) await frame.getByLabel('Expand Recycle Bin', { exact: true }).click();
   await expect(frame.locator('.recycle-bin-item')).toHaveCount(1);
   await frame.locator('.recycle-bin-item').getByLabel('Restore', { exact: true }).click();
   await expect(activeSession).toBeVisible();
   await activeSession.click();
   await expect(frame.locator('.chat-turn-user')).toHaveCount(4);
   await frame.getByLabel('Back to sessions').first().click();
   await activeSession.click({ button: 'right' });
   await frame.getByText('Move to Recycle Bin', { exact: true }).click();
   await expect(frame.locator('.session-item:not(.recycle-bin-item)')).toHaveCount(0);
   if (await frame.getByLabel('Expand Recycle Bin', { exact: true }).isVisible()) await frame.getByLabel('Expand Recycle Bin', { exact: true }).click();
   await frame.locator('.recycle-bin-item').getByLabel('Delete permanently', { exact: true }).click();
   await frame.getByLabel('Confirm permanent delete', { exact: true }).click();
   await expect(frame.locator('.session-item')).toHaveCount(0);
   assert.equal((await api('GET', '/api/session')).data.length, 0);
   await frame.page().screenshot({ path: join(root, 'deleted.png') });
   const legacy = new DatabaseSync(database);
   const unavailable = (await api('POST', '/api/session', { title: 'Unavailable backend fixture', location: { directory: workspace } })).data;
   sessions.add(unavailable.id);
   const unavailableRow = frame.locator('.session-item').filter({ hasText: 'Unavailable backend fixture' });
   await expect(unavailableRow).toBeVisible();
   // Remove only this tracked fixture row without a deletion event, reproducing a stale backend catalog.
   legacy.prepare('DELETE FROM session_v2 WHERE id=?').run(unavailable.id);
   await unavailableRow.click();
   await expect(frame.getByText('This conversation is unavailable on the connected OpenCode server.', { exact: false })).toBeVisible();
   await expect(unavailableRow).toHaveCount(0);
   await expect(frame.getByLabel('Search sessions', { exact: true })).toBeVisible();
   await frame.page().screenshot({ path: join(root, 'unavailable-session.png') });
   legacy.exec(`
     CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, model TEXT);
     CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
     CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT, time_created INTEGER, data TEXT);
   `);
   const seedMessage = (id, sessionID, role, text, at) => {
     const info = { role, time: { created: at }, agent: 'build', providerID: 'fixture', modelID: 'fixture', finish: 'stop', cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } };
     if (role === 'assistant') info.time.completed = at + 1;
     legacy.prepare('INSERT INTO message VALUES (?,?,?,?)').run(id, sessionID, at, JSON.stringify(info));
     legacy.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part_' + id, sessionID, id, at, JSON.stringify({ type: 'text', text }));
   };
   legacy.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('ses_legacy_fixture', null, workspace, 'Legacy fixture root', 1, 4, JSON.stringify({ providerID: 'fixture', modelID: 'fixture' }));
   legacy.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('ses_legacy_child', 'ses_legacy_fixture', workspace, 'Legacy fixture child', 2, 3, null);
   seedMessage('msg_legacy_user', 'ses_legacy_fixture', 'user', 'Legacy question.', 1);
   seedMessage('msg_legacy_assistant', 'ses_legacy_fixture', 'assistant', 'Imported v1 answer.', 4);
   seedMessage('msg_child_user', 'ses_legacy_child', 'user', 'Inspect a fixture.', 2);
   seedMessage('msg_child_assistant', 'ses_legacy_child', 'assistant', 'Child fixture result.', 3);
   legacy.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run('part_tool_fixture', 'ses_legacy_fixture', 'msg_legacy_assistant', 3, JSON.stringify({ type: 'tool', callID: 'call_legacy', tool: 'task', state: { status: 'completed', input: { prompt: 'Inspect a fixture.' }, output: 'Child fixture result.', metadata: { sessionId: 'ses_legacy_child' }, time: { start: 2, end: 3 } } }));
   const legacySnapshot = () => JSON.stringify(['session', 'message', 'part'].map(table => legacy.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
   const beforeImport = legacySnapshot();
   const beforeProviderRequests = requests.length;
   await executeVscodeCommand(debugPort, 'Varro: Import OpenCode v1 Session into v2');
   await frame.page().locator('.quick-input-widget').getByText('Legacy fixture root', { exact: true }).click();
   await expect(frame.locator('.chat-turn-assistant')).toContainText('Imported v1 answer.', { timeout: 30000 });
   assert.equal(requests.length, beforeProviderRequests, 'Import must not execute historical tools or start a model turn');
   const imported = (await api('GET', '/api/session')).data;
   assert.equal(imported.length, 2);
   for (const session of imported) sessions.add(session.id);
   const importedRoot = imported.find(session => !session.parentID);
   assert.ok(importedRoot && importedRoot.id !== 'ses_legacy_fixture');
   assert.equal(imported.find(session => session.parentID)?.parentID, importedRoot.id);
   const importedMessages = (await api('GET', `/api/session/${importedRoot.id}/message`)).data;
   assert.ok(importedMessages.every(message => !message.id.startsWith('msg_legacy_')));
   await frame.page().screenshot({ path: join(root, 'imported.png') });
   await frame.locator('[role="textbox"][aria-multiline="true"]').first().fill('Continue the imported conversation.');
   await frame.locator('[role="textbox"][aria-multiline="true"]').first().press('Enter');
   await expect(frame.locator('.chat-turn-assistant').last()).toContainText('UI adapter reply.', { timeout: 30000 });
   assert.equal(legacySnapshot(), beforeImport, 'Import and continuation changed the original v1 history');
   legacy.close();
   await frame.page().screenshot({ path: join(root, 'import-continued.png') });
   await frame.getByLabel('Back to sessions').first().click();
   await frame.locator('.session-item').filter({ hasText: 'Legacy fixture root (v1 copy)' }).first().click();
   await expect(frame.locator('.chat-turn-assistant')).toContainText(['Imported v1 answer.', 'UI adapter reply.']);
   const importedFrame = frame;
   await executeVscodeCommand(debugPort, 'Developer: Reload Window');
   await expect.poll(() => importedFrame.isDetached(), { timeout: 15000 }).toBe(true);
   frame = await findFrame();
   await expect(frame.locator('.chat-turn-assistant')).toContainText(['Imported v1 answer.', 'UI adapter reply.'], { timeout: 20000 });
   const importedLease = JSON.parse(await readFile(join(tmpdir(), `varro-opencode-server-${port}.json`), 'utf8'));
   assert.ok(spawnSync('lsof', ['-t', '-a', '-p', String(importedLease.pid), database], { encoding: 'utf8' }).stdout.trim().split(/\s+/).includes(String(importedLease.pid)));
   ownedServerPids.add(importedLease.pid);
   authorization = `Basic ${Buffer.from(`opencode:${importedLease.password}`).toString('base64')}`;
   await frame.page().screenshot({ path: join(root, 'import-reloaded.png') });
   outcome = { passed: true };
} catch (error) {
  outcome = { passed: false, error: error.stack };
  if (browser) await writeFile(join(root, 'frames.json'), JSON.stringify(browser.contexts().flatMap((context) => context.pages()).map((page) => ({ url: page.url(), frames: page.frames().map((candidate) => candidate.url()) })), null, 2));
  if (frame) {
    await writeFile(join(root, 'dom.txt'), await frame.locator('body').innerText().catch(() => 'Frame closed'));
    await frame.page().screenshot({ path: join(root, 'failure.png') }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
   stream.abort();
   try {
     const cleanupLease = JSON.parse(await readFile(join(tmpdir(), `varro-opencode-server-${port}.json`), 'utf8'));
     if (ownsDatabase(cleanupLease.pid)) {
       ownedServerPids.add(cleanupLease.pid);
       authorization = `Basic ${Buffer.from(`opencode:${cleanupLease.password}`).toString('base64')}`;
     }
   } catch (error) { if (error.code !== 'ENOENT') errors.push(`Could not read fixture lease: ${error.message}`); }
   if (authorization) {
     const inventory = await api('GET', '/api/session').catch(() => ({ data: [] }));
     for (const session of inventory.data) {
       if (['ses_legacy_fixture', 'ses_legacy_child'].includes(session.metadata?.varroLegacyImport?.sourceSessionID)) sessions.add(session.id);
     }
   }
  for (const sessionID of sessions) {
    try { await api('DELETE', `/api/session/${sessionID}`); } catch (error) { errors.push(`Cleanup ${sessionID}: ${error.message}`); }
  }
  if (authorization) {
    try {
      const remaining = await api('GET', '/api/session');
      if (remaining.data.length) errors.push(`Fixture sessions remain: ${remaining.data.map((session) => session.id).join(', ')}`);
    } catch (error) { errors.push(`Could not verify fixture cleanup: ${error.message}`); }
  }
  await browser?.close();
  code.kill('SIGTERM');
  await Promise.race([new Promise((done) => code.once('exit', done)), delay(3000)]);
   if (code.exitCode === null && code.signalCode === null) code.kill('SIGKILL');
   for (const pid of ownedServerPids) {
     if (!ownsDatabase(pid)) continue;
     process.kill(pid, 'SIGTERM');
     for (let attempt = 0; attempt < 20 && ownsDatabase(pid); attempt++) await delay(100);
     if (ownsDatabase(pid)) process.kill(pid, 'SIGKILL');
     for (let attempt = 0; attempt < 20 && ownsDatabase(pid); attempt++) await delay(100);
     if (ownsDatabase(pid)) errors.push(`Fixture server ${pid} did not stop`);
   }
  provider.closeAllConnections();
  await new Promise((done) => provider.close(done));
  if (errors.length) { outcome.passed = false; process.exitCode = 1; }
  await writeFile(join(root, 'result.json'), JSON.stringify({ ...outcome, database, requests, errors }, null, 2));
  await writeFile(join(root, 'events.json'), JSON.stringify(events, null, 2));
  process.stdout.write(`${JSON.stringify({ ...outcome, artifacts: root, errors })}\n`);
}
