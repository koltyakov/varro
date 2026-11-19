import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDefaultAppState, setState, state } from '../lib/state';
import type { MessageEntry } from '../types';
import { createTodoSyncOperations } from './todo-sync';

const transcript: MessageEntry[] = [
  {
    info: {
      id: 'user-1',
      sessionID: 'session-1',
      role: 'user',
      time: { created: 0 },
      agent: 'build',
      model: { providerID: 'provider-1', modelID: 'model-1' },
    },
    parts: [],
  },
  {
    info: {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'user-1',
      modelID: 'model-1',
      providerID: 'provider-1',
      mode: 'default',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'assistant-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'todowrite',
        state: {
          status: 'completed',
          input: {
            todos: [{ id: 'todo-1', content: 'ship', status: 'pending', priority: 'high' }],
          },
          output: '',
          title: 'TodoWrite',
          metadata: {},
          time: { start: 0, end: 1 },
        },
      },
    ],
  },
];

describe('todo sync in the same tick as a transcript write', () => {
  beforeEach(() => {
    resetDefaultAppState();
    flushSolid();
  });

  it('reads a todo part written just before the sync', async () => {
    const operations = createTodoSyncOperations();
    setState(storePath('activeSessionId', 'session-1'));
    setState(storePath('messages', transcript));
    operations.syncTodosFromMessages();
    await Promise.resolve();
    flushSolid();

    expect(state.todos).toEqual([
      { id: 'todo-1', content: 'ship', status: 'pending', priority: 'high' },
    ]);
  });
});
