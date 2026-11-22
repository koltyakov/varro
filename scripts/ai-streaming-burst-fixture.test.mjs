import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { BURST_CASES, createBurstCapture } from './ai-streaming-burst-fixture.mjs';
import { createStreamingServer } from './ai-streaming-server.mjs';
import { buildReplayTimeline } from './ai-session-playback.mjs';

for (const kind of BURST_CASES) {
  test(`burst fixture ${kind} is deterministic and accepted by read-only replay`, async () => {
    const capture = createBurstCapture(kind);
    assert.deepEqual(capture, createBurstCapture(kind));
    assert.equal(capture.initialMessages.length, 122);
    assert.ok(
      capture.events.some(
        (entry, index, entries) => index > 0 && entry.offsetMs === entries[index - 1].offsetMs
      )
    );
    const server = await createStreamingServer({
      capture,
      directory: '/synthetic/isolated-bursts',
      timeline: buildReplayTimeline(capture.events).map((entry) => ({ ...entry, delayMs: 0 })),
    });
    const request = http.get(`${server.url}/global/event`);
    try {
      const [response] = await once(request, 'response');
      response.resume();
      const result = await server.start();
      assert.equal(result.state, 'completed');
      assert.equal(result.canonicalMatch, true);
    } finally {
      request.destroy();
      await server.close();
    }
    const final = capture.finalMessages.at(-1);
    assert.equal(final.info.finish, 'stop');
    assert.equal(
      final.parts.filter((part) => part.type === 'tool').length,
      capture.reproduction.toolCount
    );
    assert.ok(
      final.parts
        .filter((part) => part.type === 'tool')
        .every((part) => part.state.status === 'completed')
    );
    assert.ok(
      final.parts
        .filter((part) => part.type === 'text')
        .reduce((n, part) => n + part.text.length, 0) > 4000
    );
  });
}
