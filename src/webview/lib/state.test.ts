import { beforeEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, Part } from '../types';
import {
  applyMessagePartDelta,
  clearMessages,
  clearStreamingState,
  getSessionTreeIds,
  setSessionFailed,
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

describe('state streaming deltas', () => {
  beforeEach(() => {
    clearMessages();
    clearStreamingState();
  });

  it('updates existing reasoning parts as deltas arrive', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Planning'), textPart('text-1', '')],
    });

    applyMessagePartDelta('message-1', 'reason-1', ' more', 'session-1');
    applyMessagePartDelta('message-1', 'text-1', 'Answer', 'session-1');

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

  it('resumes streaming from the part text after another part becomes active', () => {
    upsertMessage({
      info: assistantMessage(),
      parts: [reasoningPart('Thinking'), textPart('text-1', 'Done')],
    });

    applyMessagePartDelta('message-1', 'reason-1', ' carefully', 'session-1');
    applyMessagePartDelta('message-1', 'text-1', ' already', 'session-1');
    applyMessagePartDelta('message-1', 'reason-1', ' now', 'session-1');

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

  it('derives failed sessions from unread latest assistant message errors', () => {
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

  it('does not mark a session failed when the errored latest message has already been seen', () => {
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

    expect(state.failedSessionIds).toEqual([]);
  });

  it('allows clearing an individual failed session flag', () => {
    setSessionFailed('session-1', true);
    setSessionFailed('session-2', true);
    setSessionFailed('session-1', false);

    expect(state.failedSessionIds).toEqual(['session-2']);
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
});
