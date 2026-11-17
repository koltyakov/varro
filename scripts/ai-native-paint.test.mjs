import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import {
  brightPixels,
  glyphContinuity,
  topTargeting,
  verdict,
  summarizeTrace,
} from './ai-native-paint-oracles.mjs';
import { nativePaintFixture } from './ai-native-paint-fixture.mjs';
import { createStreamingServer } from './ai-streaming-server.mjs';
import { analyzeNativePaint } from './ai-native-paint-analysis.mjs';
import { startPaintTrace, PAINT_TRACE_CATEGORIES } from './ai-native-paint-trace.mjs';

function image() {
  const data = new Uint8Array(40 * 40 * 3).fill(20);
  for (let y = 10; y < 20; y++)
    for (let x = 10; x < 20; x++) {
      if ((x + y) % 3 === 0) data.fill(200, (y * 40 + x) * 3, (y * 40 + x) * 3 + 3);
    }
  return { data, width: 40, height: 40 };
}
test('native pixel oracle rejects blank bodies and absent retained glyphs', () => {
  const good = image(),
    rect = { x: 10, y: 10, width: 10, height: 10 };
  const reference = brightPixels(good, rect);
  assert.ok(reference.length > 30);
  assert.equal(glyphContinuity(good, rect, reference), 1);
  const blank = { ...good, data: new Uint8Array(good.data.length).fill(20) };
  assert.equal(brightPixels(blank, rect).length, 0);
  assert.equal(glyphContinuity(blank, rect, reference), 0);
  assert.throws(() => brightPixels(good, { ...rect, x: -1 }), /outside/);
});
test('later success or incomplete evidence cannot clear a prior paint failure', () => {
  const failures = [{ frame: 'first-blank.png' }];
  assert.equal(verdict(failures, false), 'FAIL');
  assert.equal(verdict(failures, true), 'FAIL');
  assert.equal(verdict([], false), 'BLOCKED');
  assert.equal(verdict([], true), 'PASS');
  assert.equal(failures.length, 1);
});
test('frame analysis retains early blanks and missing glyphs after later correct paints', async () => {
  const width = 600,
    height = 700;
  const good = { width, height, data: new Uint8Array(width * height * 3).fill(20) };
  for (const [left, top] of [
    [20, 120],
    [20, 300],
  ]) {
    for (let y = top; y < top + 10; y++)
      for (let x = left; x < left + 100; x++) {
        if ((x + y) % 3 === 0) good.data.fill(200, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
  }
  const blank = { ...good, data: new Uint8Array(good.data.length).fill(20) };
  const samples = Array.from({ length: 12 }, (_, i) => ({
    epoch: i * 100,
    label: 'first-top',
    top: i < 5 ? 10000 : 9000,
    viewport: { x: 0, y: 0, width, height },
    markers: [
      {
        node: i < 3 ? 1 : 2,
        row: 'retained',
        text: 'painted marker',
        rect: { x: 20, y: 120, width: 100, height: 10 },
        styles: [{ opacity: '1', visibility: 'visible', display: 'block' }],
      },
    ],
  }));
  const frames = samples.slice(0, -1).map((_, i) => ({
    file: String(i),
    metadata: { timestamp: (i * 100 + 50) / 1000, deviceWidth: width, deviceHeight: height },
  }));
  const result = await analyzeNativePaint(
    frames,
    samples,
    { x: 0, y: 0 },
    async (file) => (file === '3' ? blank : good),
    250,
    { decode: async (value) => value, firstMoveEpoch: 250 }
  );
  assert.equal(result.cold.verdict, 'FAIL');
  assert.equal(result.retained.verdict, 'FAIL');
  assert.equal(result.cold.failures[0].file, '3');
  assert.equal(result.retained.failures[0].file, '3');
  assert.ok(result.inspected.at(-1).markers[0].score > 0.9);
  assert.equal(result.retained.nodeChanges.length, 1);
  assert.equal(result.retained.nodeChanges[0].from, 1);
  assert.equal(result.retained.nodeChanges[0].to, 2);
});
test('loaded-window top and compensated prepend do not mean complete-history top', () => {
  const action = { name: 'first-top', held: true, before: { top: 10000 }, finished: 300 };
  const samples = [
    { label: 'first-top', top: 0, viewport: { y: 37 }, rows: [] },
    { label: 'first-top', top: 4704, viewport: { y: 37 }, rows: [{ id: 'first', y: -4667 }] },
  ];
  const pages = [{ before: 'opaque', finished: 200, status: 200, cursor: null }];
  const first = topTargeting(action, samples, pages, 'first');
  assert.equal(first.reachedLoadedTop, true);
  assert.equal(first.compensation, true);
  assert.equal(first.completeTop, false);
  const regrab = { ...action, name: 'pagination-regrab', before: { top: 4704 } };
  const second = topTargeting(
    regrab,
    [
      ...samples,
      {
        label: regrab.name,
        top: 0,
        viewport: { y: 37 },
        rows: [{ id: 'first', y: 37 }],
      },
    ],
    pages,
    'first'
  );
  assert.equal(second.completeTop, true);
  assert.equal(first.completeTop, false);
  assert.equal(
    topTargeting({ ...action, held: false }, samples, pages, 'first').verdict,
    'BLOCKED'
  );
  assert.equal(topTargeting(action, samples.slice(0, 1), [], 'first').completeTop, false);
});
test('trace summary keeps process attribution and raster/paint/scroll events', () => {
  const result = summarizeTrace([
    { name: 'process_name', pid: 2, args: { name: 'Renderer' } },
    { name: 'RasterTask', pid: 2 },
    { name: 'Paint', pid: 2 },
    { name: 'unrelated' },
  ]);
  assert.equal(result.processes[2], 'Renderer');
  assert.equal(result.counts.RasterTask, 1);
  assert.equal(result.relevant.length, 2);
});
test('browser-level compositor trace drains and closes the protocol stream', async () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}` })
    );
  });
  const sockets = new WebSocketServer({ server });
  const calls = [];
  sockets.on('connection', (socket) =>
    socket.on('message', (bytes) => {
      const call = JSON.parse(bytes);
      calls.push(call);
      socket.send(
        JSON.stringify({
          id: call.id,
          result:
            call.method === 'IO.read'
              ? {
                  data: Buffer.from('{"traceEvents":[]}').toString('base64'),
                  base64Encoded: true,
                  eof: true,
                }
              : {},
        })
      );
      if (call.method === 'Tracing.end')
        socket.send(
          JSON.stringify({
            method: 'Tracing.tracingComplete',
            params: { stream: 'owned-stream', dataLossOccurred: false },
          })
        );
    })
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const trace = await startPaintTrace(server.address().port);
    const captured = await trace.stop();
    assert.equal(captured.data.toString(), '{"traceEvents":[]}');
    assert.equal(captured.dataLoss, false);
    assert.equal(calls[0].params.transferMode, 'ReturnAsStream');
    assert.deepEqual(calls[0].params.traceConfig.includedCategories, PAINT_TRACE_CATEGORIES);
    assert.equal(calls[0].params.traceConfig.traceBufferSizeInKb, 512 * 1024);
    assert.equal(calls.at(-1).method, 'IO.close');
  } finally {
    for (const client of sockets.clients) client.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }
});
test('generated paginated multi-file fixture is accepted by the read-only server', async () => {
  const capture = nativePaintFixture();
  assert.equal(capture.initialMessages.length, 270);
  const server = await createStreamingServer({
    capture,
    timeline: [],
    directory: '/generated-native-test',
  });
  try {
    const response = await fetch(
      `${server.url}/session/${server.getResult().sessionID}/message?limit=200`
    );
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('x-next-cursor'));
    assert.equal((await response.json()).length, 200);
  } finally {
    await server.close();
  }
});
