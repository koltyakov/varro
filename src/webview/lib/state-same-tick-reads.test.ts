import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { beforeEach, describe, expect, it } from 'vitest';
import { startNewChatDraft } from './new-chat-draft';
import {
  getPersistedLastOpenedView,
  setPersistentShowSessionPicker,
} from './state-view-persistence';
import {
  resetDefaultAppState,
  setMessagesIncremental,
  setSelectedAgent,
  setSelectedModel,
  setState,
  state,
} from './state';
import type { MessageEntry } from '../types';

const settledResponse = (sessionID: string): MessageEntry => ({
  info: {
    id: 'message-1',
    sessionID,
    role: 'assistant',
    parentID: 'user-1',
    modelID: 'gpt-5',
    providerID: 'openai',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 },
  },
  parts: [],
});

describe('state read in the same tick as a write', () => {
  beforeEach(() => {
    resetDefaultAppState();
    flushSolid();
  });

  it('remembers a session opened just before the session list closes', () => {
    setState(storePath('activeSessionId', 'session-2'));
    setPersistentShowSessionPicker(false);
    flushSolid();

    expect(getPersistedLastOpenedView()).toMatchObject({
      type: 'session',
      sessionId: 'session-2',
    });
  });

  it('treats a response loaded with its session as already seen', () => {
    setState(storePath('activeSessionId', 'session-1'));
    setMessagesIncremental([settledResponse('session-1')]);
    flushSolid();

    expect(state.completedSessionResponses['session-1']).toBeUndefined();
  });

  it('keeps a running session model out of a new chat', () => {
    const globalModel = { providerID: 'openai', modelID: 'gpt-5' };
    const turnModel = { providerID: 'openai', modelID: 'gpt-4o' };
    setSelectedModel({ ...globalModel });
    setState(storePath('activeSessionId', 'session-1'));
    setState(storePath('sessionStatus', { 'session-1': { type: 'busy' } }));
    flushSolid();
    setSelectedModel(
      { ...turnModel },
      { sessionId: 'session-1', protectDuringTurn: true, persistGlobal: false }
    );
    flushSolid();

    startNewChatDraft();
    flushSolid();

    expect(state.selectedModel).toMatchObject(globalModel);
  });

  it('applies the last agent chosen in one tick', () => {
    setSelectedAgent('build');
    flushSolid();

    setSelectedAgent('plan');
    setSelectedAgent('build');
    flushSolid();

    expect(state.selectedAgent).toBe('build');
  });
});
