import { createRoot } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import {
  assistantMessage,
  getClientMocks,
  loadModules,
  session,
  todoPart,
  userMessage,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();

describe('useOpenCode todo synchronization', () => {
  it('rebuilds todos from refreshed messages after stale todo events', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([
      { info: userMessage('user-1'), parts: [] },
      {
        info: assistantMessage('assistant-1', 'user-1'),
        parts: [todoPart('todo-part-1', 'assistant-1', 'Summarize findings', 'completed')],
      },
    ]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        { info: userMessage('user-1'), parts: [] },
        {
          info: assistantMessage('assistant-1', 'user-1'),
          parts: [todoPart('todo-part-1', 'assistant-1', 'Summarize findings', 'in_progress')],
        },
      ]);

      handlers.get('todo.updated')?.({
        properties: {
          sessionID: 'session-1',
          todos: [
            {
              id: 'todo-part-1-todo',
              content: 'Summarize findings',
              status: 'in_progress',
              priority: 'medium',
            },
          ],
        },
      });

      expect(stateModule.state.todos).toEqual([
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'in_progress',
          priority: 'medium',
        },
      ]);

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

      await vi.waitFor(() => {
        expect(stateModule.state.todos).toEqual([
          {
            id: 'todo-part-1-todo',
            content: 'Summarize findings',
            status: 'completed',
            priority: 'medium',
          },
        ]);
      });
    } finally {
      dispose();
    }
  });

  it('rebuilds todos from messages when the active assistant message completes', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        { info: userMessage('user-1'), parts: [] },
        {
          info: assistantMessage('assistant-1', 'user-1'),
          parts: [todoPart('todo-part-1', 'assistant-1', 'Summarize findings', 'completed')],
        },
      ]);

      handlers.get('todo.updated')?.({
        properties: {
          sessionID: 'session-1',
          todos: [
            {
              id: 'todo-part-1-todo',
              content: 'Summarize findings',
              status: 'in_progress',
              priority: 'medium',
            },
          ],
        },
      });

      expect(stateModule.state.todos).toEqual([
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'completed',
          priority: 'medium',
        },
      ]);

      handlers.get('message.updated')?.({
        properties: {
          info: {
            ...assistantMessage('assistant-1', 'user-1'),
            time: { created: 0, completed: 1 },
          },
        },
      });

      expect(stateModule.state.todos).toEqual([
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'completed',
          priority: 'medium',
        },
      ]);
    } finally {
      dispose();
    }
  });

  it('clears stale event todos when the refreshed messages still have no todo parts', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([
      { info: userMessage('user-1'), parts: [] },
      {
        info: {
          ...assistantMessage('assistant-1', 'user-1'),
          time: { created: 0, completed: 1 },
        },
        parts: [],
      },
    ]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        { info: userMessage('user-1'), parts: [] },
        {
          info: assistantMessage('assistant-1', 'user-1'),
          parts: [],
        },
      ]);

      handlers.get('todo.updated')?.({
        properties: {
          sessionID: 'session-1',
          todos: [
            {
              id: 'todo-part-1-todo',
              content: 'Summarize findings',
              status: 'completed',
              priority: 'medium',
            },
          ],
        },
      });

      expect(stateModule.state.todos).toEqual([]);

      handlers.get('message.updated')?.({
        properties: {
          info: {
            ...assistantMessage('assistant-1', 'user-1'),
            time: { created: 0, completed: 1 },
          },
        },
      });

      expect(stateModule.state.todos).toEqual([]);

      handlers.get('session.idle')?.({ properties: { sessionID: 'session-1' } });

      await vi.waitFor(() => {
        expect(stateModule.state.todos).toEqual([]);
      });
    } finally {
      dispose();
    }
  });

  it('keeps visible todos during active progress when a newer assistant update has no todo parts yet', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        { info: userMessage('user-1'), parts: [] },
        {
          info: assistantMessage('assistant-1', 'user-1'),
          parts: [todoPart('todo-part-1', 'assistant-1', 'Summarize findings', 'in_progress')],
        },
      ]);
      stateModule.setState('sessionStatus', { 'session-1': { type: 'busy' } });
      stateModule.startLoading();
      stateModule.setState('todos', [
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'in_progress',
          priority: 'medium',
        },
      ]);

      handlers.get('message.updated')?.({
        properties: {
          info: {
            ...assistantMessage('assistant-2', 'user-1'),
            time: { created: 1 },
          },
        },
      });

      expect(stateModule.state.todos).toEqual([
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'in_progress',
          priority: 'medium',
        },
      ]);
    } finally {
      dispose();
    }
  });

  it('ignores todo.updated payload contents while the active assistant reply is still running', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        { info: userMessage('user-1'), parts: [] },
        {
          info: assistantMessage('assistant-1', 'user-1'),
          parts: [todoPart('todo-part-1', 'assistant-1', 'Summarize findings', 'in_progress')],
        },
      ]);
      stateModule.setState('todos', [
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'in_progress',
          priority: 'medium',
        },
      ]);

      handlers.get('todo.updated')?.({
        properties: {
          sessionID: 'session-1',
          todos: [
            {
              id: 'todo-part-1-todo',
              content: 'Stale event payload',
              status: 'completed',
              priority: 'medium',
            },
          ],
        },
      });

      expect(stateModule.state.todos).toEqual([
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'in_progress',
          priority: 'medium',
        },
      ]);
    } finally {
      dispose();
    }
  });

  it('ignores stale todo events after the active assistant message completes', async () => {
    const handlers = new Map<string, (data: unknown) => void>();
    clientMocks.serverEventsOn.mockImplementation((event, handler) => {
      handlers.set(event as string, handler as (data: unknown) => void);
      return () => {
        handlers.delete(event as string);
      };
    });

    clientMocks.health.mockResolvedValue({ healthy: true, version: '1.0.0' });
    clientMocks.sessionList.mockResolvedValue([]);
    clientMocks.agentList.mockResolvedValue([]);
    clientMocks.providerList.mockResolvedValue({ providers: [], default: {} });
    clientMocks.questionList.mockResolvedValue([]);

    const { stateModule, hookModule } = await loadModules();
    const dispose = createRoot((cleanup) => {
      hookModule.useOpenCode();
      return cleanup;
    });

    try {
      await Promise.resolve();

      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('messages', [
        { info: userMessage('user-1'), parts: [] },
        {
          info: {
            ...assistantMessage('assistant-1', 'user-1'),
            time: { created: 0, completed: 1 },
          },
          parts: [todoPart('todo-part-1', 'assistant-1', 'Summarize findings', 'completed')],
        },
      ]);
      stateModule.setState('todos', [
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'completed',
          priority: 'medium',
        },
      ]);

      handlers.get('todo.updated')?.({
        properties: {
          sessionID: 'session-1',
          todos: [
            {
              id: 'todo-part-1-todo',
              content: 'Summarize findings',
              status: 'in_progress',
              priority: 'medium',
            },
          ],
        },
      });

      expect(stateModule.state.todos).toEqual([
        {
          id: 'todo-part-1-todo',
          content: 'Summarize findings',
          status: 'completed',
          priority: 'medium',
        },
      ]);
    } finally {
      dispose();
    }
  });
});
