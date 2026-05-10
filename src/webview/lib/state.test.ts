import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Part, Permission } from '../types';
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
  removePermission,
  removeClipboardImage,
  setSessionFailed,
  setInputText,
  setSessionUsageLimit,
  setState,
  state,
  syncFailedSessionsFromMessages,
  upsertMessage,
} from './state';

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

function nextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 16);
  });
}

describe('state streaming deltas', () => {
  beforeEach(() => {
    clearMessages();
    clearStreamingState();
  });

  it('updates existing reasoning parts as deltas arrive', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Planning'), textPart('text-1', '')],
    });

    applyMessagePartDelta('message-1', 'reason-1', ' more', 'session-1');
    applyMessagePartDelta('message-1', 'text-1', 'Answer', 'session-1');
    await nextFrame();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Planning',
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

    applyMessagePartDelta('message-1', 'text-1', ' extended', 'session-1');
    await nextFrame();

    expect(state.streamingPartId).toBe('text-1');
    expect(state.streamingText).toBe('Existing answer extended');
    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Existing answer',
    });
  });

  it('commits the previous streaming part text when another part becomes active later', async () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Thinking'), textPart('text-1', 'Done')],
    });

    applyMessagePartDelta('message-1', 'reason-1', ' carefully', 'session-1');
    await nextFrame();

    expect(state.streamingPartId).toBe('reason-1');
    expect(state.streamingText).toBe('Thinking carefully');
    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Thinking',
    });

    applyMessagePartDelta('message-1', 'text-1', ' already', 'session-1');
    await nextFrame();

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

    applyMessagePartDelta('message-1', 'reason-1', ' carefully', 'session-1');
    applyMessagePartDelta('message-1', 'text-1', ' already', 'session-1');
    applyMessagePartDelta('message-1', 'reason-1', ' now', 'session-1');
    await nextFrame();

    expect(state.messages[0]?.parts[0]).toMatchObject({
      id: 'reason-1',
      type: 'reasoning',
      text: 'Thinking',
    });
    expect(state.streamingPartId).toBe('reason-1');
    expect(state.streamingText).toBe('Thinking carefully now');
  });

  it('commits and clears streaming text when a message finishes', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [textPart('text-1', '')],
    });

    applyMessagePartDelta('message-1', 'text-1', 'Received.', 'session-1');
    finishMessageStreaming('message-1');

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

    applyMessagePartDelta('message-1', 'text-1', 'Received.', 'session-1');
    finishMessageStreaming('message-2');
    await nextFrame();

    expect(state.streamingPartId).toBe('text-1');
    expect(state.streamingText).toBe('Received.');
  });
});

describe('permission deduping', () => {
  beforeEach(() => {
    setState('permissions', []);
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

    expect(state.permissions).toEqual([
      expect.objectContaining({
        id: 'perm-2',
        duplicateIDs: expect.arrayContaining(['perm-1', 'perm-2']),
      }),
    ]);
  });

  it('keeps remaining duplicates visible when one permission id is removed', () => {
    setState('permissions', [
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
    ]);

    removePermission('perm-1');

    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0]?.id).toBe('perm-2');
    expect(state.permissions[0]?.duplicateIDs).toBeUndefined();
    expect(state.permissions[0]?.messageID).toBe('message-2');
    expect(state.permissions[0]?.callID).toBe('call-2');
  });
});

describe('failed session tracking', () => {
  beforeEach(() => {
    clearMessages();
    setSessionFailed('session-1', false);
    setSessionFailed('session-2', false);
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'session-2',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 2',
        version: '1',
        time: { created: 0, updated: 20 },
      },
    ]);
    setState('activeSessionId', null);
    setState('lastSeenSessions', { 'session-1': 0, 'session-2': 0 });
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

    expect(state.failedSessionIds).toEqual([]);
  });

  it('keeps a session failed when the errored latest message has already been seen', () => {
    setState('lastSeenSessions', { 'session-1': 100 });

    syncFailedSessionsFromMessages([
      {
        info: {
          ...assistantMessage('message-1', 'session-1'),
          error: { name: 'server_error', data: { message: 'Request failed' } },
        },
        parts: [],
      },
    ]);

    expect(state.failedSessionIds).toEqual(['session-1']);
  });

  it('does not mark a session failed for aborted assistant messages', () => {
    syncFailedSessionsFromMessages([
      {
        info: {
          ...assistantMessage('message-1', 'session-1'),
          error: { name: 'aborted', data: { message: 'Aborted' } },
        },
        parts: [],
      },
    ]);

    expect(state.failedSessionIds).toEqual([]);
  });

  it('preserves failed flags for sessions outside the synced message set', () => {
    setSessionFailed('session-2', true);

    syncFailedSessionsFromMessages([
      {
        info: assistantMessage('message-1', 'session-1'),
        parts: [],
      },
    ]);

    expect(state.failedSessionIds).toEqual(['session-2']);
  });

  it('allows clearing an individual failed session flag', () => {
    setSessionFailed('session-1', true);
    setSessionFailed('session-2', true);
    setSessionFailed('session-1', false);

    expect(state.failedSessionIds).toEqual(['session-2']);
  });
});

describe('clipboard image placeholders', () => {
  beforeEach(() => {
    setState('clipboardImages', []);
    setInputText('');
  });

  it('replaces every placeholder match when removing a clipboard image', () => {
    addClipboardImage({
      id: 'img-1',
      url: 'blob:one',
      mime: 'image/png',
      filename: 'image.png',
      size: 1,
    });
    setInputText('Before [image.png] middle [image.png] after');

    removeClipboardImage('img-1');

    expect(inputText()).toBe('Before _____ middle _____ after');
  });

  it('replaces placeholders for all clipboard images when clearing them', () => {
    addClipboardImage({
      id: 'img-1',
      url: 'blob:one',
      mime: 'image/png',
      filename: 'image-1.png',
      size: 1,
    });
    addClipboardImage({
      id: 'img-2',
      url: 'blob:two',
      mime: 'image/png',
      filename: 'image-2.png',
      size: 1,
    });
    setInputText('[image-1.png] [image-2.png] [image-1.png]');

    clearClipboardImages();

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
    addClipboardImage({
      id: 'img-2',
      url: 'data:image/png;base64,two',
      mime: 'image/png',
      filename: 'image-2.png',
      size: 1,
    });
    addClipboardImage({
      id: 'img-3',
      url: 'data:image/png;base64,three',
      mime: 'image/png',
      filename: 'image-3.png',
      size: 1,
    });
    addClipboardImage({
      id: 'img-4',
      url: 'data:image/png;base64,four',
      mime: 'image/png',
      filename: 'image-4.png',
      size: 1,
    });
    addClipboardImage({
      id: 'img-5',
      url: 'data:image/png;base64,five',
      mime: 'image/png',
      filename: 'image-5.png',
      size: 1,
    });

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
  });

  it('returns messages by id using the shared message index', () => {
    upsertMessage({ info: assistantMessage('message-1'), parts: [] });

    expect(getMessageById('message-1')?.info.id).toBe('message-1');
    expect(getMessageById('missing')).toBeNull();
  });
});

describe('getSessionTreeIds', () => {
  it('returns the root session and all descendants', () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
      {
        id: 'child-2',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 2',
        version: '1',
        parentID: 'child-1',
        time: { created: 0, updated: 30 },
      },
    ]);

    expect(getSessionTreeIds('session-1')).toEqual(['session-1', 'child-1', 'child-2']);
    expect(getSessionTreeIds('child-1')).toEqual(['child-1', 'child-2']);
    expect(getSessionTreeIds(null)).toEqual([]);
  });

  it('does not include sibling branches when reading a descendant subtree', () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
      {
        id: 'grandchild-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Grandchild 1',
        version: '1',
        parentID: 'child-1',
        time: { created: 0, updated: 30 },
      },
      {
        id: 'child-2',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 2',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 40 },
      },
    ]);

    expect(getSessionTreeIds('child-1')).toEqual(['child-1', 'grandchild-1']);
    expect(getSessionTreeIds('child-2')).toEqual(['child-2']);
  });

  it('reuses active usage-limit lookups across a session tree', () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);
    setState('sessionUsageLimits', {
      'child-1': {
        source: 'status',
        statusCode: 429,
        message: '429 usage limit reached',
        unit: 'messages',
        retryAt: 4_000,
        attempt: 2,
        sessionID: 'child-1',
      },
    });

    expect(getActiveUsageLimitNotice('session-1')).toMatchObject({ sessionID: 'child-1' });
    expect(getActiveUsageLimitNotice('child-1')).toMatchObject({ sessionID: 'child-1' });
    expect(hasActiveUsageLimit('session-1')).toBe(true);
    expect(hasActiveUsageLimit('child-1')).toBe(true);
  });

  it('clears an active usage-limit lookup after removing the notice', () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);
    setSessionUsageLimit('child-1', {
      source: 'status',
      statusCode: 429,
      message: '429 usage limit reached',
      unit: 'messages',
      retryAt: 4_000,
      attempt: 2,
      sessionID: 'child-1',
    });

    expect(getSessionTreeRootId('child-1')).toBe('session-1');
    expect(hasActiveUsageLimit('session-1')).toBe(true);
    expect(hasActiveUsageLimit('child-1')).toBe(true);

    setSessionUsageLimit('child-1', null);

    expect(getActiveUsageLimitNotice('session-1')).toBeNull();
    expect(getActiveUsageLimitNotice('child-1')).toBeNull();
    expect(hasActiveUsageLimit('session-1')).toBe(false);
    expect(hasActiveUsageLimit('child-1')).toBe(false);
  });

  it('treats child-session prompts as active on the root session', () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);
    setState('activeSessionId', 'session-1');
    setState('permissions', [
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
    ]);
    setState('questions', [
      {
        id: 'question-1',
        sessionID: 'child-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
      },
    ]);

    expect(hasActivePermission()).toBe(true);
    expect(hasActiveQuestion()).toBe(true);
  });

  it('treats root-session prompts as active on a child session', () => {
    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);
    setState('activeSessionId', 'child-1');
    setState('permissions', [
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
    ]);
    setState('questions', [
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ question: 'Choose one', header: 'Question', options: [] }],
      },
    ]);

    expect(hasActivePermission()).toBe(true);
    expect(hasActiveQuestion()).toBe(true);
  });
});
