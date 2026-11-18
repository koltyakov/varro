import { flush as flushSolid } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockedObject } from 'vitest';
import type * as StateModule from '../lib/state';
import type { AssistantMessage, NormalizedTodo, Part, UserMessage } from '../types';

// SAFETY: The fixture provides the complete domain shape read by this statement.
const { setState, state, todoChanges } = vi.hoisted(() => ({
  setState: vi.fn<(update: (draft: { todos: NormalizedTodo[] }) => void) => void>(),
  todoChanges: vi.fn<(todos: NormalizedTodo[]) => void>(),
  state: {
    todos: [] as NormalizedTodo[],
    messages: [] as Array<{ info: UserMessage | AssistantMessage; parts: Part[] }>,
    activeSessionId: 'session-1' as string | null,
    sessionStatus: {} as Record<string, { type: 'idle' | 'busy' | 'retry'; attempt?: number }>,
  },
}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise todo synchronization against the state module boundary. */
vi.mock('../lib/state', async () => {
  // SAFETY: The test installs the typed mock implementation before this statement.
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
  setState.mockReset();
  todoChanges.mockClear();
  setState.mockImplementation((update) => {
    const previous = state.todos;
    update(state);
    if (state.todos !== previous) todoChanges(state.todos);
  });
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

function todoToolPart(todos: NormalizedTodo[]): Part {
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
      output: '',
      title: 'TodoWrite',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
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

  it('derives todos from namespaced update_plan tool parts', () => {
    const todos = [{ id: 'todo-1', content: 'ship it', status: 'pending', priority: 'high' }];
    const part = todoToolPart(todos);
    if (part.type !== 'tool') throw new Error('Expected a tool part');
    part.tool = 'functions.update_plan';

    expect(
      deriveTodosFromMessages([
        { info: userMessage('user-1'), parts: [] },
        { info: assistantMessage('assistant-1'), parts: [part] },
      ])
    ).toEqual(todos);
  });

  it('derives todos from conventional update_plan step entries', () => {
    const part = todoToolPart([]);
    if (part.type !== 'tool') throw new Error('Expected a tool part');
    part.tool = 'functions.update_plan';
    part.state.input = {
      plan: [
        { step: 'inspect namespaced tools', status: 'completed' },
        { step: 'finish report', status: 'in_progress' },
      ],
    };

    expect(
      deriveTodosFromMessages([
        { info: userMessage('user-1'), parts: [] },
        { info: assistantMessage('assistant-1'), parts: [part] },
      ])
    ).toEqual([
      {
        id: 'inspect namespaced tools',
        content: 'inspect namespaced tools',
        status: 'completed',
        priority: 'medium',
      },
      {
        id: 'finish report',
        content: 'finish report',
        status: 'in_progress',
        priority: 'medium',
      },
    ]);
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
                output: '',
                title: 'Parallel tools',
                metadata: {},
                time: { start: 0, end: 1 },
              },
            },
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
            },
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
    flushSolid();
    expect(setTodos).toHaveBeenCalledWith([
      { id: 'todo-1', content: 'sync', status: 'pending', priority: 'medium' },
    ]);
  });

  it('hydrates message todos before the native session request completes', async () => {
    let resolveNativeTodos!: (todos: unknown[]) => void;
    const nativeTodos = new Promise<unknown[]>((resolve) => {
      resolveNativeTodos = resolve;
    });
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(() => nativeTodos),
    });
    const messages = [
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1'),
        parts: [
          todoToolPart([
            { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
          ]),
        ],
      },
    ];

    const sync = operations.syncTodosForSession('session-1', messages);
    flushSolid();

    expect(state.todos).toEqual([
      { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
    ]);

    resolveNativeTodos([]);
    flushSolid();
    await sync;
    flushSolid();
  });

  it('bounds optional native hydration and ignores a late snapshot', async () => {
    vi.useFakeTimers();
    let finish!: (todos: NormalizedTodo[]) => void;
    const loadSessionTodos = vi.fn(
      (_sessionId: string, _signal: AbortSignal) =>
        new Promise<NormalizedTodo[]>((resolve) => {
          finish = resolve;
        })
    );
    const operations = createTodoSyncOperations({ loadSessionTodos });
    try {
      const sync = operations.syncTodosForSession('session-1', []);
      flushSolid();
      await vi.advanceTimersByTimeAsync(1_000);
      flushSolid();
      await sync;
      flushSolid();
      expect(loadSessionTodos.mock.calls[0]?.[1].aborted).toBe(true);
      todoChanges.mockClear();
      finish([{ id: 'late', content: 'late', status: 'pending', priority: 'high' }]);
      await Promise.resolve();
      flushSolid();
      expect(todoChanges).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a same-session reselection apply an older native response', async () => {
    let finish!: (todos: NormalizedTodo[]) => void;
    const pending = new Promise<NormalizedTodo[]>((resolve) => {
      finish = resolve;
    });
    const loadSessionTodos = vi
      .fn<(_sessionId: string, _signal: AbortSignal) => Promise<NormalizedTodo[]>>()
      .mockReturnValueOnce(pending)
      .mockResolvedValue([{ id: 'new', content: 'new', status: 'completed', priority: 'high' }]);
    const operations = createTodoSyncOperations({ loadSessionTodos });
    const old = operations.syncTodosForSession('session-1', []);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    operations.resetTodoSync();
    flushSolid();
    await operations.syncTodosForSession('session-1', []);
    flushSolid();
    todoChanges.mockClear();
    finish([{ id: 'old', content: 'old', status: 'pending', priority: 'high' }]);
    await old;
    flushSolid();
    expect(todoChanges).not.toHaveBeenCalled();
  });

  it('keeps native event state when an older native read fails', async () => {
    let fail!: (error: Error) => void;
    const loadSessionTodos = vi
      .fn<(_sessionId: string, _signal: AbortSignal) => Promise<NormalizedTodo[]>>()
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          })
      );
    const operations = createTodoSyncOperations({ loadSessionTodos });
    await operations.syncTodosForSession('session-1', []);
    flushSolid();
    const old = operations.syncTodosForSession('session-1', []);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    operations.syncTodosFromMessages([], {
      todos: [{ content: 'event', status: 'completed', priority: 'high' }],
    });
    flushSolid();
    todoChanges.mockClear();
    fail(new Error('older failed read'));
    await old;
    flushSolid();
    expect(todoChanges).not.toHaveBeenCalled();
    operations.syncTodosFromMessages([], {
      todos: [{ content: 'later event', status: 'completed', priority: 'high' }],
    });
    flushSolid();
    expect(state.todos).toEqual([expect.objectContaining({ content: 'later event' })]);
  });

  it('does not replay old message-derived todos after a transcript refresh', async () => {
    let fail!: (error: Error) => void;
    const operations = createTodoSyncOperations({
      loadSessionTodos: () =>
        new Promise<never>((_, reject) => {
          fail = reject;
        }),
    });
    const messages = [
      {
        info: assistantMessage('assistant-1'),
        parts: [
          todoToolPart([
            { id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' },
          ]),
        ],
      },
    ];
    const read = operations.syncTodosForSession('session-1', messages);
    flushSolid();
    await Promise.resolve();
    flushSolid();
    operations.handoffTodosToMessages([
      {
        info: assistantMessage('assistant-1'),
        parts: [
          todoToolPart([
            { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
          ]),
        ],
      },
    ]);
    todoChanges.mockClear();
    fail(new Error('older failed read'));
    await read;
    flushSolid();
    expect(todoChanges).not.toHaveBeenCalled();
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
    flushSolid();
    todoChanges.mockClear();
    operations.syncTodosFromMessages(messages, {
      todos: [{ content: 'native', status: 'completed', priority: 'high' }],
    });
    flushSolid();

    expect(state.todos).toEqual([
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
    flushSolid();

    expect(todoChanges).not.toHaveBeenCalled();
  });

  it('does not let native todo update events downgrade matching completed todos', async () => {
    state.todos = [{ id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' }];
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => [
        { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
      ]),
    });

    await operations.syncTodosForSession('session-1', []);
    flushSolid();
    todoChanges.mockClear();

    operations.syncTodosFromMessages([], {
      todos: [{ id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' }],
    });
    flushSolid();

    expect(todoChanges).not.toHaveBeenCalled();
  });

  it('does not let id-less native events downgrade completed snapshots', async () => {
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => [
        { content: 'sync', status: 'completed', priority: 'medium' },
      ]),
    });

    await operations.syncTodosForSession('session-1', []);
    flushSolid();
    expect(state.todos).toEqual([
      { id: 'sync', content: 'sync', status: 'completed', priority: 'medium' },
    ]);

    state.todos = [{ id: 'sync', content: 'sync', status: 'completed', priority: 'medium' }];
    todoChanges.mockClear();
    operations.syncTodosFromMessages([], {
      todos: [{ content: 'sync', status: 'in_progress', priority: 'medium' }],
    });
    flushSolid();

    expect(todoChanges).not.toHaveBeenCalled();
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
    flushSolid();

    expect(state.todos).toEqual([
      { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
    ]);
  });

  it('hides stale native todos after a completed session settles', async () => {
    state.todos = [{ id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' }];
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => [
        { id: 'todo-1', content: 'sync', status: 'in_progress', priority: 'medium' },
      ]),
    });

    await operations.syncTodosForSession('session-1', [
      { info: userMessage('user-1'), parts: [] },
      { info: assistantMessage('assistant-1', { time: { created: 1, completed: 2 } }), parts: [] },
    ]);
    flushSolid();

    expect(state.todos).toEqual([]);
  });

  it('keeps completed native todos after a completed session settles', async () => {
    const operations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => [
        { id: 'todo-1', content: 'sync', status: 'completed', priority: 'medium' },
      ]),
    });

    await operations.syncTodosForSession('session-1', [
      { info: userMessage('user-1'), parts: [] },
      { info: assistantMessage('assistant-1', { time: { created: 1, completed: 2 } }), parts: [] },
    ]);
    flushSolid();

    expect(state.todos).toEqual([
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
    flushSolid();
    expect(state.todos).toEqual([
      { id: 'todo-1', content: 'sync', status: 'pending', priority: 'medium' },
    ]);

    todoChanges.mockClear();
    state.todos = [{ id: 'todo-1', content: 'event', status: 'pending', priority: 'medium' }];
    state.messages = [{ info: assistantMessage('assistant-1'), parts: [] }];
    state.sessionStatus = { 'session-1': { type: 'busy' } };

    const handedOff = operations.handoffTodosToMessages();
    expect(handedOff).toBe(false);
    expect(todoChanges).not.toHaveBeenCalled();

    operations.resetTodoSync();
    flushSolid();
    expect(state.todos).toEqual([]);
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
    flushSolid();

    expect(state.todos).toEqual([
      { id: 'native', content: 'native', status: 'completed', priority: 'high' },
    ]);

    todoChanges.mockClear();
    const fallbackOperations = createTodoSyncOperations({
      loadSessionTodos: vi.fn(async () => {
        throw new Error('404 Not Found');
      }),
    });

    await fallbackOperations.syncTodosForSession('session-1', messages);
    flushSolid();

    expect(state.todos).toEqual([
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
