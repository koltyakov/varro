import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { createStreamingServer } from './ai-streaming-server.mjs';

const directory = '/isolated/replay fixture';
const info = {
  id: 'msg_1',
  sessionID: 'ses_source',
  role: 'assistant',
  time: { created: 1 },
  path: { cwd: '/source', root: '/source' },
};
const part = { id: 'prt_1', messageID: info.id, sessionID: info.sessionID, type: 'text', text: '' };
const event = (type, properties) => ({ type, properties });
const delta = (text) =>
  event('message.part.delta', {
    sessionID: info.sessionID,
    messageID: info.id,
    partID: part.id,
    field: 'text',
    delta: text,
  });

function fixture() {
  return {
    directory,
    capture: {
      session: {
        id: info.sessionID,
        parentID: 'source-parent',
        projectID: 'source-project',
        directory: '/source',
        title: 'Replay',
        version: '1',
        time: { created: 1, updated: 1 },
      },
      initialMessages: [{ info, parts: [part] }],
      finalMessages: [{ info, parts: [{ ...part, text: 'hello world' }] }],
    },
    timeline: [
      { delayMs: 20, event: delta('hello') },
      { delayMs: 180, event: delta(' world') },
    ],
  };
}

async function connect(server, t) {
  const request = http.get(`${server.url}/global/event`);
  t.after(() => request.destroy());
  const [response] = await once(request, 'response');
  assert.match(response.headers['content-type'], /text\/event-stream/);
  response.setEncoding('utf8');
  let buffer = '';
  const events = [];
  response.on('data', (chunk) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
    }
  });
  return { response, events };
}

async function waitFor(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Timed out waiting for SSE');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('real SDK bootstrap, HTTP partial snapshots, SSE remapping and canonical completion', async (t) => {
  const input = fixture();
  const original = structuredClone(input);
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  assert.ok(server.port > 0);
  assert.throws(() => server.start(), /subscriber/);
  const client = createOpencodeClient({ baseUrl: server.url, directory });
  const { data: catalog } = await client.session.list();
  const id = catalog[0].id;
  assert.notEqual(id, info.sessionID);
  assert.equal(catalog[0].directory, directory);
  assert.equal(catalog[0].parentID, undefined);
  assert.deepEqual((await client.session.get({ sessionID: id })).data, catalog[0]);
  for (const route of [
    '/global/health',
    '/config',
    '/global/config',
    '/config/providers',
    '/provider',
    '/provider/auth',
    '/path',
    '/project',
    '/project/current',
    '/agent',
    '/command',
    '/mcp',
    '/permission',
    '/question',
    '/lsp',
    '/formatter',
    '/vcs/status',
    '/skill',
  ]) {
    assert.equal((await fetch(server.url + route)).status, 200, route);
  }
  assert.deepEqual((await client.session.status()).data, {});
  const snapshot = async () => (await client.session.messages({ sessionID: id })).data;
  assert.equal((await snapshot())[0].parts[0].text, '');
  assert.equal((await snapshot())[0].info.path.cwd, directory);
  const stream = await connect(server, t);
  const second = await connect(server, t);
  const run = server.start();
  assert.throws(() => server.start(), /already started/);
  await waitFor(() => stream.events.length === 1);
  assert.equal((await snapshot())[0].parts[0].text, 'hello');
  assert.deepEqual(stream.events[0], {
    directory,
    payload: { ...delta('hello'), properties: { ...delta('hello').properties, sessionID: id } },
  });
  const result = await run;
  await waitFor(() => second.events.length === 2);
  assert.equal(result.state, 'completed');
  assert.equal(result.canonicalMatch, true);
  assert.equal((await snapshot())[0].parts[0].text, 'hello world');
  assert.deepEqual(
    result.scheduler.timings.map((entry) => entry.scheduledMs),
    [20, 200]
  );
  assert.ok(result.scheduler.timings.every((entry) => entry.actualMs >= entry.scheduledMs));
  assert.equal(result.scheduler.appliedEvents, 2);
  result.finalMessages[0].parts[0].text = 'external mutation';
  assert.equal(server.getResult().canonicalMatch, true);
  assert.deepEqual(input, original);
  assert.throws(() => server.start(), /already started/);
});

test('message pagination uses SDK arrays and opaque headers, rejects bad cursors', async (t) => {
  const input = fixture();
  input.timeline = [];
  input.capture.initialMessages = Array.from({ length: 5 }, (_, index) => ({
    info: { ...info, id: `msg_${index}` },
    parts: [],
  }));
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  const base = `${server.url}/session/${server.getResult().sessionID}/message`;
  let response = await fetch(`${base}?limit=2`);
  assert.deepEqual(
    (await response.json()).map((entry) => entry.info.id),
    ['msg_3', 'msg_4']
  );
  assert.match(response.headers.get('link'), /rel="next"/);
  const cursor = response.headers.get('x-next-cursor');
  response = await fetch(`${base}?limit=2&before=${cursor}`);
  assert.deepEqual(
    (await response.json()).map((entry) => entry.info.id),
    ['msg_1', 'msg_2']
  );
  response = await fetch(`${base}?limit=2&before=${response.headers.get('x-next-cursor')}`);
  assert.deepEqual(
    (await response.json()).map((entry) => entry.info.id),
    ['msg_0']
  );
  assert.equal(response.headers.get('x-next-cursor'), null);
  for (const query of ['limit=0', 'limit=1.5', 'limit=2&before=unknown', `before=${cursor}`]) {
    assert.equal((await fetch(`${base}?${query}`)).status, 400);
  }
  assert.equal((await fetch(`${server.url}/session/ses_source`)).status, 404);
  assert.equal((await fetch(`${base}?directory=/source`)).status, 404);
  assert.equal(
    (await fetch(base, { headers: { 'x-opencode-directory': encodeURIComponent(directory) } }))
      .status,
    200
  );
});

test('rejects every mutation method and unknown reads without changing replay state', async (t) => {
  const server = await createStreamingServer(fixture());
  t.after(() => server.close());
  const before = server.getResult();
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    for (const route of [
      '/session',
      '/config',
      '/global/config',
      '/global/dispose',
      '/auth/provider',
      `/session/${before.sessionID}/prompt_async`,
      `/session/${before.sessionID}/abort`,
      '/mcp/name/auth',
    ]) {
      const response = await fetch(server.url + route, { method });
      assert.equal(response.status, 405, `${method} ${route}`);
      assert.equal(response.headers.get('allow'), 'GET');
      await response.arrayBuffer();
    }
  }
  assert.equal((await fetch(`${server.url}/file/content?path=/etc/passwd`)).status, 404);
  assert.deepEqual(server.getResult(), before);
});

test('close cancels long waits, closes SSE and idle sockets, and is idempotent', async (t) => {
  const input = fixture();
  input.timeline[0].delayMs = 60_000;
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  const stream = await connect(server, t);
  const idle = net.createConnection({ host: '127.0.0.1', port: server.port });
  t.after(() => idle.destroy());
  await once(idle, 'connect');
  idle.on('error', () => {});
  const idleClosed = new Promise((resolve) => idle.once('close', resolve));
  const run = server.start();
  // Destroying an active SSE socket intentionally produces ECONNRESET at the client.
  stream.response.on('error', () => {});
  const closed = new Promise((resolve) => stream.response.once('close', resolve));
  const started = performance.now();
  const closing = server.close();
  assert.equal(server.close(), closing);
  await closing;
  await closed;
  await idleClosed;
  assert.ok(performance.now() - started < 1000);
  const result = await run;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.canonicalMatch, null);
  assert.equal(result.scheduler.appliedEvents, 0);
  assert.equal(stream.events.length, 0);
  assert.throws(() => server.start(), /closed/);
  await assert.rejects(fetch(server.url));
});

test('upfront rejection covers unsupported captured and timeline events, routing and ordering', async () => {
  for (const bad of [
    event('permission.asked', { sessionID: info.sessionID }),
    { ...delta('bad'), properties: { ...delta('bad').properties, sessionID: 'foreign' } },
    { ...delta('bad'), properties: { ...delta('bad').properties, partID: 'missing' } },
    { ...delta('bad'), properties: { ...delta('bad').properties, field: '__proto__' } },
  ]) {
    const input = fixture();
    input.timeline = [{ delayMs: 0, event: bad }];
    await assert.rejects(createStreamingServer(input));
  }
  const input = fixture();
  input.capture.events = [{ event: event('unknown', {}) }];
  await assert.rejects(createStreamingServer(input), /Unsupported capture event/);
  delete input.capture.events;
  input.timeline[0].delayMs = -1;
  await assert.rejects(createStreamingServer(input), /delayMs/);
});

test('reducers preserve partial info, replace tool/todo/diff snapshots and apply removals', async (t) => {
  const input = fixture();
  const tool = {
    ...part,
    id: 'tool',
    type: 'tool',
    tool: 'bash',
    state: { status: 'running', input: { command: 'NEVER EXECUTED' } },
  };
  const properties = { sessionID: info.sessionID };
  const todos = [{ content: 'Captured task', status: 'completed', priority: 'high' }];
  const diff = [
    { file: '/source/file', before: '', after: 'captured', additions: 1, deletions: 0 },
  ];
  input.timeline = [
    event('session.status', { ...properties, status: { type: 'busy' } }),
    event('message.updated', { info: { id: info.id, ...properties, finish: 'stop' } }),
    event('message.part.updated', { part: tool }),
    event('message.part.updated', {
      part: { ...tool, state: { status: 'completed', output: 'captured' } },
    }),
    event('todo.updated', { ...properties, todos }),
    event('session.diff', { ...properties, diff }),
    event('session.updated', { info: { id: info.sessionID, title: 'Changed' } }),
    event('message.part.removed', { ...properties, messageID: info.id, partID: part.id }),
    event('message.updated', { info: { ...info, id: 'temporary' } }),
    event('message.removed', { ...properties, messageID: 'temporary' }),
    event('session.idle', properties),
  ].map((entry) => ({ delayMs: 0, event: entry }));
  input.capture.finalMessages = [
    {
      info: { ...info, finish: 'stop' },
      parts: [{ ...tool, state: { status: 'completed', output: 'captured' } }],
    },
  ];
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  await connect(server, t);
  const result = await server.start();
  assert.equal(result.canonicalMatch, true);
  const base = `${server.url}/session/${result.sessionID}`;
  assert.deepEqual(await (await fetch(`${base}/todo`)).json(), todos);
  assert.deepEqual(await (await fetch(`${base}/diff`)).json(), diff);
  assert.equal((await (await fetch(base)).json()).title, 'Changed');
  assert.deepEqual(await (await fetch(`${server.url}/session/status`)).json(), {});
});

test('canonical mismatch is reported, never substituted with the expected transcript', async (t) => {
  const input = fixture();
  input.timeline = [];
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  await connect(server, t);
  const result = await server.start();
  assert.equal(result.state, 'completed');
  assert.equal(result.canonicalMatch, false);
  assert.equal(result.finalMessages[0].parts[0].text, '');
  assert.equal(result.expectedMessages[0].parts[0].text, 'hello world');
});

test('subscriber loss fails instead of silently claiming delivery', async (t) => {
  const server = await createStreamingServer(fixture());
  t.after(() => server.close());
  const stream = await connect(server, t);
  const run = server.start();
  stream.response.destroy();
  const result = await run;
  assert.equal(result.state, 'failed');
  assert.match(result.error, /disconnected/);
  assert.equal(result.canonicalMatch, null);
});

test('SDK global SSE parser receives the directory envelope and current status snapshots', async (t) => {
  const input = fixture();
  input.timeline = [
    {
      delayMs: 0,
      event: event('session.status', { sessionID: info.sessionID, status: { type: 'busy' } }),
    },
    { delayMs: 150, event: event('session.idle', { sessionID: info.sessionID }) },
  ];
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  const controller = new AbortController();
  t.after(() => controller.abort());
  let connected;
  const ready = new Promise((resolve) => {
    connected = resolve;
  });
  const client = createOpencodeClient({
    baseUrl: server.url,
    fetch: async (request) => {
      const response = await fetch(request);
      connected();
      return response;
    },
  });
  const subscription = await client.global.event({ signal: controller.signal });
  const next = subscription.stream.next();
  await ready;
  const run = server.start();
  const { value } = await next;
  const id = server.getResult().sessionID;
  assert.deepEqual(value, {
    directory,
    payload: event('session.status', { sessionID: id, status: { type: 'busy' } }),
  });
  assert.deepEqual(await (await fetch(`${server.url}/session/status`)).json(), {
    [id]: { type: 'busy' },
  });
  await run;
  controller.abort();
  await subscription.stream.return();
});

test('absolute deadlines catch up after event-loop delay rather than adding another gap', async (t) => {
  const server = await createStreamingServer(fixture());
  t.after(() => server.close());
  await connect(server, t);
  const run = server.start();
  const blockedUntil = performance.now() + 250;
  while (performance.now() < blockedUntil) {
    /* Simulate synchronous host work. */
  }
  const result = await run;
  const [first, second] = result.scheduler.timings;
  assert.equal(result.canonicalMatch, true);
  assert.ok(first.latenessMs >= 200);
  assert.ok(
    second.actualMs - first.actualMs < 90,
    'No fresh 180ms relative wait after the delayed first event'
  );
});

test('zero-gap bursts yield so cancellation can interrupt playback', async (t) => {
  const input = fixture();
  input.timeline = Array.from({ length: 10_000 }, () => ({
    delayMs: 0,
    event: event('session.status', { sessionID: info.sessionID, status: { type: 'busy' } }),
  }));
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  await connect(server, t);
  const run = server.start();
  setImmediate(() => {
    void server.close();
  });
  const result = await run;
  assert.equal(result.state, 'cancelled');
  assert.ok(result.scheduler.appliedEvents < 10_000);
});

test('oversized SSE output fails explicitly instead of accumulating an unbounded buffer', async (t) => {
  const input = fixture();
  input.timeline[0].event.properties.delta = 'x'.repeat(8 * 1024 * 1024);
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  await connect(server, t);
  const result = await server.start();
  assert.equal(result.state, 'failed');
  assert.match(result.error, /output buffer limit/);
});

test('older-page cursors survive message removal without admitting newly appended messages', async (t) => {
  const input = fixture();
  input.capture.initialMessages = Array.from({ length: 4 }, (_, index) => ({
    info: { ...info, id: `msg_${index}` },
    parts: [],
  }));
  input.timeline = [
    {
      delayMs: 0,
      event: event('message.removed', { sessionID: info.sessionID, messageID: 'msg_0' }),
    },
    { delayMs: 0, event: event('message.updated', { info: { ...info, id: 'new' } }) },
  ];
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  const base = `${server.url}/session/${server.getResult().sessionID}/message`;
  const response = await fetch(`${base}?limit=2`);
  await response.json();
  const cursor = response.headers.get('x-next-cursor');
  await connect(server, t);
  await server.start();
  const page = await (await fetch(`${base}?limit=2&before=${cursor}`)).json();
  assert.deepEqual(
    page.map((message) => message.info.id),
    ['msg_1']
  );
});

test('closing between events preserves partial state; closing a completed run preserves metrics', async (t) => {
  const input = fixture();
  input.timeline[1].delayMs = 60_000;
  const server = await createStreamingServer(input);
  t.after(() => server.close());
  const stream = await connect(server, t);
  const run = server.start();
  await waitFor(() => stream.events.length === 1);
  await server.close();
  const result = await run;
  assert.equal(result.state, 'cancelled');
  assert.equal(result.scheduler.appliedEvents, 1);
  assert.equal(result.finalMessages[0].parts[0].text, 'hello');

  input.timeline = [];
  const completed = await createStreamingServer(input);
  t.after(() => completed.close());
  await connect(completed, t);
  const final = await completed.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await completed.close();
  assert.deepEqual(completed.getResult(), final);
});
