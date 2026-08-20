import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, MessageEntry, Part } from '../../types';
import type { ServerEvent } from '../../../shared/protocol';

const { serverEventsOn, upsertPart, applyMessagePartDelta, markLoadingActivity } = vi.hoisted(
  () => ({
    serverEventsOn: vi.fn(),
    upsertPart: vi.fn(),
    applyMessagePartDelta: vi.fn(),
    markLoadingActivity: vi.fn(),
  })
);

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise reasoning-event integration across store modules. */
vi.mock('../../lib/client', () => ({ serverEvents: { on: serverEventsOn } }));
vi.mock('../../lib/stores/session-store', () => ({
  sessionStore: { upsertPart, applyMessagePartDelta },
}));
vi.mock('../../lib/stores/ui-store', () => ({ uiStore: { markLoadingActivity } }));

const { registerReasoningEventHandlers } = await import('./session-reasoning-events');

const SESSION_ID = 'session-1';
const MESSAGE_ID = 'assistant-1';
const REASONING_ID = 'reasoning-1';

function assistantInfo(id: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id,
    sessionID: SESSION_ID,
    role: 'assistant',
    time: { created: 0 },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'default',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function entry(id: string, overrides: Partial<AssistantMessage> = {}, parts: Part[] = []) {
  return { info: assistantInfo(id, overrides), parts } satisfies MessageEntry;
}

type Options = {
  messages?: MessageEntry[];
  syncSessionMessages?: () => Promise<void>;
  inActiveTree?: boolean;
  ignoreCompleted?: boolean;
  ignoreFinished?: boolean;
};

type EventProperties = NonNullable<ServerEvent['properties']>;

function install(options: Options = {}) {
  const handlers = new Map<string, (data: { properties: EventProperties }) => void>();
  serverEventsOn.mockImplementation((event: string, handler: never) => {
    handlers.set(event, handler);
    return () => handlers.delete(event);
  });

  const messages: MessageEntry[] = options.messages ?? [entry(MESSAGE_ID)];
  const logError = vi.fn();
  const markSessionProgress = vi.fn();
  const recordSessionMessageSnapshotMutation = vi.fn();
  const syncSessionMessages = options.syncSessionMessages ?? vi.fn().mockResolvedValue(undefined);

  // Reflect part creation so a second event in the same stream sees it.
  upsertPart.mockImplementation((part: Part) => {
    const owner = messages.find((message) => message.info.id === part.messageID);
    if (owner && !owner.parts.some((existing) => existing.id === part.id)) owner.parts.push(part);
  });

  const cleanups = registerReasoningEventHandlers({
    getMessages: () => messages,
    syncSessionMessages,
    logError,
    isSessionInActiveTree: () => options.inActiveTree !== false,
    markSessionProgress,
    ignoreStaleProgressForCompletedMessage: () => options.ignoreCompleted === true,
    ignoreStaleProgressAfterFinishedAssistant: () => options.ignoreFinished === true,
    recordSessionMessageSnapshotMutation,
  });

  const emit = (event: string, properties: EventProperties) =>
    handlers.get(event)?.({ properties });

  return { cleanups, emit, handlers, logError, markSessionProgress, messages, syncSessionMessages };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reasoning handler registration', () => {
  it('registers and returns a cleanup for each reasoning event', () => {
    const { cleanups, handlers } = install();

    expect([...handlers.keys()]).toEqual([
      'session.next.reasoning.started',
      'session.next.reasoning.delta',
      'session.next.reasoning.ended',
    ]);
    expect(cleanups).toHaveLength(3);

    for (const cleanup of cleanups) cleanup();
    expect(handlers.size).toBe(0);
  });
});

describe('session.next.reasoning.started', () => {
  it('creates an empty reasoning part and marks progress', () => {
    const harness = install();
    harness.emit('session.next.reasoning.started', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
    });

    expect(harness.markSessionProgress).toHaveBeenCalledWith(SESSION_ID);
    expect(markLoadingActivity).toHaveBeenCalledTimes(1);
    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: REASONING_ID,
        type: 'reasoning',
        text: '',
        messageID: MESSAGE_ID,
        sessionID: SESSION_ID,
      })
    );
  });

  it('does not recreate a reasoning part that already exists', () => {
    const existing: Part = {
      id: REASONING_ID,
      sessionID: SESSION_ID,
      messageID: MESSAGE_ID,
      type: 'reasoning',
      text: 'already here',
      time: { start: 0 },
    };
    const harness = install({ messages: [entry(MESSAGE_ID, {}, [existing])] });

    harness.emit('session.next.reasoning.started', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
    });

    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('ignores events with no session id', () => {
    const harness = install();
    harness.emit('session.next.reasoning.started', { reasoningID: REASONING_ID });

    expect(harness.markSessionProgress).not.toHaveBeenCalled();
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('marks progress but does not project when the session is outside the active tree', () => {
    const harness = install({ inActiveTree: false });
    harness.emit('session.next.reasoning.started', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
    });

    expect(harness.markSessionProgress).toHaveBeenCalledWith(SESSION_ID);
    expect(markLoadingActivity).not.toHaveBeenCalled();
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('drops stale progress for an already-completed assistant message', () => {
    const harness = install({ ignoreCompleted: true });
    harness.emit('session.next.reasoning.started', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
    });

    expect(harness.markSessionProgress).not.toHaveBeenCalled();
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('drops unattributed progress after the assistant has finished', () => {
    const harness = install({ ignoreFinished: true });
    harness.emit('session.next.reasoning.started', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
    });

    expect(harness.markSessionProgress).not.toHaveBeenCalled();
    expect(upsertPart).not.toHaveBeenCalled();
  });
});

describe('session.next.reasoning.ended', () => {
  it('writes the authoritative reasoning text, replacing accumulated deltas', () => {
    const harness = install();
    harness.emit('session.next.reasoning.delta', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
      delta: 'partial thought',
    });
    upsertPart.mockClear();

    harness.emit('session.next.reasoning.ended', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
      text: 'the complete reasoning',
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({
        id: REASONING_ID,
        type: 'reasoning',
        text: 'the complete reasoning',
        messageID: MESSAGE_ID,
      })
    );
  });

  it('leaves streamed text untouched when the ended event carries no text', () => {
    const existing: Part = {
      id: REASONING_ID,
      sessionID: SESSION_ID,
      messageID: MESSAGE_ID,
      type: 'reasoning',
      text: 'streamed so far',
      time: { start: 0 },
    };
    const harness = install({ messages: [entry(MESSAGE_ID, {}, [existing])] });

    harness.emit('session.next.reasoning.ended', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
    });

    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('requires a reasoning id', () => {
    const harness = install();
    harness.emit('session.next.reasoning.ended', {
      sessionID: SESSION_ID,
      assistantMessageID: MESSAGE_ID,
      text: 'orphan',
    });

    expect(harness.markSessionProgress).toHaveBeenCalledWith(SESSION_ID);
    expect(upsertPart).not.toHaveBeenCalled();
  });
});

describe('reasoning message resolution', () => {
  it('attaches to the named assistant message even when a newer one is streaming', () => {
    const harness = install({
      messages: [entry(MESSAGE_ID), entry('assistant-2')],
    });

    harness.emit('session.next.reasoning.ended', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
      text: 'attributed',
    });

    expect(upsertPart).toHaveBeenCalledWith(expect.objectContaining({ messageID: MESSAGE_ID }));
  });

  it('falls back to the latest unfinished assistant message when unattributed', () => {
    const harness = install({
      messages: [
        entry('assistant-old', { time: { created: 0, completed: 10 } }),
        entry('assistant-latest'),
      ],
    });

    harness.emit('session.next.reasoning.ended', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      text: 'unattributed',
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({ messageID: 'assistant-latest' })
    );
  });

  it('falls back to the latest message when the named one is not loaded', () => {
    const harness = install({ messages: [entry('assistant-latest')] });

    harness.emit('session.next.reasoning.ended', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: 'assistant-missing',
      text: 'recovered',
    });

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({ messageID: 'assistant-latest' })
    );
  });

  it('syncs messages and retries when no assistant message is loaded yet', async () => {
    const messages: MessageEntry[] = [];
    const syncSessionMessages = vi.fn().mockImplementation(async () => {
      messages.push(entry(MESSAGE_ID));
    });
    const harness = install({ messages, syncSessionMessages });

    harness.emit('session.next.reasoning.ended', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
      text: 'arrived late',
    });

    expect(upsertPart).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(syncSessionMessages).toHaveBeenCalledWith(SESSION_ID));
    await vi.waitFor(() =>
      expect(upsertPart).toHaveBeenCalledWith(
        expect.objectContaining({ id: REASONING_ID, text: 'arrived late' })
      )
    );
  });

  it('logs and gives up when the resync fails', async () => {
    const failure = new Error('sync failed');
    const harness = install({
      messages: [],
      syncSessionMessages: vi.fn().mockRejectedValue(failure),
    });

    harness.emit('session.next.reasoning.started', {
      sessionID: SESSION_ID,
      reasoningID: REASONING_ID,
      assistantMessageID: MESSAGE_ID,
    });

    await vi.waitFor(() =>
      expect(harness.logError).toHaveBeenCalledWith('syncSessionMessages', failure)
    );
    expect(upsertPart).not.toHaveBeenCalled();
  });
});
