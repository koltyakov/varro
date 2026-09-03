/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These bridge tests model malformed server events and partial imported collaborators. */
import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent, ServerStatus } from '../shared/protocol';

const mocks = vi.hoisted(() => ({
  createStatusBarItem: vi.fn((_id: string, _alignment: number, _priority: number) => ({
    name: '',
    command: '',
    dispose: vi.fn(),
  })),
  parseServerEvent: vi.fn(),
  getSessionIdsForEvent: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: { createStatusBarItem: mocks.createStatusBarItem },
  StatusBarAlignment: { Left: 1, Right: 2 },
}));

vi.mock('../shared/protocol', () => ({
  parseServerEvent: mocks.parseServerEvent,
}));

vi.mock('./sidebar-provider-utils', () => ({
  getSessionIdsForEvent: mocks.getSessionIdsForEvent,
}));

vi.mock('./logger', () => ({
  logger: { warn: mocks.loggerWarn },
}));

import { ServerEventBridge } from './server-event-bridge';
import { HiddenSessionManager } from './hidden-session-manager';

interface CapturedHandlers {
  status: ((status: ServerStatus) => void) | undefined;
  event: ((event: unknown) => void) | undefined;
}

function createMocks(options?: {
  workspacePath?: string | null;
  isSessionInWorkspace?: (sessionID: string, workspacePath: string | null | undefined) => boolean;
  getSessionWorkspaceMatch?: (
    sessionID: string,
    workspacePath: string | null | undefined
  ) => boolean | undefined;
  hiddenSessions?: HiddenSessionManager;
}) {
  const handlers: CapturedHandlers = { status: undefined, event: undefined };
  const server = {
    on: vi.fn((event: string, handler: (data: unknown) => void) => {
      if (event === 'status') handlers.status = handler;
      if (event === 'event') handlers.event = handler;
    }),
    off: vi.fn(),
  };
  const sessionState = {
    handleServerEvent: vi.fn(),
    isSessionInWorkspace: vi.fn(options?.isSessionInWorkspace || (() => true)),
    getSessionWorkspaceMatch: vi.fn(
      options?.getSessionWorkspaceMatch || options?.isSessionInWorkspace || (() => true)
    ),
    persist: vi.fn(() => Promise.resolve()),
    flush: vi.fn(() => Promise.resolve()),
  };
  const sessionTrash = { isHidden: vi.fn(() => false) };
  const hiddenSessions = options?.hiddenSessions ?? sessionTrash;
  const providerLimitService = {
    shouldClearCache: vi.fn(() => false),
    clearCache: vi.fn(),
  };
  const post = vi.fn();
  const updateStatusBarItem = vi.fn();
  const bridge = new ServerEventBridge(
    server as never,
    sessionState as never,
    hiddenSessions as never,
    providerLimitService as never,
    post,
    updateStatusBarItem
  );
  return {
    handlers,
    server,
    sessionState,
    sessionTrash,
    providerLimitService,
    post,
    updateStatusBarItem,
    bridge,
  };
}

const RUNNING_STATUS: ServerStatus = { state: 'running', url: 'http://localhost:3000' };
const STARTING_STATUS: ServerStatus = { state: 'starting' };
const ERROR_STATUS: ServerStatus = { state: 'error', message: 'fail' };

function useParsedEvents() {
  mocks.parseServerEvent.mockImplementation((event) => event as ServerEvent);
  mocks.getSessionIdsForEvent.mockImplementation((event: ServerEvent) => {
    const sessionID = (event.properties as { sessionID?: unknown } | undefined)?.sessionID;
    return typeof sessionID === 'string' ? [sessionID] : [];
  });
}

describe('ServerEventBridge', () => {
  it('creates separate left attention and right OpenCode status items', () => {
    const { bridge } = createMocks();
    expect(mocks.createStatusBarItem).toHaveBeenCalledWith('varro.session-status', 1, 1000);
    expect(mocks.createStatusBarItem).toHaveBeenCalledWith('varro.opencode-version', 2, 1000);
    expect(bridge.getStatusBarItem()).toMatchObject({
      name: 'Varro Attention',
      command: 'varro.chat.statusBarClick',
    });
    expect(bridge.getOpenCodeStatusBarItem()).toMatchObject({
      name: 'OpenCode Version',
    });
    expect(bridge.getOpenCodeStatusBarItem().command).toBe('');
  });

  it('returns default status { state: "stopped" }', () => {
    const { bridge } = createMocks();
    expect(bridge.getStatus()).toEqual({ state: 'stopped' });
  });

  it('getStatusBarItem returns the created item', () => {
    const { bridge } = createMocks();
    const item = bridge.getStatusBarItem();
    const lastResult = mocks.createStatusBarItem.mock.results.at(-1)!.value;
    expect(item).toBe(lastResult);
  });

  it('returns the right-aligned OpenCode item separately', () => {
    const { bridge } = createMocks();
    const item = bridge.getOpenCodeStatusBarItem();
    const openCodeCallIndex = mocks.createStatusBarItem.mock.calls.findLastIndex(
      ([id]) => id === 'varro.opencode-version'
    );
    expect(item).toBe(mocks.createStatusBarItem.mock.results[openCodeCallIndex]!.value);
  });

  it('attach registers server handlers and calls updateStatusBarItem', () => {
    const { bridge, server, updateStatusBarItem } = createMocks();
    bridge.attach();
    expect(server.on).toHaveBeenCalledWith('status', expect.any(Function));
    expect(server.on).toHaveBeenCalledWith('event', expect.any(Function));
    expect(updateStatusBarItem).toHaveBeenCalledOnce();
  });

  it('does not register duplicate server handlers when attached repeatedly', () => {
    const { bridge, server, updateStatusBarItem } = createMocks();

    bridge.attach();
    bridge.attach();

    expect(server.on).toHaveBeenCalledTimes(2);
    expect(updateStatusBarItem).toHaveBeenCalledOnce();
  });

  it('status handler updates status and posts server/status', () => {
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    handlers.status!(RUNNING_STATUS);
    expect(bridge.getStatus()).toBe(RUNNING_STATUS);
    expect(post).toHaveBeenCalledWith({ type: 'server/status', payload: RUNNING_STATUS });
  });

  it('status handler clears provider limit cache when shouldClearCache returns true', () => {
    const { bridge, handlers, providerLimitService } = createMocks();
    providerLimitService.shouldClearCache.mockReturnValue(true);
    bridge.attach();
    handlers.status!(RUNNING_STATUS);
    expect(providerLimitService.shouldClearCache).toHaveBeenCalledWith(
      { state: 'stopped' },
      RUNNING_STATUS
    );
    expect(providerLimitService.clearCache).toHaveBeenCalledOnce();
  });

  it('status handler does not clear cache when shouldClearCache returns false', () => {
    const { bridge, handlers, providerLimitService } = createMocks();
    bridge.attach();
    handlers.status!(RUNNING_STATUS);
    expect(providerLimitService.clearCache).not.toHaveBeenCalled();
  });

  it('status handler tracks previous status across multiple updates', () => {
    const { bridge, handlers, providerLimitService } = createMocks();
    bridge.attach();
    handlers.status!(STARTING_STATUS);
    handlers.status!(RUNNING_STATUS);
    expect(providerLimitService.shouldClearCache).toHaveBeenLastCalledWith(
      STARTING_STATUS,
      RUNNING_STATUS
    );
  });

  it('event handler posts parsed event and calls handleServerEvent', () => {
    const { bridge, handlers, post, sessionState } = createMocks();
    const parsed = { type: 'session.created' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue([]);
    bridge.attach();
    handlers.event!({ type: 'session.created' });
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('bounds diff details in server events before persisting or posting them', () => {
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    const event = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          summary: {
            diffs: Array.from({ length: 101 }, (_, index) => ({
              file: `vendor/package-${index}/index.js`,
              additions: 1,
              deletions: 2,
              before: 'large before content',
              after: 'large after content',
            })),
          },
        },
      },
    } as ServerEvent;
    bridge.attach();

    handlers.event!(event);

    const forwarded = (sessionState.handleServerEvent as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as ServerEvent;
    const summary = (forwarded.properties as { info: { summary: Record<string, unknown> } }).info
      .summary as {
      diffs: unknown[];
      diffCount: number;
      diffsOmitted: boolean;
      diffsTruncated: boolean;
    };
    expect(summary.diffs).toEqual([]);
    expect(summary.diffCount).toBe(101);
    expect(summary.diffsOmitted).toBe(true);
    expect(summary.diffsTruncated).toBe(true);
    expect(JSON.stringify(forwarded)).not.toContain('large before content');
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: forwarded });
  });

  it('filters generated dependencies from live session diffs', () => {
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    const event = {
      type: 'session.diff',
      properties: {
        sessionID: 'session-1',
        diff: [
          { file: 'src/index.ts', additions: 1, deletions: 0 },
          { file: 'node_modules/pkg/index.js', additions: 10, deletions: 0 },
        ],
      },
    } as ServerEvent;
    bridge.attach();

    handlers.event!(event);

    expect(post).toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        type: 'session.diff',
        properties: {
          sessionID: 'session-1',
          diff: [{ file: 'src/index.ts', additions: 1, deletions: 0 }],
        },
      },
    });
  });

  it('applies an event ID only once', () => {
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    const event = { id: 'event-1', type: 'session.created', seq: 1 } as ServerEvent;
    bridge.attach();

    handlers.event!(event);
    handlers.event!(event);

    expect(sessionState.handleServerEvent).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledOnce();
  });

  it('does not suppress distinct event IDs', () => {
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    const first = { id: 'event-1', type: 'session.created', seq: 1 } as ServerEvent;
    const second = { id: 'event-2', type: 'session.created', seq: 1 } as ServerEvent;
    bridge.attach();

    handlers.event!(first);
    handlers.event!(second);

    expect(sessionState.handleServerEvent).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map(([message]) => message.payload)).toEqual([first, second]);
  });

  it('applies a direct mutation once and forwards its sync sequence metadata', () => {
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    const direct = { id: 'event-1', type: 'session.created' } as ServerEvent;
    const sync = { ...direct, seq: 1 } as ServerEvent;
    bridge.attach();

    handlers.event!(direct);
    handlers.event!(sync);

    expect(sessionState.handleServerEvent).toHaveBeenCalledOnce();
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(direct);
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { type: 'server/event', payload: direct },
      { type: 'server/event', payload: { ...sync, sequenceOnly: true } },
    ]);
  });

  it('applies a direct synchronized event when no sync twin arrives', () => {
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    const direct = { id: 'event-1', type: 'session.created' } as ServerEvent;
    bridge.attach();

    handlers.event!(direct);

    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(direct);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: direct });
  });

  it('forwards sequence metadata when a sync twin arrives after the fallback window', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    const direct = { id: 'event-1', type: 'session.updated' } as ServerEvent;
    const sync = { ...direct, seq: 2 } as ServerEvent;
    bridge.attach();

    handlers.event!(direct);
    vi.advanceTimersByTime(100);
    handlers.event!(sync);

    expect(sessionState.handleServerEvent).toHaveBeenCalledOnce();
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(direct);
    expect(post.mock.calls.map(([message]) => message.payload)).toEqual([
      direct,
      { ...sync, sequenceOnly: true },
    ]);
    vi.useRealTimers();
  });

  it('forwards a legacy durable compaction delta sequence without applying it twice', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    const direct = {
      id: 'event-1',
      type: 'session.next.compaction.delta',
      properties: { sessionID: 'session-1', messageID: 'message-1', text: 'summary' },
    } satisfies ServerEvent;
    const sync = { ...direct, seq: 2 } satisfies ServerEvent;
    bridge.attach();

    handlers.event!(direct);
    handlers.event!(sync);

    expect(sessionState.handleServerEvent).toHaveBeenCalledOnce();
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(direct);
    expect(post.mock.calls.map(([message]) => message.payload)).toEqual([
      direct,
      { ...sync, sequenceOnly: true },
    ]);
    vi.useRealTimers();
  });

  it('does not suppress ID-less ephemeral deltas', () => {
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    const delta = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'metadata',
        delta: 'a',
      },
    } satisfies ServerEvent;
    bridge.attach();

    handlers.event!(delta);
    handlers.event!(delta);

    expect(sessionState.handleServerEvent).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map(([message]) => message.payload)).toEqual([delta, delta]);
  });

  it('bounds remembered event IDs and eventually admits an evicted ID', () => {
    useParsedEvents();
    const { bridge, handlers, sessionState } = createMocks();
    const oldest = { id: 'event-0', type: 'session.created', seq: 1 } as ServerEvent;
    bridge.attach();

    handlers.event!(oldest);
    handlers.event!(oldest);
    for (let index = 1; index <= 1_024; index += 1) {
      handlers.event!({
        id: `event-${index}`,
        type: 'session.created',
        seq: 1,
      } as ServerEvent);
    }
    handlers.event!(oldest);

    expect(sessionState.handleServerEvent).toHaveBeenCalledTimes(1_026);
  });

  it.each([
    [
      'message.part.delta',
      {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'a',
      },
      'delta',
    ],
    [
      'session.next.text.delta',
      {
        sessionID: 'session-1',
        assistantMessageID: 'message-1',
        textID: 'text-1',
        delta: 'a',
      },
      'delta',
    ],
    [
      'session.next.reasoning.delta',
      {
        sessionID: 'session-1',
        assistantMessageID: 'message-1',
        reasoningID: 'reasoning-1',
        delta: 'a',
      },
      'delta',
    ],
    [
      'session.next.tool.input.delta',
      {
        sessionID: 'session-1',
        assistantMessageID: 'message-1',
        callID: 'call-1',
        delta: 'a',
      },
      'delta',
    ],
    [
      'session.next.compaction.delta',
      { sessionID: 'session-1', messageID: 'message-1', text: 'a' },
      'text',
    ],
  ] as const)('coalesces adjacent %s fragments', (type, properties, fragmentField) => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    bridge.attach();
    const first = { type, properties } as ServerEvent;
    const second = {
      type,
      properties: { ...properties, [fragmentField]: 'b' },
    } as ServerEvent;

    handlers.event!(first);
    handlers.event!(second);

    expect(sessionState.handleServerEvent).toHaveBeenNthCalledWith(1, first);
    expect(sessionState.handleServerEvent).toHaveBeenNthCalledWith(2, second);
    expect(post).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        ...second,
        properties: { ...second.properties, [fragmentField]: 'ab' },
      },
    });
    vi.useRealTimers();
  });

  it('coalesces rapid tool progress to the latest snapshot', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    bridge.attach();
    const first = {
      type: 'session.next.tool.progress',
      properties: {
        sessionID: 'session-1',
        callID: 'call-1',
        content: [{ type: 'text', text: 'first' }],
        structured: { files: [{ relativePath: 'src/a.ts' }] },
      },
    } satisfies ServerEvent;

    handlers.event!(first);
    for (let index = 1; index <= 1_000; index += 1) {
      handlers.event!({
        type: 'session.next.tool.progress',
        properties: {
          sessionID: 'session-1',
          callID: 'call-1',
          content: [{ type: 'text', text: `update-${index}` }],
          structured: { percent: index / 10 },
        },
      } satisfies ServerEvent);
    }

    expect(sessionState.handleServerEvent).toHaveBeenCalledTimes(1_001);
    expect(post).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        type: 'session.next.tool.progress',
        properties: {
          sessionID: 'session-1',
          callID: 'call-1',
          content: [{ type: 'text', text: 'update-1000' }],
          structured: {
            percent: 100,
          },
        },
      },
    });
    vi.useRealTimers();
  });

  it('coalesces direct tool progress events with their sequenced sync twins', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    bridge.attach();

    for (let index = 1; index <= 1_000; index += 1) {
      const direct = {
        id: `progress-${index}`,
        type: 'session.next.tool.progress',
        properties: {
          sessionID: 'session-1',
          callID: 'call-1',
          structured: { percent: index / 10 },
        },
      } satisfies ServerEvent;
      handlers.event!(direct);
      handlers.event!({ ...direct, seq: index } satisfies ServerEvent);
    }

    expect(sessionState.handleServerEvent).toHaveBeenCalledTimes(1_000);
    expect(post).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      {
        type: 'server/event',
        payload: {
          id: 'progress-1000',
          type: 'session.next.tool.progress',
          properties: {
            sessionID: 'session-1',
            callID: 'call-1',
            structured: { percent: 100 },
          },
        },
      },
      {
        type: 'server/event',
        payload: {
          id: 'progress-1000',
          type: 'session.next.tool.progress',
          seq: 1000,
          sequenceOnly: true,
          sequenceStart: 1,
          properties: { sessionID: 'session-1' },
        },
      },
    ]);
    vi.useRealTimers();
  });

  it('forwards a noncontiguous progress twin separately so a cold cursor detects the gap', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();

    for (const seq of [1, 3]) {
      const direct = {
        id: `progress-${seq}`,
        type: 'session.next.tool.progress',
        properties: {
          sessionID: 'session-1',
          callID: `call-${seq}`,
          structured: { percent: seq },
        },
      } satisfies ServerEvent;
      handlers.event!(direct);
      handlers.event!({ ...direct, seq } satisfies ServerEvent);
    }
    vi.advanceTimersByTime(16);

    expect(post.mock.calls.map(([message]) => message.payload)).toEqual([
      {
        id: 'progress-1',
        type: 'session.next.tool.progress',
        properties: {
          sessionID: 'session-1',
          callID: 'call-1',
          structured: { percent: 1 },
        },
      },
      {
        id: 'progress-3',
        type: 'session.next.tool.progress',
        properties: {
          sessionID: 'session-1',
          callID: 'call-3',
          structured: { percent: 3 },
        },
      },
      {
        id: 'progress-1',
        type: 'session.next.tool.progress',
        seq: 1,
        sequenceOnly: true,
        sequenceStart: 1,
        properties: { sessionID: 'session-1' },
      },
      {
        id: 'progress-3',
        type: 'session.next.tool.progress',
        seq: 3,
        sequenceOnly: true,
        properties: {
          sessionID: 'session-1',
          callID: 'call-3',
          structured: { percent: 3 },
        },
      },
    ]);
    vi.useRealTimers();
  });

  it('replaces omitted progress properties and structured fields with the latest snapshot', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();

    handlers.event!({
      type: 'session.next.tool.progress',
      properties: {
        sessionID: 'session-1',
        callID: 'call-1',
        content: [{ type: 'text', text: 'stale' }],
        structured: { files: [{ relativePath: 'src/a.ts' }] },
      },
    } satisfies ServerEvent);
    handlers.event!({
      type: 'session.next.tool.progress',
      properties: {
        sessionID: 'session-1',
        callID: 'call-1',
        structured: { percent: 50 },
      },
    } satisfies ServerEvent);
    vi.advanceTimersByTime(16);

    expect(post).toHaveBeenCalledWith({
      type: 'server/event',
      payload: {
        type: 'session.next.tool.progress',
        properties: {
          sessionID: 'session-1',
          callID: 'call-1',
          structured: {
            percent: 50,
          },
        },
      },
    });
    vi.useRealTimers();
  });

  it('flushes pending tool progress before tool completion', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    const progress = {
      type: 'session.next.tool.progress',
      properties: { sessionID: 'session-1', callID: 'call-1', progress: 'working' },
    } satisfies ServerEvent;
    const success = {
      type: 'session.next.tool.success',
      properties: {
        sessionID: 'session-1',
        callID: 'call-1',
        content: [{ type: 'text', text: 'done' }],
      },
    } satisfies ServerEvent;

    handlers.event!(progress);
    handlers.event!(success);

    expect(post.mock.calls.map(([message]) => message.payload)).toEqual([progress, success]);
    vi.runAllTimers();
    expect(post).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not batch sequenced tool progress', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    const progress = {
      type: 'session.next.tool.progress',
      properties: { sessionID: 'session-1', callID: 'call-1', progress: 'working' },
      seq: 1,
    } satisfies ServerEvent;

    handlers.event!(progress);

    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: progress });
    vi.runAllTimers();
    expect(post).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('flushes a pending delta through the public ordering hook', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    const delta = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'late',
      },
    } satisfies ServerEvent;
    bridge.attach();
    handlers.event!(delta);

    (bridge as unknown as { flushPendingEvents(): void }).flushPendingEvents();
    vi.runAllTimers();

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: delta });
    vi.useRealTimers();
  });

  it('coalesces interleaved delta streams in first-seen key order', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post, sessionState } = createMocks();
    bridge.attach();
    const first = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'a',
      },
    } satisfies ServerEvent;
    const second = {
      ...first,
      properties: { ...first.properties, partID: 'part-2', delta: 'b' },
    } satisfies ServerEvent;
    const third = {
      ...first,
      properties: { ...first.properties, delta: 'c' },
    } satisfies ServerEvent;

    handlers.event!(first);
    handlers.event!(second);
    handlers.event!(third);

    expect(sessionState.handleServerEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      second,
      third,
    ]);
    expect(post).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);

    expect(post.mock.calls.map(([message]) => message.payload)).toEqual([
      {
        ...third,
        properties: { ...third.properties, delta: 'ac' },
      },
      second,
    ]);
    vi.useRealTimers();
  });

  it('flushes a pending delta before a durable event or status update', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    const delta = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'a',
      },
    } satisfies ServerEvent;
    const durable = {
      type: 'session.status',
      properties: { sessionID: 'session-1', status: { type: 'idle' } },
      seq: 1,
    } satisfies ServerEvent;

    handlers.event!(delta);
    handlers.event!(durable);
    handlers.event!(delta);
    handlers.status!(RUNNING_STATUS);

    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { type: 'server/event', payload: delta },
      { type: 'server/event', payload: durable },
      { type: 'server/event', payload: delta },
      { type: 'server/status', payload: RUNNING_STATUS },
    ]);
    vi.useRealTimers();
  });

  it('does not batch sequenced or non-text part deltas', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    const sequenced = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'a',
      },
      seq: 1,
    } satisfies ServerEvent;
    const metadata = {
      ...sequenced,
      seq: undefined,
      properties: { ...sequenced.properties, field: 'metadata' },
    } satisfies ServerEvent;

    handlers.event!(sequenced);
    handlers.event!(metadata);

    expect(post.mock.calls.map(([message]) => message.payload)).toEqual([sequenced, metadata]);
    vi.useRealTimers();
  });

  it('event handler skips null parse results', () => {
    const { bridge, handlers, post, sessionState } = createMocks();
    mocks.parseServerEvent.mockReturnValue(null);
    bridge.attach();
    handlers.event!({ bogus: true });
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('logs unknown event types at most once per minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
    const { bridge, handlers } = createMocks();
    mocks.parseServerEvent.mockReturnValue(null);
    bridge.attach();

    handlers.event!({ payload: { type: 'future.event' } });
    handlers.event!({ payload: { type: 'future.event' } });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(1);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'Ignoring unknown OpenCode event type: future.event'
    );

    vi.advanceTimersByTime(60_000);
    handlers.event!({ payload: { type: 'future.event' } });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does not log malformed values without an event discriminator', () => {
    mocks.loggerWarn.mockClear();
    const { bridge, handlers } = createMocks();
    mocks.parseServerEvent.mockReturnValue(null);
    bridge.attach();
    handlers.event!({ bogus: true });
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it('event handler suppresses events for hidden sessions', () => {
    const { bridge, handlers, post, sessionState, sessionTrash } = createMocks();
    const parsed = { type: 'session.updated' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['hidden-session']);
    sessionTrash.isHidden.mockReturnValue(true);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('observes and suppresses a pending-title session.created with a real manager', () => {
    const hiddenSessions = new HiddenSessionManager();
    hiddenSessions.registerPendingTitle('Internal session');
    const { bridge, handlers, post, sessionState } = createMocks({ hiddenSessions });
    const parsed = {
      type: 'session.created' as const,
      properties: {
        info: { id: 'internal-session', title: 'Internal session' },
      },
    };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['internal-session']);

    bridge.attach();
    handlers.event!({});

    expect(hiddenSessions.isHidden('internal-session')).toBe(true);
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('forwards sibling workspace metadata for endpoint-level routing', () => {
    const { bridge, handlers, post, sessionState } = createMocks({ workspacePath: '/repo' });
    const parsed = {
      type: 'session.updated' as const,
      properties: { info: { id: 'nested-session', directory: '/repo/project-a' } },
    };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['nested-session']);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('accepts UNC session metadata with equivalent casing and separators', () => {
    const { bridge, handlers, post, sessionState } = createMocks({
      workspacePath: '\\\\BuildServer\\Projects\\Varro',
    });
    const parsed = {
      type: 'session.updated' as const,
      properties: { info: { id: 'unc-session', directory: '//buildserver/PROJECTS/varro/' } },
    };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['unc-session']);
    bridge.attach();
    handlers.event!({});

    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('forwards sibling session events for endpoint-level routing', () => {
    const { bridge, handlers, post, sessionState } = createMocks({
      workspacePath: '/repo',
      isSessionInWorkspace: () => false,
    });
    const parsed = { type: 'permission.asked' as const, properties: { sessionID: 'session-1' } };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['session-1']);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('does not treat an unknown session directory as a foreign workspace', () => {
    const { bridge, handlers, post, sessionState } = createMocks({
      workspacePath: '/repo',
      getSessionWorkspaceMatch: () => undefined,
    });
    const parsed = { type: 'session.status' as const, properties: { sessionID: 'session-1' } };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['session-1']);

    bridge.attach();
    handlers.event!({});

    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('event handler does not suppress when session is not hidden', () => {
    const { bridge, handlers, post, sessionState, sessionTrash } = createMocks();
    const parsed = { type: 'session.updated' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['visible-session']);
    sessionTrash.isHidden.mockReturnValue(false);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: parsed });
  });

  it('event handler does not suppress when event has no session IDs', () => {
    const { bridge, handlers, sessionState } = createMocks();
    const parsed = { type: 'mcp.tools.changed' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue([]);
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).toHaveBeenCalledWith(parsed);
  });

  it('dispose persists session state', async () => {
    const { bridge, sessionState } = createMocks();
    bridge.attach();
    await bridge.dispose();
    expect(sessionState.persist).toHaveBeenCalledOnce();
    expect(sessionState.flush).toHaveBeenCalledOnce();
  });

  it('dispose flushes a pending delta exactly once', async () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    const delta = {
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'a',
      },
    } satisfies ServerEvent;
    handlers.event!(delta);

    await bridge.dispose();
    vi.runAllTimers();

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: delta });
    vi.useRealTimers();
  });

  it('dispose waits for the latest queued session-state write', async () => {
    const { bridge, sessionState } = createMocks();
    let releaseFlush: (() => void) | undefined;
    sessionState.flush.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseFlush = resolve;
        })
    );
    const item = bridge.getStatusBarItem();
    bridge.attach();

    const disposing = bridge.dispose();
    await vi.waitFor(() => expect(sessionState.flush).toHaveBeenCalledOnce());
    expect(item.dispose).not.toHaveBeenCalled();
    releaseFlush?.();
    await disposing;

    expect(item.dispose).toHaveBeenCalledOnce();
  });

  it('dispose unregisters both server handlers', async () => {
    const { bridge, server } = createMocks();
    bridge.attach();
    await bridge.dispose();
    expect(server.off).toHaveBeenCalledWith('status', expect.any(Function));
    expect(server.off).toHaveBeenCalledWith('event', expect.any(Function));
  });

  it('dispose disposes the status bar item', async () => {
    const { bridge } = createMocks();
    const attentionItem = bridge.getStatusBarItem();
    const openCodeItem = bridge.getOpenCodeStatusBarItem();
    bridge.attach();
    await bridge.dispose();
    expect(attentionItem.dispose).toHaveBeenCalled();
    expect(openCodeItem.dispose).toHaveBeenCalled();
  });

  it('dispose clears handler references', async () => {
    const { bridge, server } = createMocks();
    bridge.attach();
    await bridge.dispose();
    const offCalls = server.off.mock.calls;
    const statusHandler = offCalls.find((c: unknown[]) => (c as string[])[0] === 'status')?.[1];
    const eventHandler = offCalls.find((c: unknown[]) => (c as string[])[0] === 'event')?.[1];
    expect(statusHandler).toBeDefined();
    expect(eventHandler).toBeDefined();
  });

  it('status handler works with error status', () => {
    const { bridge, handlers, post } = createMocks();
    bridge.attach();
    handlers.status!(ERROR_STATUS);
    expect(bridge.getStatus()).toBe(ERROR_STATUS);
    expect(post).toHaveBeenCalledWith({ type: 'server/status', payload: ERROR_STATUS });
  });

  it('event handler handles event with multiple session IDs where some are hidden', () => {
    const { bridge, handlers, sessionState, sessionTrash } = createMocks();
    const parsed = { type: 'session.updated' as const };
    mocks.parseServerEvent.mockReturnValue(parsed);
    mocks.getSessionIdsForEvent.mockReturnValue(['visible', 'hidden']);
    (sessionTrash.isHidden as ReturnType<typeof vi.fn>).mockImplementation(
      (id: unknown) => id === 'hidden'
    );
    bridge.attach();
    handlers.event!({});
    expect(sessionState.handleServerEvent).not.toHaveBeenCalled();
  });
});

describe('ServerEventBridge streaming bounds', () => {
  const DELTA_PROPERTIES = {
    sessionID: 'session-1',
    messageID: 'message-1',
    partID: 'part-1',
    field: 'text',
  };

  function createDelta(delta: string) {
    return {
      type: 'message.part.delta',
      properties: { ...DELTA_PROPERTIES, delta },
    } as ServerEvent;
  }

  it('flushes a batch once it reaches the fragment cap instead of growing without bound', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();

    // 256 fragments fill the batch; the 257th cannot join it and forces a flush.
    for (let index = 0; index < 256; index += 1) handlers.event!(createDelta('a'));
    expect(post).not.toHaveBeenCalled();

    handlers.event!(createDelta('b'));

    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]?.[0]).toEqual({
      type: 'server/event',
      payload: {
        type: 'message.part.delta',
        properties: { ...DELTA_PROPERTIES, delta: 'a'.repeat(256) },
      },
    });

    vi.advanceTimersByTime(16);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toEqual({
      type: 'server/event',
      payload: { type: 'message.part.delta', properties: { ...DELTA_PROPERTIES, delta: 'b' } },
    });
    vi.useRealTimers();
  });

  it('flushes a batch before it exceeds the character cap', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();

    const half = 32 * 1024;
    handlers.event!(createDelta('a'.repeat(half)));
    handlers.event!(createDelta('b'.repeat(half)));
    expect(post).not.toHaveBeenCalled();

    // The batch is exactly at 64KB, so one more character cannot be merged.
    handlers.event!(createDelta('c'));

    expect(post).toHaveBeenCalledOnce();
    const flushed = post.mock.calls[0]?.[0] as
      | { payload: { properties: { delta: string } } }
      | undefined;
    expect(flushed?.payload.properties.delta).toHaveLength(64 * 1024);

    vi.advanceTimersByTime(16);
    expect(post).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('forwards a single oversized fragment immediately without batching it', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();

    const oversized = createDelta('a'.repeat(64 * 1024 + 1));
    handlers.event!(oversized);

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith({ type: 'server/event', payload: oversized });

    // Nothing may remain pending, so no timer can flush a duplicate later.
    vi.advanceTimersByTime(1_000);
    expect(post).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('preserves order when an oversized fragment interrupts an open batch', () => {
    vi.useFakeTimers();
    useParsedEvents();
    const { bridge, handlers, post } = createMocks();
    bridge.attach();

    handlers.event!(createDelta('small'));
    const oversized = {
      ...createDelta('a'.repeat(64 * 1024 + 1)),
      properties: {
        ...DELTA_PROPERTIES,
        partID: 'part-2',
        delta: 'a'.repeat(64 * 1024 + 1),
      },
    } as ServerEvent;
    handlers.event!(oversized);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0]?.[0]).toEqual({
      type: 'server/event',
      payload: { type: 'message.part.delta', properties: { ...DELTA_PROPERTIES, delta: 'small' } },
    });
    expect(post.mock.calls[1]?.[0]).toEqual({ type: 'server/event', payload: oversized });

    vi.advanceTimersByTime(1_000);
    expect(post).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('bounds the unknown event types it remembers for rate limiting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00Z'));
    const { bridge, handlers } = createMocks();
    mocks.parseServerEvent.mockReturnValue(null);
    mocks.loggerWarn.mockClear();
    bridge.attach();

    handlers.event!({ payload: { type: 'unknown-0' } });
    // 100 further types evict the oldest entry from the rate-limit map.
    for (let index = 1; index <= 100; index += 1) {
      handlers.event!({ payload: { type: `unknown-${String(index)}` } });
    }
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(101);

    // Evicted, so it logs again well inside the one-minute window.
    handlers.event!({ payload: { type: 'unknown-0' } });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(102);

    // A type still held in the map stays rate limited.
    handlers.event!({ payload: { type: 'unknown-100' } });
    expect(mocks.loggerWarn).toHaveBeenCalledTimes(102);
    vi.useRealTimers();
  });
});
