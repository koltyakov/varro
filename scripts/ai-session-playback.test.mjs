import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildReplayTimeline,
  eventBelongsToSession,
  normalizeCapturedEvents,
  readPlaybackCapture,
  reconstructHistoricalEvents,
  savePlaybackCapture,
} from './ai-session-playback.mjs';

test('normal discovery excludes local capture playback', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
  for (const local of [false, true]) {
    const report = JSON.parse(execFileSync(process.execPath, [
      cli, 'test', '--list', '--reporter=json',
      ...(local ? ['--config', 'playwright.ai-playback.config.ts'] : []),
    ], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        VARRO_PLAYBACK_ID: '92',
        VARRO_PLAYBACK_FILE: path.join(cwd, 'nonexistent-playback-capture.json'),
      },
    }));
    const files = report.suites.map((suite) => suite.file);
    if (local) {
      assert.deepEqual(files, ['session-playback.spec.ts']);
      assert.equal(report.config.workers, 1);
    } else {
      assert.ok(files.includes('scroll-tool-flicker.spec.ts'));
      assert.ok(files.every((file) => !file.includes('session-playback.spec.ts')));
      const flicker = report.suites.find((suite) => suite.file === 'scroll-tool-flicker.spec.ts');
      assert.equal(flicker.specs.length, 4);
      assert.ok(flicker.specs.some((spec) => spec.title === 'mocked session playback has no frame-level flicker'));
    }
  }
});

test('preserves short event gaps and caps long idle gaps', () => {
  const timeline = buildReplayTimeline([
    { offsetMs: 20, event: { type: 'one' } },
    { offsetMs: 120, event: { type: 'two' } },
    { offsetMs: 5_120, event: { type: 'three' } },
  ]);
  assert.deepEqual(
    timeline.map(({ delayMs, sourceGapMs }) => ({ delayMs, sourceGapMs })),
    [
      { delayMs: 20, sourceGapMs: 20 },
      { delayMs: 100, sourceGapMs: 100 },
      { delayMs: 500, sourceGapMs: 5_000 },
    ]
  );
});

test('filters another session and removes stream sequence metadata', () => {
  const own = {
    offsetMs: 10,
    event: {
      id: 'event-1',
      seq: 9,
      type: 'message.part.updated',
      properties: { part: { sessionID: 'session-a' } },
    },
  };
  const other = {
    offsetMs: 20,
    event: { type: 'session.status', properties: { sessionID: 'session-b' } },
  };
  assert.equal(eventBelongsToSession(own.event, 'session-a'), true);
  assert.equal(
    eventBelongsToSession(
      { type: 'session.updated', properties: { info: { id: 'session-a' } } },
      'session-a'
    ),
    true
  );
  assert.deepEqual(normalizeCapturedEvents([own, other], 'session-a'), [
    {
      offsetMs: 10,
      event: { type: 'message.part.updated', properties: { part: { sessionID: 'session-a' } } },
    },
  ]);
});

test('round trips a capture through SQLite', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'varro-playback-'));
  const filePath = path.join(directory, 'capture.db');
  try {
    const saved = savePlaybackCapture(filePath, {
      label: 'tool completion',
      scenario: 'AI-07',
      capturedAt: '2026-09-05T00:00:00.000Z',
      model: 'openai/gpt-5.6-luna',
      session: { id: 'session-a', title: 'Captured session' },
      initialMessages: [],
      finalMessages: [{ info: { id: 'message-a' }, parts: [] }],
      events: [
        {
          offsetMs: 12,
          event: { type: 'session.status', properties: { sessionID: 'session-a', status: { type: 'busy' } } },
        },
      ],
    });
    assert.equal(saved.eventCount, 1);
    const capture = readPlaybackCapture(filePath, saved.id);
    assert.equal(capture.label, 'tool completion');
    assert.equal(capture.events[0].offsetMs, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconstructs historical text streaming and tool lifecycle boundaries', () => {
  const sessionID = 'session-a';
  const user = {
    info: { id: 'user-a', sessionID, role: 'user', time: { created: 100 } },
    parts: [{ id: 'user-part', sessionID, messageID: 'user-a', type: 'text', text: 'Run it' }],
  };
  const assistant = {
    info: {
      id: 'assistant-a',
      sessionID,
      role: 'assistant',
      parentID: 'user-a',
      time: { created: 200, completed: 500 },
      finish: 'stop',
    },
    parts: [],
  };
  const rows = [
    {
      id: 'text-a',
      message_id: 'assistant-a',
      session_id: sessionID,
      time_created: 210,
      time_updated: 260,
      data: JSON.stringify({ type: 'text', text: 'streamed response' }),
    },
    {
      id: 'tool-a',
      message_id: 'assistant-a',
      session_id: sessionID,
      time_created: 220,
      time_updated: 280,
      data: JSON.stringify({
        type: 'tool',
        tool: 'bash',
        callID: 'call-a',
        state: {
          status: 'completed',
          input: { command: 'npm test' },
          output: 'passed',
          title: 'Test',
          metadata: {},
          time: { start: 220, end: 280 },
        },
      }),
    },
  ];
  const events = reconstructHistoricalEvents(sessionID, user, assistant, rows);
  const toolStates = events
    .filter((entry) => entry.event.properties?.part?.id === 'tool-a')
    .map((entry) => entry.event.properties.part.state.status);
  const streamed = events
    .filter((entry) => entry.event.type === 'message.part.delta')
    .map((entry) => entry.event.properties.delta)
    .join('');
  assert.deepEqual(toolStates, ['pending', 'running', 'completed']);
  assert.equal(streamed, 'streamed response');
  assert.equal(events.at(-1).event.properties.status.type, 'idle');
});
