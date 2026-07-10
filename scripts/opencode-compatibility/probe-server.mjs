import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const TESTED_VERSION = process.env.TESTED_OPENCODE_VERSION || 'unknown';
const BASE_URL = 'http://127.0.0.1:4096';
const DIRECTORY = '/workspace';
const RESULT_PREFIX = 'VARRO_COMPAT_RESULT=';
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const BASE_CONFIG_PATH = '/tmp/varro-opencode-base.json';
const INLINE_CONFIG_CONTENT = JSON.stringify({ compaction: { reserved: 3333 } });

const checks = [];
let serverOutput = '';

await writeFile(
  BASE_CONFIG_PATH,
  `${JSON.stringify({ compaction: { auto: false, reserved: 1111 } }, null, 2)}\n`
);
await writeFile(
  `${DIRECTORY}/opencode.jsonc`,
  '{\n  // Project config must override Varro\'s pre-project layer.\n  "compaction": { "auto": true, "reserved": 2222 },\n}\n'
);

const server = spawn('opencode', ['serve', '--hostname', '0.0.0.0', '--port', '4096'], {
  env: {
    ...process.env,
    OPENCODE_CONFIG: BASE_CONFIG_PATH,
    OPENCODE_CONFIG_CONTENT: INLINE_CONFIG_CONTENT,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput = `${serverOutput}${chunk.toString()}`.slice(-20_000);
  });
}

let serverExit;
server.once('exit', (code, signal) => {
  serverExit = { code, signal };
});

function scopedUrl(path) {
  const url = new URL(path, BASE_URL);
  if (!url.pathname.startsWith('/global/')) {
    url.searchParams.set('directory', DIRECTORY);
    if (url.pathname.startsWith('/api/')) {
      url.searchParams.set('location[directory]', DIRECTORY);
    }
  }
  return url;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForServer() {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = 'server did not respond';
  while (Date.now() < deadline) {
    if (serverExit) {
      throw new Error(
        `server exited before becoming healthy (${serverExit.code ?? serverExit.signal ?? 'unknown'})`
      );
    }
    try {
      const response = await fetchWithTimeout(`${BASE_URL}/global/health`);
      if (response.ok) return;
      lastError = `health returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server startup timed out: ${lastError}`);
}

async function request(name, method, path, options = {}) {
  const startedAt = Date.now();
  try {
    const headers = { 'x-opencode-directory': DIRECTORY };
    const init = { method, headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetchWithTimeout(scopedUrl(path), init);
    const text = await response.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    if (!response.ok) {
      throw new Error(
        `${response.status} ${response.statusText}${text ? `: ${text.slice(0, 300)}` : ''}`
      );
    }
    if (options.validate && !options.validate(data)) {
      throw new Error(`unexpected response shape: ${text.slice(0, 300)}`);
    }
    checks.push({ name, ok: true, durationMs: Date.now() - startedAt });
    return data;
  } catch (error) {
    checks.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function isRouteSpecificMissingRequest(status, text, path, requestKind, missingRequestId) {
  if (status !== 400 && status !== 404) return false;
  const normalized = text.toLowerCase();
  const withoutRoute = normalized.replaceAll(path.toLowerCase(), '');
  const withoutSyntheticId = withoutRoute.replaceAll(missingRequestId.toLowerCase(), '');
  return (
    withoutSyntheticId.includes(requestKind) &&
    /\b(?:missing|not found|does not exist|unknown)\b/.test(withoutSyntheticId)
  );
}

async function requestExpectedMissingRequest(
  name,
  method,
  path,
  requestKind,
  missingRequestId,
  options = {}
) {
  const startedAt = Date.now();
  try {
    const headers = { 'x-opencode-directory': DIRECTORY };
    const init = { method, headers };
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
    const response = await fetchWithTimeout(scopedUrl(path), init);
    const text = await response.text();
    if (response.ok) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`${response.status} returned a non-JSON ${requestKind} reply result`);
      }
      if (typeof data !== 'boolean') {
        throw new Error(`${response.status} returned a non-boolean ${requestKind} reply result`);
      }
      checks.push({ name, ok: true, durationMs: Date.now() - startedAt });
      return;
    }
    if (!isRouteSpecificMissingRequest(response.status, text, path, requestKind, missingRequestId)) {
      if (response.status === 400) {
        checks.push({
          name,
          ok: false,
          required: false,
          advisory: true,
          durationMs: Date.now() - startedAt,
          error: '400 response did not expose a route-specific missing-request contract',
        });
        return;
      }
      throw new Error(`${response.status} did not identify a missing ${requestKind} request`);
    }
    checks.push({
      name,
      ok: true,
      required: false,
      advisory: true,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      required: true,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readFirstSsePayload(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('event stream response has no body');
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      let match = /\r?\n\r?\n/.exec(buffer);
      while (match) {
        const chunk = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = chunk
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) return JSON.parse(data);
        match = /\r?\n\r?\n/.exec(buffer);
      }

      const { value, done } = await reader.read();
      if (done) throw new Error('event stream closed before its first payload');
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function checkEventStream() {
  const name = 'GET /api/event provides direct server.connected SSE payload';
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(scopedUrl('/api/event'), {
      headers: {
        accept: 'text/event-stream',
        'x-opencode-directory': DIRECTORY,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      throw new Error(`unexpected content-type: ${contentType || 'missing'}`);
    }
    const payload = await readFirstSsePayload(response);
    const properties = isRecord(payload?.properties)
      ? payload.properties
      : isRecord(payload?.data)
        ? payload.data
        : null;
    if (
      !isRecord(payload) ||
      typeof payload.id !== 'string' ||
      payload.type !== 'server.connected' ||
      !properties ||
      'payload' in payload
    ) {
      throw new Error(`unexpected SSE payload: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    checks.push({ name, ok: true, durationMs: Date.now() - startedAt });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function runProbe() {
  await waitForServer();

  const health = await request('GET /global/health', 'GET', '/global/health', {
    validate: (value) =>
      isRecord(value) && value.healthy === true && typeof value.version === 'string',
  });
  await request('GET /session', 'GET', '/session', { validate: Array.isArray });
  await request('GET /session/status', 'GET', '/session/status', { validate: isRecord });
  await request('GET /question', 'GET', '/question', { validate: Array.isArray });
  await request('GET /permission', 'GET', '/permission', { validate: Array.isArray });
  await request('GET /config/providers', 'GET', '/config/providers', {
    validate: (value) =>
      isRecord(value) && Array.isArray(value.providers) && isRecord(value.default),
  });
  await request('GET /config honors custom, project, then inline precedence', 'GET', '/config', {
    validate: (value) =>
      isRecord(value) &&
      isRecord(value.compaction) &&
      value.compaction.auto === true &&
      value.compaction.reserved === 3333,
  });
  await request('GET /provider/auth', 'GET', '/provider/auth', { validate: isRecord });
  await request('GET /command', 'GET', '/command', { validate: Array.isArray });
  await request('GET /mcp', 'GET', '/mcp', { validate: isRecord });
  await request('GET /file/status', 'GET', '/file/status', { validate: Array.isArray });
  await request('GET /agent', 'GET', '/agent', { validate: Array.isArray });
  await request('GET /experimental/workspace/status', 'GET', '/experimental/workspace/status', {
    validate: Array.isArray,
  });
  await checkEventStream();

  let sessionID;
  try {
    const session = await request('POST /session', 'POST', '/session', {
      body: { title: 'Varro compatibility probe' },
      validate: (value) => isRecord(value) && typeof value.id === 'string',
    });
    sessionID = isRecord(session) && typeof session.id === 'string' ? session.id : undefined;
    if (sessionID) {
      const encodedID = encodeURIComponent(sessionID);
      await request('GET /session/:id', 'GET', `/session/${encodedID}`, {
        validate: (value) => isRecord(value) && value.id === sessionID,
      });
      await request('PATCH /session/:id', 'PATCH', `/session/${encodedID}`, {
        body: { title: 'Varro compatibility probe renamed' },
        validate: isRecord,
      });
      await request(
        'GET /session/:id/message with pagination',
        'GET',
        `/session/${encodedID}/message?limit=1`,
        {
          validate: Array.isArray,
        }
      );
      await request('GET /session/:id/todo', 'GET', `/session/${encodedID}/todo`, {
        validate: Array.isArray,
      });
      await request('GET /session/:id/diff', 'GET', `/session/${encodedID}/diff`, {
        validate: Array.isArray,
      });
      await request(
        'POST /session/:id/prompt_async noReply',
        'POST',
        `/session/${encodedID}/prompt_async`,
        {
          body: {
            noReply: true,
            parts: [{ type: 'text', text: 'Varro compatibility probe' }],
          },
          validate: (value) => value === null,
        }
      );
      await request('POST /session/:id/abort', 'POST', `/session/${encodedID}/abort`, {
        validate: (value) => value === true,
      });
      await requestExpectedMissingRequest(
        'POST /permission/:id/reply accepts reply payload (advisory)',
        'POST',
        '/permission/varro-missing-permission/reply',
        'permission',
        'varro-missing-permission',
        { body: { reply: 'reject' } }
      );
      await requestExpectedMissingRequest(
        'POST /question/:id/reply accepts answers payload (advisory)',
        'POST',
        '/question/varro-missing-question/reply',
        'question',
        'varro-missing-question',
        { body: { answers: [['No']] } }
      );
    }
  } finally {
    if (sessionID) {
      await request('DELETE /session/:id', 'DELETE', `/session/${encodeURIComponent(sessionID)}`, {
        validate: (value) => typeof value === 'boolean',
      });
    }
  }

  return {
    requestedVersion: TESTED_VERSION,
    serverVersion: isRecord(health) && typeof health.version === 'string' ? health.version : null,
    compatible: checks.every((check) => check.required === false || check.ok),
    checks,
  };
}

let result;
let exitCode = 2;
try {
  result = await runProbe();
  exitCode = result.compatible ? 0 : 1;
} catch (error) {
  result = {
    requestedVersion: TESTED_VERSION,
    serverVersion: null,
    compatible: false,
    harnessError: error instanceof Error ? error.message : String(error),
    checks,
    serverOutput,
  };
} finally {
  if (!serverExit) server.kill('SIGTERM');
}

// oxlint-disable-next-line no-console
console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
process.exitCode = exitCode;
