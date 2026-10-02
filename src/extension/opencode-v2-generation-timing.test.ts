/* oxlint-disable anti-slop/no-module-mocking -- The adapter logger requires VS Code; wire replies are deterministic fixtures. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessageAssistant, SessionTextStarted } from '@opencode/client';
import { OpenCodeV2GenerationTiming } from './opencode-v2-generation-timing';
import { OpenCodeV2Adapter } from './opencode-v2-adapter';
import { projectV2Event } from './opencode-v2-events';
import { projectV2Message } from './opencode-v2-projection';
import { asRecord } from '../shared/type-utils';
import type { UnknownRecord } from '../shared/type-utils';

vi.mock('./logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

afterEach(() => vi.useRealTimers());

const message: SessionMessageAssistant = {
  id: 'msg_one',
  type: 'assistant',
  agent: 'build',
  model: { providerID: 'openai', id: 'fixture' },
  time: { created: 1000, completed: 5000 },
  finish: 'stop',
  tokens: { input: 10, output: 100, reasoning: 50, cache: { read: 0, write: 0 } },
  content: [
    { type: 'reasoning', text: 'Think' },
    { type: 'text', text: 'Hello' },
  ],
};

type BoundaryData = SessionTextStarted['data'] & { text?: string };

function event(type: string, seq: number, created: number, text?: string) {
  const data: BoundaryData = {
    sessionID: 'ses_one',
    assistantMessageID: 'msg_one',
    ordinal: 0,
  };
  if (text !== undefined) data.text = text;
  return {
    id: `evt_${seq}`,
    type: `session.${type}`,
    created,
    durable: { aggregateID: 'ses_one', seq, version: 1 },
    data,
  };
}

const boundaries = [
  event('reasoning.started', 1, 2000),
  event('reasoning.ended', 2, 3000, 'Think'),
  event('text.started', 3, 3000),
  event('text.ended', 4, 5000, 'Hello'),
];

function log(events = boundaries, synced = true) {
  return [
    ...events,
    ...(synced
      ? [{ type: 'log.synced', aggregateID: 'ses_one', seq: events.at(-1)?.durable.seq }]
      : []),
  ]
    .map((item) => `data: ${JSON.stringify(item)}\r\n\r\n`)
    .join('');
}

describe('V2 generation boundaries', () => {
  it('restores live timing without waiting for an optional annotation write', async () => {
    const persistence = {
      read: vi.fn(async () => ({})),
      update: vi.fn(() => new Promise<void>(() => {})),
    };
    const timing = new OpenCodeV2GenerationTiming(persistence);
    for (const item of boundaries)
      timing.observe(item.type, item.data, item.created, item.durable.seq);
    let restored = false;
    void timing
      .restore('ses_one', [message], async () => log())
      .then(() => {
        restored = true;
      });
    await vi.waitFor(() => expect(restored).toBe(true), { timeout: 300 });
    expect(timing.time('ses_one', 'msg_one:text:0', 'Hello')).toEqual({ start: 3000, end: 5000 });
  });

  it('persists validated boundaries without response text and restores them after reload', async () => {
    let stored: UnknownRecord = {};
    const persistence = {
      read: vi.fn(async () => stored),
      update: vi.fn(async (_sessionID: string, patch: UnknownRecord) => {
        stored = { ...stored, ...patch };
      }),
    };
    const timing = new OpenCodeV2GenerationTiming(persistence);
    for (const item of boundaries)
      timing.observe(item.type, item.data, item.created, item.durable.seq);
    await timing.restore('ses_one', [message], async () => {
      throw new Error('Logs unavailable');
    });
    expect(JSON.stringify(stored)).not.toContain('Hello');
    expect(JSON.stringify(stored)).not.toContain('Think');
    expect(asRecord(stored.generationTiming)?.['msg_one:text:0']).toMatchObject({
      start: 3000,
      end: 5000,
    });
    const cold = new OpenCodeV2GenerationTiming(persistence);
    const read = vi.fn(async () => {
      throw new Error('Logs unavailable');
    });
    await cold.restore('ses_one', [message], read);
    expect(cold.time('ses_one', 'msg_one:text:0', 'Hello')).toEqual({ start: 3000, end: 5000 });
    expect(cold.time('ses_one', 'msg_one:text:0', 'Edited')).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not persist a generation interval across a sequence gap', async () => {
    const persistence = { read: vi.fn(async () => ({})), update: vi.fn(async () => {}) };
    const timing = new OpenCodeV2GenerationTiming(persistence);
    timing.observe('session.text.started', boundaries[0]!.data, 3000, 1);
    timing.observe('session.text.ended', { ...boundaries[0]!.data, text: 'Hello' }, 5000, 3);
    await timing.restore('ses_one', [message], async () => log([], true));
    expect(persistence.update).not.toHaveBeenCalled();
  });
  it('restores matching text and reasoning timings from the durable log', async () => {
    const timing = new OpenCodeV2GenerationTiming();
    const read = vi.fn(async () => log());
    await timing.restore('ses_one', [message], read);
    const projected = projectV2Message(message, 'ses_one');
    timing.apply(projected);
    expect(projected.parts.map((part) => part.time)).toEqual([
      { start: 2000, end: 3000 },
      { start: 3000, end: 5000 },
    ]);
    await timing.restore('ses_one', [message], read);
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(0);
  });

  it('preserves live timing when the same durable boundaries are replayed', async () => {
    const timing = new OpenCodeV2GenerationTiming();
    for (const item of boundaries)
      timing.observe(item.type, item.data, item.created, item.durable.seq);
    await timing.restore('ses_one', [message], async () => log());
    expect(timing.time('ses_one', 'msg_one:text:0', 'Hello')).toEqual({ start: 3000, end: 5000 });
    expect(timing.time('ses_two', 'msg_one:text:0', 'Hello')).toBeUndefined();
    expect(timing.time('ses_one', 'msg_one:text:0', 'Edited')).toBeUndefined();
  });

  it.each([
    [event('text.ended', 1, 5000, 'Hello')],
    [event('text.started', 1, 3000)],
    [event('text.started', 1, 3000), event('text.ended', 3, 5000, 'Hello')],
    [event('text.started', 1, 3000), event('text.ended', 2, 3000, 'Hello')],
    [event('text.started', 1, 3000), event('text.ended', 2, 2000, 'Hello')],
    [event('text.started', 1, Number.NaN), event('text.ended', 2, 5000, 'Hello')],
    [
      event('text.started', 1, 3000),
      event('text.started', 2, 4000),
      event('text.ended', 3, 5000, 'Hello'),
    ],
  ])('rejects incomplete, ambiguous, or invalid intervals %#', (...events) => {
    const timing = new OpenCodeV2GenerationTiming();
    for (const item of events) timing.observe(item.type, item.data, item.created, item.durable.seq);
    expect(timing.time('ses_one', 'msg_one:text:0', 'Hello')).toBeUndefined();
  });

  it('does not treat timestamped deltas as a start boundary', () => {
    const timing = new OpenCodeV2GenerationTiming();
    timing.observe('session.text.delta', boundaries[0]!.data, 3000, undefined);
    timing.observe('session.text.ended', { ...boundaries[0]!.data, text: 'Hello' }, 5000, 2);
    expect(timing.time('ses_one', 'msg_one:text:0', 'Hello')).toBeUndefined();
  });

  it.each([
    log(boundaries, false),
    'not SSE',
    log().replace('"aggregateID":"ses_one","seq":4}', '"aggregateID":"ses_other","seq":4}'),
  ])('does not publish partial or malformed replay data %#', async (value) => {
    const timing = new OpenCodeV2GenerationTiming();
    await timing.restore('ses_one', [message], async () => value);
    expect(timing.time('ses_one', 'msg_one:text:0', 'Hello')).toBeUndefined();
  });

  it('rejects replay events belonging to another aggregate', async () => {
    const timing = new OpenCodeV2GenerationTiming();
    await timing.restore('ses_one', [message], async () =>
      log().replaceAll('"aggregateID":"ses_one"', '"aggregateID":"ses_other"')
    );
    expect(timing.time('ses_one', 'msg_one:text:0', 'Hello')).toBeUndefined();
  });

  it('propagates caller cancellation without caching a failed restore', async () => {
    const timing = new OpenCodeV2GenerationTiming();
    const controller = new AbortController();
    controller.abort();
    await expect(
      timing.restore('ses_one', [message], async () => log(), controller.signal)
    ).rejects.toThrow();
    await timing.restore('ses_one', [message], async () => log());
    expect(timing.time('ses_one', 'msg_one:text:0', 'Hello')).toBeDefined();
  });

  it('reads only incremental history for a newer response', async () => {
    const timing = new OpenCodeV2GenerationTiming();
    const read = vi.fn(async () => log());
    await timing.restore('ses_one', [message], read);
    read.mockResolvedValue(log([], true));
    await timing.restore(
      'ses_one',
      [{ ...message, id: 'msg_next', time: { created: 6000, completed: 7000 } }],
      read
    );
    expect(read).toHaveBeenLastCalledWith(4);
    timing.reset();
    await timing.restore('ses_one', [message], read);
    expect(read).toHaveBeenLastCalledWith(0);
  });
});

describe('V2 adapter generation timing', () => {
  it('does not swallow caller cancellation during an optional annotation read', async () => {
    vi.useFakeTimers();
    const persistence = {
      read: vi.fn(() => new Promise<UnknownRecord>(() => {})),
      update: vi.fn(async () => {}),
    };
    const adapter = new OpenCodeV2Adapter(
      vi.fn(async () => ({ data: message })),
      undefined,
      undefined,
      new OpenCodeV2GenerationTiming(persistence)
    );
    const controller = new AbortController();
    const request = adapter.request('GET', '/session/ses_one/message/msg_one', undefined, {
      signal: controller.signal,
    });
    const result = expect(request).rejects.toThrow('History cancelled');
    await vi.advanceTimersByTimeAsync(0);
    expect(persistence.read).toHaveBeenCalledOnce();
    controller.abort(new Error('History cancelled'));
    await result;
  });

  it('ignores a late timing log after the optional deadline', async () => {
    vi.useFakeTimers();
    let resolveLog: ((value: string) => void) | undefined;
    const timingLog = new Promise<string>((resolve) => {
      resolveLog = resolve;
    });
    const timing = new OpenCodeV2GenerationTiming();
    const wire = vi.fn(async (_method: string, path: string) =>
      path.includes('/log?') ? timingLog : { data: message }
    );
    const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, timing);
    const request = adapter.request('GET', '/session/ses_one/message/msg_one', undefined);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(request).resolves.toMatchObject({ info: { id: 'msg_one' } });
    resolveLog?.(log());
    await vi.advanceTimersByTimeAsync(0);
    expect(timing.time('ses_one', 'msg_one:text:0', 'Hello')).toBeUndefined();
  });

  it('bounds optional annotation reads without delaying or changing transcript identity', async () => {
    vi.useFakeTimers();
    const persistence = {
      read: vi.fn(() => new Promise<UnknownRecord>(() => {})),
      update: vi.fn(async () => {}),
    };
    const timing = new OpenCodeV2GenerationTiming(persistence);
    const wire = vi.fn(async () => ({ data: message }));
    const adapter = new OpenCodeV2Adapter(wire, undefined, undefined, timing);
    let result: unknown;
    const request = adapter
      .request('GET', '/session/ses_one/message/msg_one', undefined)
      .then((value) => {
        result = value;
      });
    await vi.advanceTimersByTimeAsync(2000);
    expect(result).toMatchObject({
      info: { id: 'msg_one' },
      parts: [{ text: 'Think' }, { text: 'Hello' }],
    });
    await request;
    expect(wire).toHaveBeenCalledOnce();
  });

  it('restores timing on cold page and direct message reads without changing identity or cursor', async () => {
    const wire = vi.fn(async (_method: string, path: string) => {
      if (path.includes('/log?')) return log();
      if (path.endsWith('/inbox')) return { data: [] };
      if (path.includes('/message/')) return { data: message };
      return {
        data: [message, { id: 'msg_user', type: 'user', text: 'Hi', time: { created: 0 } }],
        cursor: { next: 'older' },
      };
    });
    const adapter = new OpenCodeV2Adapter(wire);
    const page = await adapter.request('GET', '/session/ses_one/message?limit=2', undefined, {
      captureNextCursor: true,
    });
    expect(page).toMatchObject({
      nextCursor: 'older',
      data: [
        { info: { id: 'msg_user' } },
        {
          info: { id: 'msg_one', parentID: 'msg_user' },
          parts: [
            { id: 'msg_one:reasoning:0', time: { start: 2000, end: 3000 } },
            { id: 'msg_one:text:0', time: { start: 3000, end: 5000 } },
          ],
        },
      ],
    });
    expect(
      await adapter.request('GET', '/session/ses_one/message/msg_one', undefined)
    ).toMatchObject({
      parts: [{ time: { start: 2000, end: 3000 } }, { time: { start: 3000, end: 5000 } }],
    });
    expect(wire.mock.calls.filter((call) => call[1].includes('/log?'))).toEqual([
      [
        'GET',
        '/api/experimental/session/ses_one/log?follow=false&after=0',
        undefined,
        expect.objectContaining({ maxResponseBytes: 2 * 1024 * 1024 }),
      ],
    ]);
    expect(
      await new OpenCodeV2Adapter(wire).request(
        'GET',
        '/session/ses_one/message/msg_one',
        undefined
      )
    ).toMatchObject({
      parts: [{ time: { start: 2000, end: 3000 } }, { time: { start: 3000, end: 5000 } }],
    });
  });

  it('attaches matched live boundaries to projected text end events', () => {
    const adapter = new OpenCodeV2Adapter(async () => undefined);
    for (const item of boundaries)
      adapter.observe(item.type, item.data, item.id, undefined, item.created, item.durable.seq);
    const projected = projectV2Event(boundaries.at(-1), adapter.eventContext('ses_one'));
    expect(asRecord(asRecord(projected[0])?.properties)?.time).toEqual({ start: 3000, end: 5000 });
  });

  it('keeps history available when timing logs are unsupported or over budget', async () => {
    const adapter = new OpenCodeV2Adapter(async (_method, path) => {
      if (path.includes('/log?')) throw new Error('404 Not found');
      return { data: message };
    });
    expect(
      await adapter.request('GET', '/session/ses_one/message/msg_one', undefined)
    ).toMatchObject({
      info: { id: 'msg_one' },
      parts: [{ text: 'Think' }, { text: 'Hello', time: undefined }],
    });
  });
});
