import { flush as flushSolid, createEffect, createRoot, reconcile } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebviewMessage } from '../../shared/protocol';
import type { AssistantMessage, Part, Permission, Session, ToolPart } from '../types';
import {
  applyMessagePartDelta,
  addClipboardImage,
  clearMessages,
  clearClipboardImages,
  clearStreamingState,
  finishMessageStreaming,
  addPermission,
  getActiveUsageLimitNotice,
  getMessageById,
  getSessionTreeRootId,
  getSessionTreeIds,
  getPermissionSignature,
  groupPermissions,
  hasActivePermission,
  hasActiveQuestion,
  hasActiveUsageLimit,
  inputText,
  messageStructureVersion,
  removePermission,
  removeMessage,
  removeClipboardImage,
  setClipboardImageContextFile,
  setSessionFailed,
  setInputText,
  setSessionUsageLimit,
  setState,
  state,
  syncClipboardImages,
  syncFailedSessionsFromMessages,
  setMessagesIncremental,
  upsertMessage,
  upsertMessageInfo,
  upsertPart,
} from './state';

function sessionInfo(id: string, title: string, updated: number, parentID?: string): Session {
  const info: Session = {
    id,
    projectID: 'project-1',
    directory: '/',
    title,
    version: '1',
    time: { created: 0, updated },
  };
  if (parentID !== undefined) info.parentID = parentID;
  return info;
}

function assistantMessage(id = 'message-1', sessionID = 'session-1'): AssistantMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 0 },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'default',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function reasoningPart(text: string): Part {
  return {
    id: 'reason-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 0 },
  };
}

function textPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
  };
}

function toolPart(id: string): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'pwd' },
      title: 'Run pwd',
      time: { start: 0 },
    },
  };
}

function pendingToolPart(id: string): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    state: {
      status: 'pending',
      input: {},
      raw: '',
    },
  };
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe('state streaming deltas', () => {
  it('updates usage without structural invalidation, but preserves completion invalidation', () => {
    clearMessages();
    flushSolid();
    const info = assistantMessage();
    upsertMessage({ info, parts: [] });
    flushSolid();
    let roleReads = 0;
    const dispose = createRoot((cleanupRoot) => {
      createEffect(
        () => state.messages[0]?.info.role,
        () => {
          roleReads += 1;
        }
      );
      return cleanupRoot;
    });
    const version = messageStructureVersion();
    const updated = { ...info, cost: 1, tokens: { ...info.tokens, output: 100 } };
    upsertMessageInfo(updated);
    flushSolid();
    expect(messageStructureVersion()).toBe(version);
    expect(roleReads).toBe(1);
    expect(getMessageById(info.id)?.info).toMatchObject({ cost: 1, tokens: { output: 100 } });
    upsertMessageInfo({ ...updated, time: { ...updated.time, completed: 100 } });
    flushSolid();
    expect(messageStructureVersion()).toBeGreaterThan(version);
    dispose();
    flushSolid();
  });

  beforeEach(() => {
    clearMessages();
    flushSolid();
    clearStreamingState();
    flushSolid();
  });

  it('preserves reasoning type when appending a missing streaming part', async () => {
    upsertMessage({ info: assistantMessage(), parts: [] });
    flushSolid();

    applyMessagePartDelta('message-1', 'reason-1', 'Planning', 'session-1', 'text', 'reasoning');
    flushSolid();
    await nextFrame();
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      messageID: 'message-1',
      sessionID: 'session-1',
      type: 'reasoning',
      text: 'Planning',
      time: { start: expect.any(Number) },
    });
  });

  it('preserves an unrelated active stream when removing a message', () => {
    const activePart = textPart('active-part', '');
    upsertMessage({ info: assistantMessage('message-1'), parts: [activePart] });
    flushSolid();
    upsertMessage({ info: assistantMessage('message-2'), parts: [] });
    flushSolid();
    applyMessagePartDelta('message-1', activePart.id, 'Streaming', 'session-1');
    flushSolid();

    removeMessage('session-1', 'message-2');
    flushSolid();

    expect(state.messages).toHaveLength(1);
    expect(state.streamingPartId).toBe(activePart.id);
    expect(state.streamingText).toBe('Streaming');
  });

  it('commits reasoning deltas superseded by text in the same frame', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Planning'), textPart('text-1', '')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'reason-1', ' more', 'session-1');
    flushSolid();
    applyMessagePartDelta('message-1', 'text-1', 'Answer', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Planning more',
    });
    expect(state.messages[0]?.parts[1]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: '',
    });
    expect(state.streamingPartId).toBe('text-1');
    expect(state.streamingText).toBe('Answer');
  });

  it('keeps existing streaming parts in live state until a finalized part update arrives', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', 'Existing answer')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', ' extended', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    expect(state.streamingPartId).toBe('text-1');
    expect(state.streamingText).toBe('Existing answer extended');
    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Existing answer',
    });
  });

  it('keeps active streaming text when a stale finalized part update arrives', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', '')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', 'Visible response', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    upsertPart(textPart('text-1', ''));
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Visible response',
    });
    expect(state.streamingPartId).toBeNull();
    expect(state.streamingText).toBe('');
  });

  it('keeps committed streamed text when a stale finalized update arrives later', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', ''), textPart('text-2', '')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', 'First final response part', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();
    applyMessagePartDelta('message-1', 'text-2', 'Second final response part', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    upsertPart(textPart('text-1', ''));
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'First final response part',
    });
    expect(state.streamingPartId).toBe('text-2');
    expect(state.streamingText).toBe('Second final response part');
  });

  it('keeps projected reasoning text when an active-session refresh is stale', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('**Examining text replacement**')],
    });
    flushSolid();

    setMessagesIncremental(
      [
        {
          info: assistantMessage(),
          parts: [reasoningPart('')],
        },
      ],
      { preserveExtraParts: true }
    );
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: '**Examining text replacement**',
    });
  });

  it('keeps projected tool progress when an active-session refresh is stale', () => {
    const running = { ...toolPart('tool-1'), tool: '' };
    const pending = { ...pendingToolPart('tool-1'), tool: 'functions.apply_patch' };
    upsertMessage({
      info: assistantMessage(),
      parts: [running],
    });
    flushSolid();

    setMessagesIncremental(
      [
        {
          info: assistantMessage(),
          parts: [pending],
        },
      ],
      { preserveExtraParts: true }
    );
    flushSolid();

    const part = state.messages[0]?.parts[0];
    if (!part || part.type !== 'tool') throw new Error('Expected a tool part');
    expect(part.state.status).toBe('running');
    expect(part.tool).toBe('functions.apply_patch');
  });

  it('publishes tool identity learned from a stale progress update', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [{ ...toolPart('tool-1'), tool: '' }],
    });
    flushSolid();
    const version = messageStructureVersion();

    upsertPart({ ...pendingToolPart('tool-1'), tool: 'functions.apply_patch' });
    flushSolid();

    const part = state.messages[0]?.parts[0];
    if (!part || part.type !== 'tool') throw new Error('Expected a tool part');
    expect(part.tool).toBe('functions.apply_patch');
    expect(part.state.status).toBe('running');
    expect(messageStructureVersion()).toBe(version + 1);
  });

  it('does not erase known tool identity when progress advances', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [{ ...pendingToolPart('tool-1'), tool: 'functions.apply_patch' }],
    });
    flushSolid();

    upsertPart({ ...toolPart('tool-1'), tool: '' });
    flushSolid();

    const part = state.messages[0]?.parts[0];
    if (!part || part.type !== 'tool') throw new Error('Expected a tool part');
    expect(part.tool).toBe('functions.apply_patch');
    expect(part.state.status).toBe('running');
  });

  it('commits the previous streaming part text when another part becomes active later', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Thinking'), textPart('text-1', 'Done')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'reason-1', ' carefully', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    expect(state.streamingPartId).toBe('reason-1');
    expect(state.streamingText).toBe('Thinking carefully');
    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Thinking',
    });

    applyMessagePartDelta('message-1', 'text-1', ' already', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Thinking carefully',
    });
    expect(state.streamingPartId).toBe('text-1');
    expect(state.streamingText).toBe('Done already');
  });

  it('resumes streaming from the part text after another part becomes active', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Thinking'), textPart('text-1', 'Done')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'reason-1', ' carefully', 'session-1');
    flushSolid();
    applyMessagePartDelta('message-1', 'text-1', ' already', 'session-1');
    flushSolid();
    applyMessagePartDelta('message-1', 'reason-1', ' now', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Thinking',
    });
    expect(state.streamingPartId).toBe('reason-1');
    expect(state.streamingText).toBe('Thinking carefully now');
  });

  it('commits text deltas that are superseded by thinking in the same frame', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', ''), reasoningPart('')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', 'Visible response', 'session-1');
    flushSolid();
    applyMessagePartDelta('message-1', 'reason-1', 'Thinking now', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Visible response',
    });
    expect(state.streamingPartId).toBe('reason-1');
    expect(state.streamingText).toBe('Thinking now');
  });

  it('commits and clears streaming text when a message finishes', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', '')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', 'Received.', 'session-1');
    flushSolid();
    finishMessageStreaming('message-1');
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Received.',
    });
    expect(state.streamingPartId).toBeNull();
    expect(state.streamingText).toBe('');
  });

  it('does not clear streaming text for a different finished message', async () => {
    upsertMessage({
      info: assistantMessage('message-1'),
      parts: [textPart('text-1', '')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', 'Received.', 'session-1');
    flushSolid();
    finishMessageStreaming('message-2');
    flushSolid();
    await nextFrame();
    flushSolid();

    expect(state.streamingPartId).toBe('text-1');
    expect(state.streamingText).toBe('Received.');
  });

  it('preserves time.completed when an incremental sync lacks it', () => {
    const completed = assistantMessage();
    completed.time.completed = 5000;
    flushSolid();
    upsertMessage({
      info: completed,
      parts: [textPart('text-1', 'Done')],
    });
    flushSolid();

    const withoutCompletion = assistantMessage();
    setMessagesIncremental([{ info: withoutCompletion, parts: [textPart('text-1', 'Done')] }]);
    flushSolid();

    const synced = state.messages[0]?.info;
    if (synced?.role !== 'assistant') throw new Error('Expected an assistant message');
    expect(synced.time.completed).toBe(5000);
  });

  it('preserves error state when an incremental sync lacks it', () => {
    const errored = assistantMessage();
    errored.error = { name: 'rate_limit' };
    flushSolid();
    upsertMessage({
      info: errored,
      parts: [textPart('text-1', 'Partial')],
    });
    flushSolid();

    setMessagesIncremental([{ info: assistantMessage(), parts: [textPart('text-1', 'Partial')] }]);
    flushSolid();

    const synced = state.messages[0]?.info;
    if (synced?.role !== 'assistant') throw new Error('Expected an assistant message');
    expect(synced.error).toEqual({ name: 'rate_limit' });
  });

  it('keeps active streaming text across incremental message refreshes', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', '')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', 'Partial answer', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    setMessagesIncremental(
      [
        {
          info: assistantMessage(),
          parts: [textPart('text-1', ''), toolPart('tool-1')],
        },
      ],
      { preserveExtraParts: true }
    );
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Partial answer',
    });
    expect(state.messages[0]?.parts[1]).toMatchObject({ id: 'tool-1', type: 'tool' });
    expect(state.streamingPartId).toBeNull();
    expect(state.streamingText).toBe('');
  });

  it('flushes pending streaming text before incremental message refreshes', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', '')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', 'Queued answer', 'session-1');
    flushSolid();
    setMessagesIncremental(
      [
        {
          info: assistantMessage(),
          parts: [textPart('text-1', ''), toolPart('tool-1')],
        },
      ],
      { preserveExtraParts: true }
    );
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Queued answer',
    });
    expect(state.streamingPartId).toBeNull();
    expect(state.streamingText).toBe('');
  });

  it('materializes streaming text even when a refresh retains the store entry', async () => {
    upsertMessage({ info: assistantMessage(), parts: [textPart('text-1', '')] });
    flushSolid();
    applyMessagePartDelta('message-1', 'text-1', 'Retained answer', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    setMessagesIncremental([...state.messages]);
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({ text: 'Retained answer' });
    expect(state.streamingPartId).toBeNull();
    expect(state.streamingText).toBe('');
  });

  it('keeps newer snapshot text when clearing streaming state', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', 'Partial')],
    });
    flushSolid();

    applyMessagePartDelta('message-1', 'text-1', ' answer', 'session-1');
    flushSolid();
    await nextFrame();
    flushSolid();

    setMessagesIncremental([
      {
        info: assistantMessage(),
        parts: [textPart('text-1', 'Partial answer complete')],
      },
    ]);
    flushSolid();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Partial answer complete',
    });
    expect(state.streamingPartId).toBeNull();
    expect(state.streamingText).toBe('');
  });

  it('preserves longer current tool execution timing across incremental refreshes', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [
        {
          ...toolPart('tool-1'),
          state: {
            status: 'completed',
            input: { command: 'rtk npm run test' },
            output: '',
            title: 'Runs Vitest unit test suite',
            metadata: {},
            time: { start: 1_000, end: 12_380 },
          },
        },
      ],
    });
    flushSolid();

    setMessagesIncremental([
      {
        info: assistantMessage(),
        parts: [
          {
            ...toolPart('tool-1'),
            state: {
              status: 'completed',
              input: { command: 'rtk npm run test' },
              output: '',
              title: 'Runs Vitest unit test suite',
              metadata: {},
              time: { start: 10_000, end: 10_005 },
            },
          },
        ],
      },
    ]);
    flushSolid();

    const updatedPart = state.messages[0]?.parts[0];
    if (!updatedPart || updatedPart.type !== 'tool') throw new Error('Expected a tool part');

    expect(updatedPart.state).toMatchObject({
      time: { start: 1_000, end: 12_380 },
    });
  });
});

describe('permission deduping', () => {
  beforeEach(() => {
    setState(storePath('permissions', []));
    flushSolid();
  });

  it('groups identical permissions into one visible prompt', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'external_directory',
        pattern: '/tmp/*',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'external_directory /tmp/*',
        metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
        time: { created: 2 },
      },
      {
        id: 'perm-2',
        type: 'external_directory',
        pattern: '/tmp/*',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'external_directory /tmp/*',
        metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
        time: { created: 1 },
      },
    ];

    expect(groupPermissions(permissions)).toEqual([
      expect.objectContaining({
        id: 'perm-2',
        duplicateIDs: expect.arrayContaining(['perm-1', 'perm-2']),
        groupMembers: expect.arrayContaining([
          expect.objectContaining({ id: 'perm-1', messageID: 'message-1', callID: 'call-1' }),
          expect.objectContaining({ id: 'perm-2', messageID: 'message-1', callID: 'call-1' }),
        ]),
      }),
    ]);
  });

  it('groups identical permissions across different tool calls while both are pending', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'external_directory',
        pattern: '/tmp/*',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'external_directory /tmp/*',
        metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
        time: { created: 1 },
      },
      {
        id: 'perm-2',
        type: 'external_directory',
        pattern: '/tmp/*',
        sessionID: 'session-1',
        messageID: 'message-2',
        callID: 'call-2',
        title: 'external_directory /tmp/*',
        metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
        time: { created: 1.4 },
      },
    ];

    expect(groupPermissions(permissions)).toEqual([
      expect.objectContaining({
        id: 'perm-1',
        duplicateIDs: expect.arrayContaining(['perm-1', 'perm-2']),
        groupMembers: expect.arrayContaining([
          expect.objectContaining({ id: 'perm-1', messageID: 'message-1', callID: 'call-1' }),
          expect.objectContaining({ id: 'perm-2', messageID: 'message-2', callID: 'call-2' }),
        ]),
      }),
    ]);
  });

  it('groups identical permissions that arrive later while the earlier one is still pending', () => {
    const permissions: Permission[] = [
      {
        id: 'perm-1',
        type: 'external_directory',
        pattern: '/tmp/*',
        sessionID: 'session-1',
        messageID: 'message-1',
        callID: 'call-1',
        title: 'external_directory /tmp/*',
        metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
        time: { created: 1 },
      },
      {
        id: 'perm-2',
        type: 'external_directory',
        pattern: '/tmp/*',
        sessionID: 'session-1',
        messageID: 'message-2',
        callID: 'call-2',
        title: 'external_directory /tmp/*',
        metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
        time: { created: 3 },
      },
    ];

    expect(groupPermissions(permissions)).toEqual([
      expect.objectContaining({
        id: 'perm-1',
        duplicateIDs: expect.arrayContaining(['perm-1', 'perm-2']),
        groupMembers: expect.arrayContaining([
          expect.objectContaining({ id: 'perm-1', messageID: 'message-1', callID: 'call-1' }),
          expect.objectContaining({ id: 'perm-2', messageID: 'message-2', callID: 'call-2' }),
        ]),
      }),
    ]);
  });

  it('keeps distinct permission payloads separate', () => {
    const first: Permission = {
      id: 'perm-1',
      type: 'external_directory',
      pattern: '/tmp/*',
      sessionID: 'session-1',
      messageID: 'message-1',
      callID: 'call-1',
      title: 'external_directory /tmp/*',
      metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
      time: { created: 1 },
    };
    const second: Permission = {
      ...first,
      id: 'perm-2',
      metadata: { filepath: '/tmp/file-b', parentDir: '/tmp' },
    };

    expect(getPermissionSignature(first)).not.toBe(getPermissionSignature(second));
    expect(groupPermissions([first, second])).toHaveLength(2);
  });

  it('dedupes identical permissions added live', () => {
    addPermission({
      id: 'perm-1',
      type: 'external_directory',
      pattern: '/tmp/*',
      sessionID: 'session-1',
      messageID: 'message-1',
      callID: 'call-1',
      title: 'external_directory /tmp/*',
      metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
      time: { created: 2 },
    });
    flushSolid();
    addPermission({
      id: 'perm-2',
      type: 'external_directory',
      pattern: '/tmp/*',
      sessionID: 'session-1',
      messageID: 'message-1',
      callID: 'call-1',
      title: 'external_directory /tmp/*',
      metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
      time: { created: 1 },
    });
    flushSolid();

    expect(state.permissions).toEqual([
      expect.objectContaining({
        id: 'perm-2',
        duplicateIDs: expect.arrayContaining(['perm-1', 'perm-2']),
      }),
    ]);
  });

  it('keeps remaining duplicates visible when one permission id is removed', () => {
    setState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'external_directory',
          pattern: '/tmp/*',
          sessionID: 'session-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'external_directory /tmp/*',
          metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
          time: { created: 1 },
          duplicateIDs: ['perm-1', 'perm-2'],
          groupMembers: [
            { id: 'perm-1', sessionID: 'session-1', messageID: 'message-1', callID: 'call-1' },
            { id: 'perm-2', sessionID: 'session-1', messageID: 'message-2', callID: 'call-2' },
          ],
        },
      ])
    );
    flushSolid();

    removePermission('perm-1');
    flushSolid();

    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0]?.id).toBe('perm-2');
    expect(state.permissions[0]?.duplicateIDs).toBeUndefined();
    expect(state.permissions[0]?.messageID).toBe('message-2');
    expect(state.permissions[0]?.callID).toBe('call-2');
  });

  it('removes grouped duplicates together when requested', () => {
    setState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'external_directory',
          pattern: '/tmp/*',
          sessionID: 'session-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'external_directory /tmp/*',
          metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
          time: { created: 1 },
          duplicateIDs: ['perm-1', 'perm-2'],
          groupMembers: [
            { id: 'perm-1', sessionID: 'session-1', messageID: 'message-1', callID: 'call-1' },
            { id: 'perm-2', sessionID: 'session-1', messageID: 'message-2', callID: 'call-2' },
          ],
        },
      ])
    );
    flushSolid();

    removePermission('perm-1', { removeGroup: true });
    flushSolid();

    expect(state.permissions).toHaveLength(0);
  });
});

describe('failed session tracking', () => {
  beforeEach(() => {
    clearMessages();
    flushSolid();
    setSessionFailed('session-1', false);
    flushSolid();
    setSessionFailed('session-2', false);
    flushSolid();
    setState(
      storePath('sessions', [
        sessionInfo('session-1', 'Session 1', 10),
        sessionInfo('session-2', 'Session 2', 20),
      ])
    );
    flushSolid();
    setState(storePath('activeSessionId', null));
    flushSolid();
    setState(storePath('lastSeenSessions', { 'session-1': 0, 'session-2': 0 }));
    flushSolid();
    setState((draft) => {
      const current = draft['interruptedSessionResponses'];
      const incoming = {} satisfies typeof current;
      if (incoming === null || incoming === undefined || current === null || current === undefined)
        draft['interruptedSessionResponses'] = incoming;
      else reconcile(incoming)(current);
    });
    flushSolid();
  });

  it('derives failed sessions from latest assistant message errors', () => {
    syncFailedSessionsFromMessages([
      {
        info: {
          ...assistantMessage('message-1', 'session-1'),
          error: { name: 'server_error', data: { message: 'Request failed' } },
        },
        parts: [],
      },
      {
        info: assistantMessage('message-2', 'session-2'),
        parts: [],
      },
    ]);
    flushSolid();

    expect(state.failedSessionIds).toEqual(['session-1']);
  });

  it('does not mark a session failed when the latest message is not the error', () => {
    syncFailedSessionsFromMessages([
      {
        info: {
          ...assistantMessage('message-1', 'session-1'),
          error: { name: 'server_error', data: { message: 'Request failed' } },
        },
        parts: [],
      },
      {
        info: assistantMessage('message-2', 'session-1'),
        parts: [],
      },
    ]);
    flushSolid();

    expect(state.failedSessionIds).toEqual([]);
  });

  it('keeps a session failed when the errored latest message has already been seen', () => {
    setState(storePath('lastSeenSessions', { 'session-1': 100 }));
    flushSolid();

    syncFailedSessionsFromMessages([
      {
        info: {
          ...assistantMessage('message-1', 'session-1'),
          error: { name: 'server_error', data: { message: 'Request failed' } },
        },
        parts: [],
      },
    ]);
    flushSolid();

    expect(state.failedSessionIds).toEqual(['session-1']);
  });

  it('does not mark a session failed for aborted assistant messages', () => {
    syncFailedSessionsFromMessages([
      {
        info: {
          ...assistantMessage('message-1', 'session-1'),
          time: { created: 100, completed: 500 },
          error: { name: 'aborted', data: { message: 'Aborted' } },
        },
        parts: [],
      },
    ]);
    flushSolid();

    expect(state.failedSessionIds).toEqual([]);
    expect(state.interruptedSessionResponses['session-1']).toBe(500);
  });

  it('preserves failed flags for sessions outside the synced message set', () => {
    setSessionFailed('session-2', true);
    flushSolid();

    syncFailedSessionsFromMessages([
      {
        info: assistantMessage('message-1', 'session-1'),
        parts: [],
      },
    ]);
    flushSolid();

    expect(state.failedSessionIds).toEqual(['session-2']);
  });

  it('allows clearing an individual failed session flag', () => {
    setSessionFailed('session-1', true);
    flushSolid();
    setSessionFailed('session-2', true);
    flushSolid();
    setSessionFailed('session-1', false);
    flushSolid();

    expect(state.failedSessionIds).toEqual(['session-2']);
  });
});

describe('clipboard image placeholders', () => {
  beforeEach(() => {
    setState(storePath('clipboardImages', []));
    flushSolid();
    setInputText('');
    flushSolid();
  });

  it('replaces every placeholder match when removing a clipboard image', () => {
    addClipboardImage({
      id: 'img-1',
      url: 'blob:one',
      mime: 'image/png',
      filename: 'image.png',
      size: 1,
    });
    flushSolid();
    setInputText('Before [image.png] middle [image.png] after');
    flushSolid();

    removeClipboardImage('img-1');
    flushSolid();

    expect(inputText()).toBe('Before _____ middle _____ after');
  });

  it('synchronizes pasted image changes to host persistence', () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __sendToExtension?: typeof send }).__sendToExtension = send;
    flushSolid();

    addClipboardImage({
      id: 'img-persisted',
      url: 'data:image/png;base64,AA==',
      mime: 'image/png',
      filename: 'image.png',
      size: 1,
    });
    flushSolid();
    removeClipboardImage('img-persisted');
    flushSolid();

    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'composer/images-update',
      payload: {
        images: [
          {
            id: 'img-persisted',
            url: 'data:image/png;base64,AA==',
            mime: 'image/png',
            filename: 'image.png',
            size: 1,
            attachmentSequence: expect.any(Number),
          },
        ],
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'composer/images-update',
      payload: { images: [] },
    });

    // SAFETY: The fixture provides the unknown fields read by this statement.
    delete (window as { __sendToExtension?: unknown }).__sendToExtension;
    flushSolid();
  });

  it('does not resend base64 images when the host supplies a temporary file path', () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __sendToExtension?: typeof send }).__sendToExtension = send;
    flushSolid();
    addClipboardImage({
      id: 'img-stored',
      url: 'data:image/png;base64,AA==',
      mime: 'image/png',
      filename: 'image.png',
      size: 1,
    });
    flushSolid();
    send.mockClear();
    flushSolid();

    expect(
      setClipboardImageContextFile('img-stored', {
        path: '/tmp/image.png',
        relativePath: 'image.png',
        type: 'file',
      })
    ).toBe(true);

    flushSolid();
    expect(state.clipboardImages[0]?.contextFile?.path).toBe('/tmp/image.png');
    expect(send).not.toHaveBeenCalled();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    delete (window as { __sendToExtension?: unknown }).__sendToExtension;
    flushSolid();
  });

  it('applies host image snapshots without posting them back', () => {
    const send = vi.fn<(message: WebviewMessage) => void>();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __sendToExtension?: typeof send }).__sendToExtension = send;
    flushSolid();

    syncClipboardImages([
      {
        id: 'img-restored',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'image.png',
        size: 1,
      },
    ]);
    flushSolid();

    expect(state.clipboardImages.map((image) => image.id)).toEqual(['img-restored']);
    expect(send).not.toHaveBeenCalled();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    delete (window as { __sendToExtension?: unknown }).__sendToExtension;
    flushSolid();
  });

  it('replaces placeholders for all clipboard images when clearing them', () => {
    addClipboardImage({
      id: 'img-1',
      url: 'blob:one',
      mime: 'image/png',
      filename: 'image-1.png',
      size: 1,
    });
    flushSolid();
    addClipboardImage({
      id: 'img-2',
      url: 'blob:two',
      mime: 'image/png',
      filename: 'image-2.png',
      size: 1,
    });
    flushSolid();
    setInputText('[image-1.png] [image-2.png] [image-1.png]');
    flushSolid();

    clearClipboardImages();
    flushSolid();

    expect(inputText()).toBe('_____ _____ _____');
    expect(state.clipboardImages).toEqual([]);
  });

  it('ignores an exact duplicate clipboard image without evicting existing images', () => {
    addClipboardImage({
      id: 'img-1',
      url: 'data:image/png;base64,one',
      mime: 'image/png',
      filename: 'image-1.png',
      size: 1,
    });
    flushSolid();
    addClipboardImage({
      id: 'img-2',
      url: 'data:image/png;base64,two',
      mime: 'image/png',
      filename: 'image-2.png',
      size: 1,
    });
    flushSolid();
    addClipboardImage({
      id: 'img-3',
      url: 'data:image/png;base64,three',
      mime: 'image/png',
      filename: 'image-3.png',
      size: 1,
    });
    flushSolid();
    addClipboardImage({
      id: 'img-4',
      url: 'data:image/png;base64,four',
      mime: 'image/png',
      filename: 'image-4.png',
      size: 1,
    });
    flushSolid();
    addClipboardImage({
      id: 'img-5',
      url: 'data:image/png;base64,five',
      mime: 'image/png',
      filename: 'image-5.png',
      size: 1,
    });
    flushSolid();

    const didAddDuplicate = addClipboardImage({
      id: 'img-duplicate',
      url: 'data:image/png;base64,three',
      mime: 'image/png',
      filename: 'image-duplicate.png',
      size: 1,
    });

    expect(didAddDuplicate).toBe(false);
    expect(state.clipboardImages.map((image) => image.id)).toEqual([
      'img-1',
      'img-2',
      'img-3',
      'img-4',
      'img-5',
    ]);
  });
});

describe('message lookup helpers', () => {
  beforeEach(() => {
    clearMessages();
    flushSolid();
  });

  it('returns messages by id using the shared message index', () => {
    upsertMessage({ info: assistantMessage('message-1'), parts: [] });
    flushSolid();

    expect(getMessageById('message-1')?.info.id).toBe('message-1');
    expect(getMessageById('missing')).toBeNull();
  });
});

describe('getSessionTreeIds', () => {
  it('returns the root session and all descendants', () => {
    setState(
      storePath('sessions', [
        sessionInfo('session-1', 'Session 1', 10),
        sessionInfo('child-1', 'Child 1', 20, 'session-1'),
        sessionInfo('child-2', 'Child 2', 30, 'child-1'),
      ])
    );
    flushSolid();

    expect(getSessionTreeIds('session-1')).toEqual(['session-1', 'child-1', 'child-2']);
    expect(getSessionTreeIds('child-1')).toEqual(['child-1', 'child-2']);
    expect(getSessionTreeIds(null)).toEqual([]);
  });

  it('does not include sibling branches when reading a descendant subtree', () => {
    setState(
      storePath('sessions', [
        sessionInfo('session-1', 'Session 1', 10),
        sessionInfo('child-1', 'Child 1', 20, 'session-1'),
        sessionInfo('grandchild-1', 'Grandchild 1', 30, 'child-1'),
        sessionInfo('child-2', 'Child 2', 40, 'session-1'),
      ])
    );
    flushSolid();

    expect(getSessionTreeIds('child-1')).toEqual(['child-1', 'grandchild-1']);
    expect(getSessionTreeIds('child-2')).toEqual(['child-2']);
  });

  it('reuses active usage-limit lookups across a session tree', () => {
    setState(
      storePath('sessions', [
        sessionInfo('session-1', 'Session 1', 10),
        sessionInfo('child-1', 'Child 1', 20, 'session-1'),
      ])
    );
    flushSolid();
    setState(
      storePath('sessionUsageLimits', {
        'child-1': {
          source: 'status',
          statusCode: 429,
          message: '429 usage limit reached',
          unit: 'messages',
          retryAt: 4_000,
          attempt: 2,
          sessionID: 'child-1',
        },
      })
    );
    flushSolid();

    expect(getActiveUsageLimitNotice('session-1')).toMatchObject({ sessionID: 'child-1' });
    expect(getActiveUsageLimitNotice('child-1')).toMatchObject({ sessionID: 'child-1' });
    expect(hasActiveUsageLimit('session-1')).toBe(true);
    expect(hasActiveUsageLimit('child-1')).toBe(true);
  });

  it('clears an active usage-limit lookup after removing the notice', () => {
    setState(
      storePath('sessions', [
        sessionInfo('session-1', 'Session 1', 10),
        sessionInfo('child-1', 'Child 1', 20, 'session-1'),
      ])
    );
    flushSolid();
    setSessionUsageLimit('child-1', {
      source: 'status',
      statusCode: 429,
      message: '429 usage limit reached',
      unit: 'messages',
      retryAt: 4_000,
      attempt: 2,
      sessionID: 'child-1',
    });
    flushSolid();

    expect(getSessionTreeRootId('child-1')).toBe('session-1');
    expect(hasActiveUsageLimit('session-1')).toBe(true);
    expect(hasActiveUsageLimit('child-1')).toBe(true);

    setSessionUsageLimit('child-1', null);
    flushSolid();

    expect(getActiveUsageLimitNotice('session-1')).toBeNull();
    expect(getActiveUsageLimitNotice('child-1')).toBeNull();
    expect(hasActiveUsageLimit('session-1')).toBe(false);
    expect(hasActiveUsageLimit('child-1')).toBe(false);
  });

  it('applies every usage limit change made in the same tick', () => {
    const notice = (sessionID: string) => ({
      source: 'status' as const,
      statusCode: 429 as const,
      message: '429 usage limit reached',
      unit: 'messages' as const,
      retryAt: 4_000,
      attempt: 2,
      sessionID,
    });

    setSessionUsageLimit('session-1', notice('session-1'));
    setSessionUsageLimit('child-1', notice('child-1'));
    flushSolid();
    expect(Object.keys(state.sessionUsageLimits).toSorted()).toEqual(['child-1', 'session-1']);

    setSessionUsageLimit('session-1', null);
    setSessionUsageLimit('child-1', null);
    flushSolid();
    expect(Object.keys(state.sessionUsageLimits)).toEqual([]);

    setSessionUsageLimit('session-1', notice('session-1'));
    setSessionUsageLimit('session-1', null);
    flushSolid();
    expect(Object.keys(state.sessionUsageLimits)).toEqual([]);
  });

  it('treats child-session prompts as active on the root session', () => {
    setState(
      storePath('sessions', [
        sessionInfo('session-1', 'Session 1', 10),
        sessionInfo('child-1', 'Child 1', 20, 'session-1'),
      ])
    );
    flushSolid();
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'bash',
          sessionID: 'child-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'Allow bash',
          metadata: {},
          time: { created: 1 },
        },
      ])
    );
    flushSolid();
    setState(
      storePath('questions', [
        {
          id: 'question-1',
          sessionID: 'child-1',
          questions: [{ question: 'Choose one', header: 'Question', options: [] }],
        },
      ])
    );
    flushSolid();

    expect(hasActivePermission()).toBe(true);
    expect(hasActiveQuestion()).toBe(true);
  });

  it('treats root-session prompts as active on a child session', () => {
    setState(
      storePath('sessions', [
        sessionInfo('session-1', 'Session 1', 10),
        sessionInfo('child-1', 'Child 1', 20, 'session-1'),
      ])
    );
    flushSolid();
    setState(storePath('activeSessionId', 'child-1'));
    flushSolid();
    setState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'bash',
          sessionID: 'session-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'Allow bash',
          metadata: {},
          time: { created: 1 },
        },
      ])
    );
    flushSolid();
    setState(
      storePath('questions', [
        {
          id: 'question-1',
          sessionID: 'session-1',
          questions: [{ question: 'Choose one', header: 'Question', options: [] }],
        },
      ])
    );
    flushSolid();

    expect(hasActivePermission()).toBe(true);
    expect(hasActiveQuestion()).toBe(true);
  });
});
