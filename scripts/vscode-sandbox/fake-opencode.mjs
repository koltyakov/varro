#!/usr/bin/env node

import http from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const mode = process.env.VARRO_SANDBOX_FAKE_MODE || 'healthy';
const version = process.env.VARRO_SANDBOX_FAKE_VERSION || '1.18.15';

if (args.includes('--version') && mode === 'version-error') {
  process.stderr.write('Simulated OpenCode version lookup failure.\n');
  process.exit(3);
}

if (args.includes('--version') && mode === 'malformed-version') {
  process.stdout.write('OpenCode development build\n');
  process.exit(0);
}

if (args.includes('--version')) {
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

if (args[0] === 'upgrade') {
  if (mode === 'upgrade-no-change') process.exit(0);
  process.stderr.write('The fake OpenCode CLI does not perform upgrades.\n');
  process.exit(1);
}

if (args[0] !== 'serve') {
  process.stderr.write(`Unsupported fake OpenCode arguments: ${args.join(' ')}\n`);
  process.exit(2);
}

const launchFile = process.env.VARRO_SANDBOX_LAUNCH_FILE;
if (launchFile) appendFileSync(launchFile, `${String(process.pid)}\n`);
const launchCount = launchFile
  ? readFileSync(launchFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).length
  : 1;

if (mode === 'startup-exit') {
  process.stderr.write('Simulated OpenCode startup failure.\n');
  process.exit(1);
}

const portIndex = args.indexOf('--port');
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 4096);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`Invalid fake OpenCode port: ${String(port)}\n`);
  process.exit(2);
}

const pidFile = process.env.VARRO_SANDBOX_PID_FILE;
if (pidFile) writeFileSync(pidFile, `${String(process.pid)}\n`);

function sendJson(response, value, statusCode = 200) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;

  if (request.method === 'GET' && path === '/global/health') {
    sendJson(response, { healthy: true, version });
    return;
  }
  if (request.method === 'GET' && path === '/global/event') {
    if (mode === 'event-error') {
      sendJson(response, { error: 'Simulated event stream failure.' }, 503);
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
    });
    response.write(': fake OpenCode event stream\n\n');
    return;
  }
  if (request.method === 'GET' && path === '/session') {
    sendJson(response, []);
    return;
  }
  if (request.method === 'GET' && path === '/session/status') {
    sendJson(response, {});
    return;
  }
  if (request.method === 'GET' && path === '/agent') {
    sendJson(response, []);
    return;
  }
  if (request.method === 'GET' && path === '/command') {
    sendJson(response, []);
    return;
  }
  if (request.method === 'GET' && path === '/config/providers') {
    sendJson(response, { providers: [], default: {} });
    return;
  }
  if (request.method === 'GET' && ['/mcp', '/session/status'].includes(path)) {
    sendJson(response, {});
    return;
  }
  if (request.method === 'GET' && ['/question', '/permission', '/vcs/status'].includes(path)) {
    sendJson(response, []);
    return;
  }
  if (request.method === 'POST' && path === '/global/dispose') {
    sendJson(response, true);
    return;
  }

  sendJson(response, {});
});

server.on('error', (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Fake OpenCode listening on http://127.0.0.1:${port}\n`);
  if (mode === 'crash-once' && launchCount === 1) {
    const crashDelayMs = process.platform === 'win32' ? 8_000 : 1_500;
    setTimeout(() => process.exit(17), crashDelayMs).unref();
  }
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
