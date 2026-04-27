import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Part, Todo, UserMessage } from '../types';
import {
  deriveTodosFromMessages,
  extractTodos,
  handoffTodosToMessages,
  syncTodosFromMessages,
} from './todo-sync';

function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 0 },
    agent: 'build',
    model: { providerID: 'provider-1', modelID: 'model-1' },
  };
}

function assistantMessage(id: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1 },
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
    ...overrides,
  };
}

function todoToolPart(todos: Todo[]): Part {
  return {
    id: 'part-1',
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'todowrite',
    state: {
      status: 'completed',
      input: { todos },
      time: { start: 0, end: 1 },
    },
  } as Part;
}

describe('todo-sync', () => {
  it('extracts todos from todowrite and parallel payloads', () => {
    expect(extractTodos([{ content: 'a', status: 'pending', priority: 'high' }])).toEqual([
      { content: 'a', status: 'pending', priority: 'high', id: 'a' },
    ]);

    expect(
      extractTodos({
        todos: [{ content: 'b', status: 'completed', priority: 'low', id: 2 }],
      })
    ).toEqual([{ content: 'b', status: 'completed', priority: 'low', id: '2' }]);
  });

  it('derives todos from the latest assistant turn tool parts', () => {
    const todos = [{ id: 'todo-1', content: 'ship it', status: 'pending', priority: 'high' }];

    expect(
      deriveTodosFromMessages([
        { info: userMessage('user-1'), parts: [] },
        { info: assistantMessage('assistant-1'), parts: [todoToolPart(todos)] },
      ])
    ).toEqual(todos);
  });

  it('keeps event-owned todos until messages fully catch up', () => {
    const setTodos = vi.fn();
    const result = handoffTodosToMessages(
      {
        authority: 'event',
        todos: [{ id: 'todo-1', content: 'pending', status: 'pending', priority: 'medium' }],
      },
      setTodos,
      [{ info: assistantMessage('assistant-1'), parts: [] }]
    );

    expect(result).toBe(false);
    expect(setTodos).not.toHaveBeenCalled();
  });

  it('syncs todos from messages only when messages own the state', () => {
    const setTodos = vi.fn();
    const messages = [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1'),
        parts: [
          todoToolPart([{ id: 'todo-1', content: 'sync', status: 'pending', priority: 'medium' }]),
        ],
      },
    ];

    syncTodosFromMessages({ authority: 'messages', todos: [] }, setTodos, messages);
    expect(setTodos).toHaveBeenCalledWith([
      { id: 'todo-1', content: 'sync', status: 'pending', priority: 'medium' },
    ]);

    setTodos.mockClear();
    syncTodosFromMessages({ authority: 'event', todos: [] }, setTodos, messages);
    expect(setTodos).not.toHaveBeenCalled();
  });
});
