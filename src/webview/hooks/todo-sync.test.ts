import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';
import type { AssistantMessage, Part, Todo, UserMessage } from '../types';

const { setState, state } = vi.hoisted(() => ({
  setState: vi.fn(),
  state: {
    todos: [] as Todo[],
    messages: [] as Array<{ info: UserMessage | AssistantMessage; parts: Part[] }>,
    activeSessionId: 'session-1' as string | null,
    sessionStatus: {} as Record<string, { type: 'idle' | 'busy' | 'retry'; attempt?: number }>,
  },
}));

vi.mock('../lib/state', async () => {
  const actual = (await vi.importActual('../lib/state')) as MockedObject<typeof StateModule>;
  return {
    ...actual,
    setState,
    state,
  };
});

import {
  createTodoSyncOperations,
  deriveTodosFromMessages,
  extractTodos,
  handoffTodosToMessages,
  mergeTodoEventAdvance,
  syncTodosFromMessages,
} from './todo-sync';

beforeEach(() => {
  setState.mockClear();
  state.todos = [];
  state.messages = [];
  state.activeSessionId = 'session-1';
  state.sessionStatus = {};
});

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

  it('derives todos from update_plan entries inside parallel tool payloads', () => {
    const todos = [{ id: 'todo-1', content: 'ship it', status: 'pending', priority: 'high' }];

    expect(
      deriveTodosFromMessages([
        { info: userMessage('user-1'), parts: [] },
        {
          info: assistantMessage('assistant-1'),
          parts: [
            {
              id: 'part-1',
              sessionID: 'session-1',
              messageID: 'assistant-1',
              type: 'tool',
              callID: 'call-1',
              tool: 'multi_tool_use.parallel',
              state: {
                status: 'completed',
                input: {
                  tool_uses: [
                    {
                      recipient_name: 'functions.update_plan',
                      parameters: { todos },
                    },
                  ],
                },
                time: { start: 0, end: 1 },
              },
            } as Part,
          ],
        },
      ])
    ).toEqual(todos);
  });

  it('prefers completed tool output over stale todo input', () => {
    expect(
      deriveTodosFromMessages([
        { info: userMessage('user-1'), parts: [] },
        {
          info: assistantMessage('assistant-1'),
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
                  todos: [
                    { id: 'todo-1', content: 'ship it', status: 'in_progress', priority: 'high' },
                  ],
                },
                output: JSON.stringify({
                  todos: [
                    { id: 'todo-1', content: 'ship it', status: 'completed', priority: 'high' },
                  ],
                }),
                title: 'TodoWrite',
                metadata: {},
                time: { start: 0, end: 1 },
              },
            } as Part,
          ],
        },
      ])
    ).toEqual([{ id: 'todo-1', content: 'ship it', status: 'completed', priority: 'high' }]);
  });

  it('keeps event-owned todos until messages fully catch up', () => {
    const setTodos = vi.fn();
    state.sessionStatus = { 'session-1': { type: 'busy' } };
    const result = handoffTodosToMessages(
      [{ id: 'todo-1', content: 'pending', status: 'pending', priority: 'medium' }],
      setTodos,
      [{ info: assistantMessage('assistant-1'), parts: [] }]
    );

    expect(result).toBe(false);
    expect(setTodos).not.toHaveBeenCalled();
  });

  it('syncs todos from message tool parts', () => {
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

    syncTodosFromMessages(setTodos, messages);
    expect(setTodos).toHaveBeenCalledWith([
      { id: 'todo-1', content: 'sync', status: 'pending', priority: 'medium' },
    ]);
  });

  it('uses native todo events after the native endpoint is available', async () => {
    const messages = [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1'),
        parts: [
          todoToolPart([
            { id: 'todo-1', content: 'message', status: 'pending', priority: 'medium' },
          ]),
        ],
      },
    ];
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => []),
    });

    await operations.syncTodosForSession('session-1', messages);
    setState.mockClear();
    operations.syncTodosFromMessages(messages, {
      todos: [{ content: 'native', status: 'completed', priority: 'high' }],
    });

    expect(setState).toHaveBeenCalledWith('todos', [
      { id: 'native', content: 'native', status: 'completed', priority: 'high' },
    ]);
  });

  it('does not let native todo refreshes downgrade matching completed todos', async () => {
    state.todos = [{ id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' }];
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => [
        { id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' },
      ]),
    });

    await operations.syncTodosForSession('session-1', []);

    expect(setState).not.toHaveBeenCalled();
  });

  it('allows native todo update events to reset matching completed todos', async () => {
    state.todos = [{ id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' }];
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => []),
    });

    await operations.syncTodosForSession('session-1', []);
    setState.mockClear();

    operations.syncTodosFromMessages([], {
      todos: [{ id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' }],
    });

    expect(setState).toHaveBeenCalledWith('todos', [
      { id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' },
    ]);
  });

  it('uses message todos to advance stale native session todos', async () => {
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => [
        { id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' },
      ]),
    });

    await operations.syncTodosForSession('session-1', [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1'),
        parts: [
          todoToolPart([
            { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
          ]),
        ],
      },
    ]);

    expect(setState).toHaveBeenLastCalledWith('todos', [
      { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
    ]);
  });

  it('uses matching todo.updated payloads to advance stale message todo status', () => {
    const messageTodos = [
      { id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' },
    ];

    expect(
      mergeTodoEventAdvance(messageTodos, [
        { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
      ])
    ).toEqual([{ id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' }]);
  });

  it('does not regress or replace todos from mismatched todo.updated payloads', () => {
    const messageTodos = [
      { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
    ];

    expect(
      mergeTodoEventAdvance(messageTodos, [
        { id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' },
      ])
    ).toEqual(messageTodos);

    expect(
      mergeTodoEventAdvance(messageTodos, [
        { id: 'todo-1', content: 'stale', status: 'completed', priority: 'medium' },
      ])
    ).toEqual(messageTodos);
  });

  it('creates bound todo-sync operations from shared state dependencies', () => {
    const messages = [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1'),
        parts: [
          todoToolPart([{ id: 'todo-1', content: 'sync', status: 'pending', priority: 'medium' }]),
        ],
      },
    ];

    state.todos = [];
    state.messages = messages;

    const operations = createTodoSyncOperations();

    operations.syncTodosFromMessages();
    expect(setState).toHaveBeenCalledWith('todos', [
      { id: 'todo-1', content: 'sync', status: 'pending', priority: 'medium' },
    ]);

    setState.mockClear();
    state.todos = [{ id: 'todo-1', content: 'event', status: 'pending', priority: 'medium' }];
    state.messages = [{ info: assistantMessage('assistant-1'), parts: [] }];
    state.sessionStatus = { 'session-1': { type: 'busy' } };

    const handedOff = operations.handoffTodosToMessages();
    expect(handedOff).toBe(false);
    expect(setState).not.toHaveBeenCalled();

    operations.resetTodoSync();
    expect(setState).toHaveBeenCalledWith('todos', []);
  });

  it('loads native session todos and falls back to message parsing on older servers', async () => {
    const messages = [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1'),
        parts: [
          todoToolPart([
            { id: 'todo-1', content: 'fallback', status: 'pending', priority: 'medium' },
          ]),
        ],
      },
    ];
    const nativeOperations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => [
        { content: 'native', status: 'completed', priority: 'high' },
      ]),
    });

    await nativeOperations.syncTodosForSession('session-1', messages);

    expect(setState).toHaveBeenCalledWith('todos', [
      { id: 'native', content: 'native', status: 'completed', priority: 'high' },
    ]);

    setState.mockClear();
    const fallbackOperations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => {
        throw new Error('404 Not Found');
      }),
    });

    await fallbackOperations.syncTodosForSession('session-1', messages);

    expect(setState).toHaveBeenCalledWith('todos', [
      { id: 'todo-1', content: 'fallback', status: 'pending', priority: 'medium' },
    ]);
  });

  it('hands off stale todos once the session is idle even without completion markers', () => {
    const setTodos = vi.fn();
    state.sessionStatus = { 'session-1': { type: 'idle' } };

    const result = handoffTodosToMessages(
      [{ id: 'todo-1', content: 'pending', status: 'pending', priority: 'medium' }],
      setTodos,
      [{ info: assistantMessage('assistant-1'), parts: [] }]
    );

    expect(result).toBe(true);
    expect(setTodos).toHaveBeenCalledWith([]);
  });
});
