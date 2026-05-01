import { createEffect } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMessages,
  removePermission,
  resetDefaultAppState,
  setMessagesIncremental,
  setState,
  state,
  removeMessagePart,
  upsertPart,
} from '../lib/state';
import type { AssistantMessage, FileDiff, Part, Todo } from '../types';
import { respondPermissionWithDependencies } from '../hooks/session/session-approvals';
import { createPerfRoot, settlePerfEffects } from './harness';

function createAssistantMessage(id: string): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'parent-1',
    modelID: 'gpt-4o',
    providerID: 'openai',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function createTextPart(id: string, messageID: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'text',
    text,
  };
}

function createTodo(id: string): Todo {
  return {
    id,
    content: 'Check batching',
    status: 'in_progress',
    priority: 'high',
  };
}

function createDiff(file: string): FileDiff {
  return {
    file,
    before: 'before',
    after: 'after',
    additions: 1,
    deletions: 1,
  };
}

function createPermission(
  id: string,
  groupMembers?: Array<{ id: string; sessionID: string; messageID: string }>
) {
  return {
    id,
    type: 'apply_patch' as const,
    sessionID: 'session-1',
    messageID: 'message-1',
    title: 'apply_patch',
    metadata: {},
    time: { created: 0 },
    ...(groupMembers ? { groupMembers } : {}),
  };
}

describe('state perf guards', () => {
  beforeEach(() => {
    resetDefaultAppState();
  });

  afterEach(() => {
    resetDefaultAppState();
  });

  it('clears message state with a single reactive flush', async () => {
    setState('messages', [
      {
        info: createAssistantMessage('message-1'),
        parts: [createTextPart('part-1', 'message-1', 'Streaming response')],
      },
    ]);
    setState('todos', [createTodo('todo-1')]);
    setState('diffs', [createDiff('src/example.ts')]);
    setState('streamingPartId', 'part-1');
    setState('streamingText', 'Streaming response');

    let flushCount = 0;
    const dispose = createPerfRoot(() => {
      createEffect(() => {
        void state.messages.length;
        void state.todos.length;
        void state.diffs.length;
        void state.streamingPartId;
        void state.streamingText;
        flushCount += 1;
      });
    });

    try {
      await settlePerfEffects();
      expect(flushCount).toBe(1);

      clearMessages();
      await settlePerfEffects();

      expect(flushCount).toBe(2);
      expect(state.messages).toEqual([]);
      expect(state.todos).toEqual([]);
      expect(state.diffs).toEqual([]);
      expect(state.streamingPartId).toBeNull();
      expect(state.streamingText).toBe('');
    } finally {
      dispose();
    }
  });

  it('removes grouped permissions with a single reactive flush', async () => {
    setState('permissions', [
      createPermission('perm-1', [
        { id: 'perm-1', sessionID: 'session-1', messageID: 'message-1' },
        { id: 'perm-2', sessionID: 'session-2', messageID: 'message-2' },
      ]),
    ]);

    let flushCount = 0;
    const dispose = createPerfRoot(() => {
      createEffect(() => {
        void state.permissions.map((permission) => permission.id).join(',');
        flushCount += 1;
      });
    });

    try {
      await settlePerfEffects();
      expect(flushCount).toBe(1);

      await respondPermissionWithDependencies(
        {
          getPermissions: () => state.permissions,
          respondPermission: async () => {},
          removePermission,
          setError: () => {},
        },
        'session-1',
        'perm-1',
        'always'
      );
      await settlePerfEffects();

      expect(flushCount).toBe(2);
      expect(state.permissions).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('finalizes an active streaming part with a single reactive flush', async () => {
    setState('messages', [
      {
        info: createAssistantMessage('message-1'),
        parts: [createTextPart('part-1', 'message-1', 'Partial response')],
      },
    ]);
    setState('streamingPartId', 'part-1');
    setState('streamingText', 'Partial response');

    let flushCount = 0;
    const dispose = createPerfRoot(() => {
      createEffect(() => {
        void state.messages[0]?.parts[0]?.text;
        void state.streamingPartId;
        void state.streamingText;
        flushCount += 1;
      });
    });

    try {
      await settlePerfEffects();
      expect(flushCount).toBe(1);

      upsertPart(createTextPart('part-1', 'message-1', 'Final response'));
      await settlePerfEffects();

      expect(flushCount).toBe(2);
      expect(state.messages[0]?.parts[0]?.text).toBe('Final response');
      expect(state.streamingPartId).toBeNull();
      expect(state.streamingText).toBe('');
    } finally {
      dispose();
    }
  });

  it('removes an active streaming part with a single reactive flush', async () => {
    setState('messages', [
      {
        info: createAssistantMessage('message-1'),
        parts: [createTextPart('part-1', 'message-1', 'Partial response')],
      },
    ]);
    setState('streamingPartId', 'part-1');
    setState('streamingText', 'Partial response');

    let flushCount = 0;
    const dispose = createPerfRoot(() => {
      createEffect(() => {
        void state.messages[0]?.parts.length;
        void state.streamingPartId;
        void state.streamingText;
        flushCount += 1;
      });
    });

    try {
      await settlePerfEffects();
      expect(flushCount).toBe(1);

      removeMessagePart('session-1', 'message-1', 'part-1');
      await settlePerfEffects();

      expect(flushCount).toBe(2);
      expect(state.messages[0]?.parts).toEqual([]);
      expect(state.streamingPartId).toBeNull();
      expect(state.streamingText).toBe('');
    } finally {
      dispose();
    }
  });

  it('applies incremental message refreshes with streaming reset in a single reactive flush', async () => {
    setState('messages', [
      {
        info: createAssistantMessage('message-1'),
        parts: [createTextPart('part-1', 'message-1', 'Partial response')],
      },
    ]);
    setState('streamingPartId', 'part-1');
    setState('streamingText', 'Partial response');

    let flushCount = 0;
    const dispose = createPerfRoot(() => {
      createEffect(() => {
        void state.messages[0]?.info.modelID;
        void state.messages[0]?.parts[0]?.text;
        void state.streamingPartId;
        void state.streamingText;
        flushCount += 1;
      });
    });

    try {
      await settlePerfEffects();
      expect(flushCount).toBe(1);

      setMessagesIncremental([
        {
          info: {
            ...createAssistantMessage('message-1'),
            modelID: 'gpt-4.1',
          },
          parts: [createTextPart('part-1', 'message-1', 'Final response')],
        },
      ]);
      await settlePerfEffects();

      expect(flushCount).toBe(2);
      expect(state.messages[0]?.info.modelID).toBe('gpt-4.1');
      expect(state.messages[0]?.parts[0]?.text).toBe('Final response');
      expect(state.streamingPartId).toBeNull();
      expect(state.streamingText).toBe('');
    } finally {
      dispose();
    }
  });
});
