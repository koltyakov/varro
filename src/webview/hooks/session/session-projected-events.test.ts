import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, MessageEntry, Part } from '../../types';
import { getToolFileChanges } from '../../lib/tool-file-change';

const { upsertPart, applyMessagePartDelta } = vi.hoisted(() => ({
  upsertPart: vi.fn(),
  applyMessagePartDelta: vi.fn(),
}));

vi.mock('../../lib/stores/session-store', () => ({
  sessionStore: { upsertPart, applyMessagePartDelta },
}));

const { createProjectedSessionEventHandler } = await import('./session-projected-events');

const SESSION_ID = 'session-1';
const MESSAGE_ID = 'assistant-1';
const CALL_ID = 'call-1';

function assistantInfo(id = MESSAGE_ID): AssistantMessage {
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
  };
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(options: { inActiveTree?: boolean; messages?: MessageEntry[] } = {}) {
  const messages: MessageEntry[] = options.messages ?? [{ info: assistantInfo(), parts: [] }];
  const scheduleActiveMessageSync = vi.fn();
  const syncTodosFromMessages = vi.fn();

  // Reflect writes back into the local message list so later events in the same
  // lifecycle observe the part the earlier event created, as they do in the app.
  upsertPart.mockImplementation((part: Part) => {
    const entry = messages.find((message) => message.info.id === part.messageID);
    if (!entry) return;
    const index = entry.parts.findIndex((existing) => existing.id === part.id);
    if (index === -1) entry.parts.push(part);
    else entry.parts[index] = part;
  });

  const handle = createProjectedSessionEventHandler({
    isSessionInActiveTree: () => options.inActiveTree !== false,
    getMessages: () => messages,
    findAssistantMessage: (sessionId, assistantMessageID) =>
      messages.find(
        (message) =>
          message.info.sessionID === sessionId &&
          (!assistantMessageID || message.info.id === assistantMessageID)
      ) ?? null,
    scheduleActiveMessageSync,
    syncTodosFromMessages,
  });

  return { handle, messages, scheduleActiveMessageSync, syncTodosFromMessages };
}

function currentToolPart({ messages }: Harness) {
  const part = messages[0]?.parts.find((entry) => entry.id === CALL_ID);
  if (part?.type !== 'tool') throw new Error('expected a tool part');
  return part;
}

function emit(harness: Harness, event: string, props: Record<string, unknown> = {}) {
  return harness.handle(event, {
    sessionID: SESSION_ID,
    assistantMessageID: MESSAGE_ID,
    callID: CALL_ID,
    ...props,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('projected event routing', () => {
  it('ignores events without a session id or outside the active tree', () => {
    const harness = createHarness();
    expect(harness.handle('session.next.tool.called', { callID: CALL_ID })).toBe(false);

    const inactive = createHarness({ inActiveTree: false });
    expect(emit(inactive, 'session.next.tool.called')).toBe(false);
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('ignores event families it does not project', () => {
    const harness = createHarness();
    expect(emit(harness, 'session.next.step.ended')).toBe(false);
    expect(emit(harness, 'message.part.updated')).toBe(false);
  });

  it('ignores unknown events inside the projected tool family', () => {
    const harness = createHarness();
    expect(emit(harness, 'session.next.tool.unknown')).toBe(false);
    expect(upsertPart).not.toHaveBeenCalled();
  });
});

describe('projected text events', () => {
  it('creates the text part on first delta and applies the delta to it', () => {
    const harness = createHarness();

    expect(emit(harness, 'session.next.text.delta', { textID: 'text-1', delta: 'Hel' })).toBe(true);

    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'text-1', type: 'text', text: '', messageID: MESSAGE_ID })
    );
    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      MESSAGE_ID,
      'text-1',
      'Hel',
      SESSION_ID,
      'text'
    );
  });

  it('falls back to the text field when a delta event omits delta', () => {
    const harness = createHarness();
    emit(harness, 'session.next.text.delta', { textID: 'text-1', text: 'whole chunk' });

    expect(applyMessagePartDelta).toHaveBeenCalledWith(
      MESSAGE_ID,
      'text-1',
      'whole chunk',
      SESSION_ID,
      'text'
    );
  });

  it('does not re-create the text part once it exists', () => {
    const harness = createHarness();
    emit(harness, 'session.next.text.delta', { textID: 'text-1', delta: 'a' });
    upsertPart.mockClear();

    emit(harness, 'session.next.text.delta', { textID: 'text-1', delta: 'b' });
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('writes the authoritative text on text.ended', () => {
    const harness = createHarness();
    emit(harness, 'session.next.text.delta', { textID: 'text-1', delta: 'partial' });
    upsertPart.mockClear();

    expect(emit(harness, 'session.next.text.ended', { textID: 'text-1', text: 'final text' })).toBe(
      true
    );
    expect(upsertPart).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'text-1', type: 'text', text: 'final text' })
    );
  });

  it('clears the part text when text.ended carries no text', () => {
    const harness = createHarness();
    emit(harness, 'session.next.text.ended', { textID: 'text-1' });

    expect(upsertPart).toHaveBeenCalledWith(expect.objectContaining({ id: 'text-1', text: '' }));
  });

  it('requires a textID', () => {
    const harness = createHarness();
    expect(emit(harness, 'session.next.text.delta', { delta: 'orphan' })).toBe(false);
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('schedules a resync instead of projecting when the assistant message is not loaded', () => {
    const harness = createHarness({ messages: [] });

    expect(emit(harness, 'session.next.text.delta', { textID: 'text-1', delta: 'a' })).toBe(false);
    expect(emit(harness, 'session.next.text.ended', { textID: 'text-1', text: 'a' })).toBe(false);
    expect(harness.scheduleActiveMessageSync).toHaveBeenCalledWith(SESSION_ID);
    expect(upsertPart).not.toHaveBeenCalled();
  });
});

describe('projected tool input lifecycle', () => {
  it('creates a pending tool part on input.started', () => {
    const harness = createHarness();

    expect(emit(harness, 'session.next.tool.input.started', { name: 'bash' })).toBe(true);
    expect(currentToolPart(harness)).toMatchObject({
      tool: 'bash',
      state: { status: 'pending', input: {}, raw: '' },
    });
  });

  it('accumulates raw input across successive input deltas', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.input.started', { name: 'bash' });
    emit(harness, 'session.next.tool.input.delta', { delta: '{"comm' });
    emit(harness, 'session.next.tool.input.delta', { delta: 'and":"ls"}' });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'pending',
      input: { command: 'ls' },
      raw: '{"command":"ls"}',
    });
  });

  it('exposes a completed apply_patch input before input.ended', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.input.started', { name: 'apply_patch' });
    emit(harness, 'session.next.tool.input.delta', {
      delta: JSON.stringify({
        patchText: '*** Begin Patch\n*** Add File: src/new.ts\n+export const value = true;\n*** End Patch',
      }),
    });

    const part = currentToolPart(harness);
    expect(part.state).toMatchObject({
      status: 'pending',
      input: {
        patchText: '*** Begin Patch\n*** Add File: src/new.ts\n+export const value = true;\n*** End Patch',
      },
    });
    expect(getToolFileChanges(part.tool, part.state)).toMatchObject([
      { kind: 'added', path: 'src/new.ts' },
    ]);
  });

  it('drops an input delta that arrives before input.started', () => {
    const harness = createHarness();

    expect(emit(harness, 'session.next.tool.input.delta', { delta: '{"a":1}' })).toBe(true);
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('drops an input delta once the tool is past pending', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', { name: 'bash', input: { command: 'ls' } });
    upsertPart.mockClear();

    expect(emit(harness, 'session.next.tool.input.delta', { delta: 'late' })).toBe(true);
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('parses the accumulated input on input.ended', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.input.started', { name: 'bash' });
    emit(harness, 'session.next.tool.input.ended', { name: 'bash', input: '{"command":"ls -la"}' });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'pending',
      input: { command: 'ls -la' },
      raw: '{"command":"ls -la"}',
    });
  });

  it('keeps an empty input when input.ended carries malformed JSON', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.input.started', { name: 'bash' });
    emit(harness, 'session.next.tool.input.ended', { name: 'bash', input: '{"command":' });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'pending',
      input: {},
      raw: '{"command":',
    });
  });

  it('carries the tool name forward from the existing part when an event omits it', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.input.started', { name: 'bash' });
    emit(harness, 'session.next.tool.input.ended', { input: '{}' });

    expect(currentToolPart(harness).tool).toBe('bash');
  });

  it('requires a call id', () => {
    const harness = createHarness();
    expect(harness.handle('session.next.tool.called', { sessionID: SESSION_ID })).toBe(false);
    expect(
      harness.handle('session.next.tool.called', { sessionID: SESSION_ID, callID: CALL_ID })
    ).toBe(true);
    expect(
      harness.handle('session.next.tool.called', {
        sessionID: SESSION_ID,
        assistantMessageID: MESSAGE_ID,
      })
    ).toBe(false);
    expect(currentToolPart(harness).messageID).toBe(MESSAGE_ID);
  });

  it('falls back to the latest active assistant when the streamed assistant id does not match', () => {
    const harness = createHarness();

    expect(
      emit(harness, 'session.next.tool.input.started', {
        assistantMessageID: 'v2-assistant-1',
        name: 'apply_patch',
      })
    ).toBe(true);
    expect(currentToolPart(harness)).toMatchObject({
      messageID: MESSAGE_ID,
      tool: 'apply_patch',
      state: { status: 'pending' },
    });
    expect(harness.scheduleActiveMessageSync).not.toHaveBeenCalled();
  });

  it('schedules a resync when the owning assistant message is not loaded', () => {
    const harness = createHarness({ messages: [] });

    expect(emit(harness, 'session.next.tool.called', { name: 'bash' })).toBe(false);
    expect(harness.scheduleActiveMessageSync).toHaveBeenCalledWith(SESSION_ID);
    expect(upsertPart).not.toHaveBeenCalled();
  });
});

describe('projected tool execution', () => {
  it('moves the tool to running with a start time on tool.called', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', {
      name: 'bash',
      input: { command: 'ls' },
      provider: { vendor: 'local' },
      timestamp: 1000,
    });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'running',
      input: { command: 'ls' },
      title: 'bash',
      metadata: { vendor: 'local' },
      time: { start: 1000 },
    });
  });

  it('parses JSON text tool input', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', {
      name: 'apply_patch',
      input: JSON.stringify({
        patchText: '*** Begin Patch\n*** Add File: src/new.ts\n+content\n*** End Patch',
      }),
    });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'running',
      input: {
        patchText: '*** Begin Patch\n*** Add File: src/new.ts\n+content\n*** End Patch',
      },
    });
  });

  it('preserves parsed pending input when tool.called omits usable input', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.input.ended', {
      name: 'write',
      input: '{"filePath":"src/new.ts","content":"value"}',
    });
    emit(harness, 'session.next.tool.called', { name: 'write', input: '' });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'running',
      input: { filePath: 'src/new.ts', content: 'value' },
    });
  });

  it('merges progress metadata into a running tool', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', { name: 'bash', timestamp: 1000 });
    emit(harness, 'session.next.tool.progress', {
      progress: 'working',
      structured: { pct: 40 },
      content: [{ type: 'text', text: 'working' }],
    });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'running',
      time: { start: 1000 },
      metadata: {
        pct: 40,
        structured: { pct: 40 },
        content: [{ type: 'text', text: 'working' }],
        progress: 'working',
      },
    });
  });

  it('exposes structured file progress as running file metadata', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', { name: 'write', timestamp: 1000 });
    emit(harness, 'session.next.tool.progress', {
      structured: {
        files: [{ type: 'create', relativePath: 'src/new.ts' }],
      },
    });

    const part = currentToolPart(harness);
    expect(part.state).toMatchObject({
      status: 'running',
      metadata: {
        files: [{ type: 'create', relativePath: 'src/new.ts' }],
      },
    });
    expect(getToolFileChanges(part.tool, part.state)).toMatchObject([
      { kind: 'added', path: 'src/new.ts' },
    ]);
  });

  it('ignores progress for a tool that is not running', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.input.started', { name: 'bash' });
    upsertPart.mockClear();

    expect(emit(harness, 'session.next.tool.progress', { structured: { pct: 40 } })).toBe(true);
    expect(upsertPart).not.toHaveBeenCalled();
  });

  it('completes the tool while preserving the original input and start time', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', {
      name: 'bash',
      input: { command: 'ls' },
      timestamp: 1000,
    });
    emit(harness, 'session.next.tool.success', {
      name: 'bash',
      content: [{ type: 'text', text: 'file-a\nfile-b' }],
      result: 'ok',
      timestamp: 1500,
    });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'completed',
      input: { command: 'ls' },
      output: 'file-a\nfile-b',
      title: 'bash',
      metadata: { result: 'ok' },
      time: { start: 1000, end: 1500 },
    });
    expect(harness.syncTodosFromMessages).toHaveBeenCalledTimes(1);
  });

  it('serializes structured output when success carries no content text', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', { name: 'read', timestamp: 1000 });
    emit(harness, 'session.next.tool.success', {
      name: 'read',
      structured: { lines: 12 },
      timestamp: 1200,
    });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'completed',
      output: JSON.stringify({ lines: 12 }, null, 2),
      metadata: { lines: 12 },
    });
  });

  it('records a zero-length window when success arrives without a prior tool part', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.success', {
      name: 'bash',
      content: [{ type: 'text', text: 'done' }],
      timestamp: 1500,
    });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'completed',
      input: {},
      time: { start: 1500, end: 1500 },
    });
  });

  it('fails the tool while preserving the original input and start time', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', {
      name: 'bash',
      input: { command: 'ls' },
      timestamp: 1000,
    });
    emit(harness, 'session.next.tool.failed', {
      name: 'bash',
      error: { message: 'permission denied' },
      timestamp: 1800,
    });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'error',
      input: { command: 'ls' },
      error: 'permission denied',
      time: { start: 1000, end: 1800 },
    });
    expect(harness.syncTodosFromMessages).toHaveBeenCalledTimes(1);
  });

  it('uses a generic message when a failure carries no usable error', () => {
    const harness = createHarness();
    emit(harness, 'session.next.tool.called', { name: 'bash', timestamp: 1000 });
    emit(harness, 'session.next.tool.failed', { name: 'bash', timestamp: 1800 });

    expect(currentToolPart(harness).state).toMatchObject({
      status: 'error',
      error: 'Tool execution failed',
    });
  });
});
