import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { startPaintTrace } from './ai-native-paint-trace.mjs';

async function withTraceServer(run, handle) {
  const calls = [];
  const server = http.createServer((_request, response) => {
    response.end(
      JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}` })
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const call = JSON.parse(bytes);
      calls.push(call);
      const send = (value) => socket.send(JSON.stringify(value));
      if (handle?.(call, send, socket) === true) return;
      send({ id: call.id, result: call.method === 'IO.read' ? { data: '{}', eof: true } : {} });
      if (call.method === 'Tracing.end')
        send({
          method: 'Tracing.tracingComplete',
          params: { stream: 'trace', dataLossOccurred: false },
        });
    })
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(server.address().port, calls);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
}

test('trace waits for delayed flush, records pressure/loss, and ends only once', async () => {
  await withTraceServer(
    async (port, calls) => {
      const trace = await startPaintTrace(port, { completionTimeoutMs: 1000 });
      const first = trace.stop();
      assert.equal(first, trace.stop());
      const result = await first;
      assert.equal(result.dataLoss, true);
      assert.equal(result.maxBufferUsage, 0.95);
      assert.equal(result.bufferSamples, 1);
      assert.ok(result.completionMs >= 30);
      assert.equal(calls.filter((call) => call.method === 'Tracing.end').length, 1);
    },
    (call, send) => {
      if (call.method !== 'Tracing.end') return false;
      send({ id: call.id, result: {} });
      send({ method: 'Tracing.bufferUsage', params: { percentFull: 0.95 } });
      setTimeout(
        () =>
          send({
            method: 'Tracing.tracingComplete',
            params: { stream: 'trace', dataLossOccurred: true },
          }),
        40
      );
      return true;
    }
  );
});

test('trace socket closure during flush fails promptly instead of waiting for timeout', async () => {
  await withTraceServer(
    async (port) => {
      const trace = await startPaintTrace(port);
      await assert.rejects(trace.stop(), /socket closed/);
      await assert.rejects(trace.stop(), /socket closed/);
    },
    (call, send, socket) => {
      if (call.method !== 'Tracing.end') return false;
      send({ id: call.id, result: {} });
      socket.close();
      return true;
    }
  );
});

test('completion timeout is bounded and never replays end', async () => {
  await withTraceServer(
    async (port, calls) => {
      const trace = await startPaintTrace(port, { completionTimeoutMs: 20 });
      await assert.rejects(trace.stop(), /completion timed out/);
      await assert.rejects(trace.stop(), /completion timed out/);
      assert.equal(calls.filter((call) => call.method === 'Tracing.end').length, 1);
    },
    (call, send) => {
      if (call.method !== 'Tracing.end') return false;
      send({ id: call.id, result: {} });
      return true;
    }
  );
});

test('trace streams to a private file without overwriting existing evidence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varro-trace-'));
  const outputPath = path.join(directory, 'trace.json');
  try {
    await withTraceServer(async (port) => {
      const result = await (await startPaintTrace(port, { outputPath })).stop();
      assert.equal(result.data, undefined);
      assert.equal(result.bytes, 2);
      assert.equal(await readFile(outputPath, 'utf8'), '{}');
    });
    await withTraceServer(async (port, calls) => {
      await assert.rejects((await startPaintTrace(port, { outputPath })).stop(), /EEXIST/);
      assert.equal(calls.at(-1).method, 'IO.close');
      assert.equal(await readFile(outputPath, 'utf8'), '{}');
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('oversized exports close the stream and remove only their own partial output', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varro-trace-cap-'));
  const outputPath = path.join(directory, 'trace.json');
  try {
    await withTraceServer(async (port, calls) => {
      await assert.rejects(
        (await startPaintTrace(port, { maxBytes: 1, outputPath })).stop(),
        /export cap/
      );
      assert.equal(calls.at(-1).method, 'IO.close');
      await assert.rejects(readFile(outputPath), /ENOENT/);
    });
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('export deadline bounds a stream that never returns a chunk', async () => {
  await withTraceServer(
    async (port, calls) => {
      const trace = await startPaintTrace(port, { exportTimeoutMs: 20 });
      await assert.rejects(trace.stop(), /export timed out/);
      assert.equal(calls.at(-1).method, 'IO.close');
    },
    (call) => call.method === 'IO.read'
  );
});
