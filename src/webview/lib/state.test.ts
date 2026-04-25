import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Part } from '../types';
import {
  applyMessagePartDelta,
  addClipboardImage,
  clearMessages,
  clearClipboardImages,
  clearStreamingState,
  getActiveUsageLimitNotice,
  getMessageById,
  getSessionTreeIds,
  hasActivePermission,
  hasActiveQuestion,
  hasActiveUsageLimit,
  inputText,
  removeClipboardImage,
  setSessionFailed,
  setInputText,
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
      text: 'Planning more',
    });
    expect(state.messages[0]?.parts[1]).toMatchObject({
      id: 'text-1',
      type: 'text',
      text: 'Answer',
    });
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
      text: 'Thinking carefully now',
    });
    expect(state.streamingPartId).toBe('reason-1');
    expect(state.streamingText).toBe('Thinking carefully now');
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
});
