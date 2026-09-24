import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { AiOpenCodeClient } from './ai-opencode-client.mjs';

async function serve(t, handler) {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    response.setHeader('content-type', 'application/json');
    handler(request, response, text ? JSON.parse(text) : undefined);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('v1 keeps directory scoping and original prompt contract', async (t) => {
  const requests = [];
  const url = await serve(t, (request, response, body) => {
    requests.push({
      method: request.method,
      url: request.url,
      directory: request.headers['x-opencode-directory'],
      body,
    });
    response.end(
      JSON.stringify(
        request.url === '/global/health'
          ? { healthy: true, version: '1.18.32' }
          : { id: 'ses_fixture' }
      )
    );
  });
  const client = new AiOpenCodeClient(url, '/fixture with spaces');
  const body = {
    parts: [{ type: 'text', text: 'marked prompt' }],
    model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
  };
  await client.request('POST', '/session/ses_fixture/prompt_async', body);
  assert.deepEqual(client.backend, { apiVersion: 1, version: '1.18.32' });
  assert.deepEqual(requests.at(-1), {
    method: 'POST',
    url: '/session/ses_fixture/prompt_async?directory=%2Ffixture+with+spaces',
    directory: '/fixture with spaces',
    body,
  });
});

test('v2 maps preparation, prompts, status, pending input, fork and cleanup to native routes', async (t) => {
  const requests = [];
  const session = {
    id: 'ses_fixture',
    title: 'VFZ unit',
    location: { directory: '/fixture' },
    time: { created: 1, updated: 2 },
  };
  const url = await serve(t, (request, response, body) => {
    const route = new URL(request.url, 'http://localhost').pathname;
    requests.push({ method: request.method, route, body });
    if (route === '/global/health') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html>');
      return;
    }
    if (route === '/api/status') {
      response.end(JSON.stringify({ ready: true, version: '2.0.15' }));
      return;
    }
    let data = session;
    if (route === '/api/session' && request.method === 'GET') data = [session];
    if (
      route.endsWith('/message') ||
      route.endsWith('/inbox') ||
      route === '/api/permission/request' ||
      route === '/api/form' ||
      route === '/api/shell'
    )
      data = [];
    if (route === '/api/session/active') data = { ses_fixture: { type: 'running' } };
    response.end(JSON.stringify({ data }));
  });
  const client = new AiOpenCodeClient(url, '/fixture');
  assert.equal((await client.request('POST', '/session', { title: session.title })).id, session.id);
  assert.equal((await client.request('GET', '/session?roots=true&limit=1000'))[0].id, session.id);
  await client.request('PATCH', '/session/ses_fixture', { title: 'VFZ renamed' });
  await client.request('POST', '/session/ses_fixture/prompt_async', {
    parts: [{ type: 'text', text: 'marked prompt' }],
    model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
  });
  assert.deepEqual(await client.request('GET', '/session/ses_fixture/message?limit=1000'), []);
  assert.deepEqual(await client.request('GET', '/session/status'), {
    ses_fixture: { type: 'busy' },
  });
  assert.deepEqual(await client.request('GET', '/permission'), []);
  assert.deepEqual(await client.request('GET', '/question'), []);
  await client.request('POST', '/session/ses_fixture/fork');
  await client.request('POST', '/session/ses_fixture/abort');
  await client.request('DELETE', '/session/ses_fixture');
  assert.ok(
    requests.some(
      (r) => r.route === '/api/session/ses_fixture/model' && r.body.model.id === 'gpt-5.6-luna'
    )
  );
  assert.ok(
    requests.some(
      (r) => r.route === '/api/session/ses_fixture/prompt' && r.body.text === 'marked prompt'
    )
  );
  assert.ok(requests.some((r) => r.route === '/api/session/ses_fixture/interrupt'));
  assert.ok(requests.some((r) => r.method === 'DELETE' && r.route === '/api/session/ses_fixture'));
  assert.ok(requests.every((r) => r.route === '/global/health' || r.route.startsWith('/api/')));
});

test('authentication failures and unknown versions cannot fall through to a different backend', async (t) => {
  const requests = [];
  const url = await serve(t, (request, response) => {
    requests.push(request.url);
    response.writeHead(401);
    response.end('{}');
  });
  await assert.rejects(
    new AiOpenCodeClient(url, '/fixture').request('POST', '/session', {}),
    /HTTP 401/
  );
  assert.deepEqual(requests, ['/global/health']);
  const unknown = await serve(t, (_request, response) =>
    response.end(JSON.stringify({ healthy: true, version: '3.0.0' }))
  );
  await assert.rejects(
    new AiOpenCodeClient(unknown, '/fixture').request('POST', '/session', {}),
    /Invalid OpenCode backend identity/
  );
});
