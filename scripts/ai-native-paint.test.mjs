import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import {
  brightPixels,
  firstAppliedPage,
  glyphContinuity,
  markerPaintEligibility,
  topTargeting,
  verdict,
  summarizeTrace,
} from './ai-native-paint-oracles.mjs';
import { nativePaintFixture } from './ai-native-paint-fixture.mjs';
import { createStreamingServer } from './ai-streaming-server.mjs';
import { createBootstrapProxy } from './ai-streaming.mjs';
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
    stickyOccluders: [],
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
    async (file) =>
      file === '0' || file === '4'
        ? { ...good, data: new Uint8Array(good.data.length).fill(240) }
        : file === '3'
          ? blank
          : good,
    250,
    { decode: async (value) => value, firstMoveEpoch: 250 }
  );
  assert.equal(result.cold.verdict, 'FAIL');
  assert.equal(result.retained.verdict, 'FAIL');
  assert.deepEqual(
    result.cold.failures.map((f) => f.file),
    ['3', '4']
  );
  assert.deepEqual(
    result.retained.failures.map((f) => f.file),
    ['3', '4']
  );
  assert.equal(result.retained.references[0][1].file, '1');
  assert.ok(result.inspected.at(-1).markers[0].score > 0.9);
  assert.equal(result.retained.nodeChanges.length, 1);
  assert.equal(result.retained.nodeChanges[0].from, 1);
  assert.equal(result.retained.nodeChanges[0].to, 2);
});
test('text eligibility uses the actual opaque sticky footprint, not hit testing or a fixed inset', () => {
  const marker = {
    rect: { x: 20, y: 120, width: 100, height: 16 },
    styles: [{ opacity: '1', visibility: 'visible', display: 'block' }],
    hits: [{ containsParagraph: true }],
  };
  const sample = {
    viewport: { x: 0, y: 0, width: 600, height: 700 },
    stickyOccluders: [
      { x: 14, y: 51, width: 458, height: 76 },
      { x: 14, y: 127, width: 458, height: 8 },
    ],
  };
  assert.equal(markerPaintEligibility(marker, sample), 'sticky-occluded');
  assert.equal(
    markerPaintEligibility({ ...marker, rect: { ...marker.rect, y: 138 } }, sample),
    null
  );
  assert.equal(markerPaintEligibility(marker, { ...sample, stickyOccluders: [] }), null);
  assert.equal(
    markerPaintEligibility(marker, { viewport: sample.viewport }),
    'unknown-sticky-coverage'
  );
  assert.equal(
    markerPaintEligibility({ ...marker, rect: { ...marker.rect, y: 1 } }, sample),
    'clipped'
  );
  assert.equal(
    markerPaintEligibility(
      { ...marker, styles: [{ opacity: '0', visibility: 'visible', display: 'block' }] },
      { ...sample, stickyOccluders: [] }
    ),
    'hidden'
  );
});
test('either sticky-covered bracket excludes a marker from references and failures', async () => {
  const width = 600;
  const height = 700;
  const rect = { x: 20, y: 120, width: 100, height: 10 };
  const good = { width, height, data: new Uint8Array(width * height * 3).fill(20) };
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if ((x + y) % 3 === 0) good.data.fill(200, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
  }
  const blank = { ...good, data: new Uint8Array(good.data.length).fill(20) };
  const marker = {
    node: 1,
    row: 'covered',
    text: 'retained marker',
    rect,
    styles: [{ opacity: '1', visibility: 'visible', display: 'block' }],
    // pointer-events:none chrome does not show up in elementFromPoint.
    hits: [{ containsParagraph: true }],
  };
  for (const coveredBracket of [0, 1]) {
    const samples = Array.from({ length: 6 }, (_, index) => ({
      epoch: index * 100,
      label: 'first-top',
      top: 1000,
      viewport: { x: 0, y: 0, width, height },
      stickyOccluders: index % 2 === coveredBracket ? [rect] : [],
      markers: [marker],
    }));
    const frames = [0, 2, 4].map((index) => ({
      file: String(index),
      metadata: { timestamp: (index * 100 + 50) / 1000, deviceWidth: width, deviceHeight: height },
    }));
    const analyze = (evidence) =>
      analyzeNativePaint(frames, evidence, { x: 0, y: 0 }, async () => good, 250, {
        decode: async (value) => value,
      });
    const covered = await analyze(samples);
    assert.deepEqual(covered.retained.references, []);
    assert.equal(covered.retained.checkedFrames, 0);
    assert.deepEqual(covered.retained.failures, []);
    assert.equal(covered.retained.excludedMarkers.length, frames.length);
    assert.ok(covered.retained.excludedMarkers.every(({ reason }) => reason === 'sticky-occluded'));

    // Seed a real reference, then cover either side of a blank frame. Neither
    // the missing glyphs nor the later recovery can be counted while covered.
    samples[0].stickyOccluders = [];
    samples[1].stickyOccluders = [];
    const retained = await analyzeNativePaint(
      frames,
      samples,
      { x: 0, y: 0 },
      async (file) => (file === '0' ? good : blank),
      250,
      { decode: async (value) => value }
    );
    assert.equal(retained.retained.references.length, 1);
    assert.equal(retained.retained.checkedFrames, 0);
    assert.deepEqual(retained.retained.failures, []);
    assert.equal(retained.retained.excludedMarkers.length, frames.length - 1);
  }
});
test('the first placed row from a completed older page marks prepend with the banner still present', () => {
  const pages = [
    { before: 'page1', cursor: 'page2', finished: 5, status: 200, messageIds: ['older'] },
    { before: 'page2', cursor: null, finished: 40, status: 200, messageIds: ['oldest'] },
  ];
  const sample = (epoch, firstLoadedMessageId, visible = firstLoadedMessageId) => ({
    epoch,
    banner: true,
    firstLoadedMessageId,
    rows: [{ id: visible, width: 100, height: 24 }],
  });
  const initial = sample(10, 'current');
  const samples = [
    sample(15, 'current', 'older'),
    sample(22, 'current', 'unrelated'),
    sample(30, 'older', 'current'),
    sample(60, 'oldest'),
  ];
  assert.equal(firstAppliedPage(samples.slice(0, 2), pages, initial), null);
  assert.deepEqual(firstAppliedPage(samples, pages, initial), {
    epoch: 30,
    referenceDeadline: 22,
    finished: 5,
    before: 'page1',
    row: 'older',
    prefetched: true,
  });
  // If the first page was already applied when recording began, remounting it is not prepend.
  assert.deepEqual(firstAppliedPage(samples, pages, sample(30, 'older')), {
    epoch: 60,
    referenceDeadline: 30,
    finished: 40,
    before: 'page2',
    row: 'oldest',
    prefetched: false,
  });
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

test('observes ordered page IDs before the bootstrap proxy streams the body', async () => {
  const capture = nativePaintFixture();
  const pages = [];
  const server = await createStreamingServer({
    capture,
    timeline: [],
    directory: '/generated-native-test',
    onMessagePage: (page) => pages.push(page),
  });
  const proxy = await createBootstrapProxy(server);
  try {
    const route = `${proxy.url}/session/${server.getResult().sessionID}/message?limit=100`;
    const first = await fetch(route);
    const firstCursor = first.headers.get('x-next-cursor');
    assert.ok(firstCursor);
    await first.arrayBuffer();
    assert.deepEqual(pages, []);
    const older = await fetch(`${route}&before=${firstCursor}`);
    const secondCursor = older.headers.get('x-next-cursor');
    assert.ok(secondCursor);
    assert.equal((await older.json()).length, 100);
    const oldest = await fetch(`${route}&before=${secondCursor}`);
    assert.equal(oldest.headers.get('x-next-cursor'), null);
    await oldest.arrayBuffer();

    assert.deepEqual(
      pages.map((page) => page.before),
      [firstCursor, secondCursor]
    );
    assert.deepEqual(
      pages.map((page) => page.cursor),
      [secondCursor, null]
    );
    assert.ok(pages.every((page) => page.status === 200 && page.finished >= page.started));
    assert.deepEqual(
      pages.map((page) => page.messageIds),
      [
        capture.initialMessages.slice(70, 170).map(({ info }) => info.id),
        capture.initialMessages.slice(0, 70).map(({ info }) => info.id),
      ]
    );
  } finally {
    await proxy.close();
    await server.close();
  }
});
