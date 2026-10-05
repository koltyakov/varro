import { createEffect } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearMessages,
  getMessageById,
  getMessagePartById,
  messageInfoVersion,
  messageStructureVersion,
  removeMessage,
  removePermission,
  resetDefaultAppState,
  setMessagesIncremental,
  setState,
  state,
  removeMessagePart,
  upsertMessage,
  upsertMessageInfo,
  upsertPart,
} from '../lib/state';
import type { AssistantMessage, FileDiff, NormalizedTodo, Permission, TextPart } from '../types';
import { respondPermissionWithDependencies } from '../hooks/session/session-approvals';
import { createPerfRoot, settlePerfEffects } from './harness';
import { defaultAppState, messageIndex } from '../lib/app-state';
import { flushPendingStreamingDeltasFor } from '../lib/streaming-deltas';

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

function createTextPart(id: string, messageID: string, text: string): TextPart {
  return {
    id,
    sessionID: 'session-1',
    messageID,
    type: 'text',
    text,
  };
}

function createTodo(id: string): NormalizedTodo {
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
  const part: Permission = {
    id,
    type: 'apply_patch' as const,
    sessionID: 'session-1',
    messageID: 'message-1',
    title: 'apply_patch',
    metadata: {},
    time: { created: 0 },
  };
  if (groupMembers) part.groupMembers = groupMembers;
  return part;
}

describe('state perf guards', () => {
  beforeEach(() => {
    resetDefaultAppState();
  });

  afterEach(() => {
    resetDefaultAppState();
  });

  it.each(['upsertMessage', 'upsertMessageInfo'] as const)(
    '%s appends messages without rescanning historical parts',
    (operation) => {
      let historicalPartAccesses = 0;
      const history = Array.from({ length: 1000 }, (_, index) => {
        const parts = Array.from({ length: 8 }, (_part, partIndex) =>
          createTextPart(`part-${index}-${partIndex}`, `message-${index}`, 'History')
        );
        return {
          info: createAssistantMessage(`message-${index}`),
          get parts() {
            historicalPartAccesses++;
            return parts;
          },
        };
      });
      setState('messages', history);
      const retained = state.messages.map((entry) => ({ entry, parts: entry.parts.slice() }));
      messageIndex.ensureIndex(state.messages);
      historicalPartAccesses = 0;
      const structureVersion = messageStructureVersion();
      const infoVersion = messageInfoVersion();

      for (let index = 0; index < 10; index++) {
        const id = `new-${index}`;
        const info = createAssistantMessage(id);
        if (operation === 'upsertMessage') {
          upsertMessage({ info, parts: [createTextPart(`${id}-initial`, id, 'Initial')] });
        } else upsertMessageInfo(info);
        expect(messageStructureVersion()).toBe(structureVersion + index * 2 + 1);
        expect(messageInfoVersion()).toBe(infoVersion + index + 1);
        expect(getMessageById(id)).toBe(state.messages[1000 + index]);

        upsertPart(createTextPart(`${id}-received`, id, 'Received'));
        const entry = state.messages[1000 + index]!;
        for (let partIdx = 0; partIdx < entry.parts.length; partIdx++) {
          const part = entry.parts[partIdx]!;
          expect(messageIndex.getIndexedPartLocation(part.id)).toEqual({
            msgIdx: 1000 + index,
            partIdx,
          });
          expect(getMessagePartById(id, part.id)).toBe(part);
        }
      }

      expect(historicalPartAccesses).toBe(0);
      expect(messageStructureVersion()).toBe(structureVersion + 20);
      expect(messageInfoVersion()).toBe(infoVersion + 10);
      for (let index = 0; index < retained.length; index++) {
        expect(state.messages[index]).toBe(retained[index]!.entry);
        for (let partIdx = 0; partIdx < retained[index]!.parts.length; partIdx++) {
          expect(state.messages[index]!.parts[partIdx]).toBe(retained[index]!.parts[partIdx]);
        }
      }
    }
  );

  it.each(['upsertMessage', 'upsertMessageInfo'] as const)(
    '%s keeps append indexes correct across destructive history transitions',
    (operation) => {
      const append = (id: string) => {
        const info = createAssistantMessage(id);
        if (operation === 'upsertMessage') upsertMessage({ info, parts: [] });
        else upsertMessageInfo(info);
        upsertPart(createTextPart(`${id}-part`, id, 'Received'));
        const entry = getMessageById(id)!;
        expect(getMessagePartById(id, `${id}-part`)).toBe(entry.parts[0]);
        expect(messageIndex.getIndexedPartLocation(`${id}-part`)).toEqual({
          msgIdx: state.messages.length - 1,
          partIdx: 0,
        });
        return entry;
      };
      const first = append('first');
      const firstPart = first.parts[0];
      append('second');

      setMessagesIncremental([
        { info: createAssistantMessage('older'), parts: [] },
        ...state.messages,
      ]);
      expect(getMessagePartById('first', 'first-part')).toBe(firstPart);
      expect(messageIndex.getIndexedPartLocation('first-part')).toEqual({ msgIdx: 1, partIdx: 0 });
      expect(state.messages[1]).toBe(first);
      append('after-prepend');

      removeMessage('session-1', 'first');
      expect(getMessageById('first')).toBeNull();
      expect(getMessagePartById('first', 'first-part')).toBeNull();
      expect(getMessagePartById('second', 'second-part')).toBe(state.messages[1]!.parts[0]);
      append('after-remove');

      upsertMessage({
        info: createAssistantMessage('second'),
        parts: [createTextPart('replacement-part', 'second', 'Replacement')],
      });
      expect(getMessagePartById('second', 'second-part')).toBeNull();
      expect(getMessagePartById('second', 'replacement-part')).toBe(state.messages[1]!.parts[0]);
      append('after-replacement');

      clearMessages();
      append('second');
      expect(getMessagePartById('second', 'replacement-part')).toBeNull();
      expect(getMessageById('after-replacement')).toBeNull();

      resetDefaultAppState();
      append('first');
      expect(getMessageById('second')).toBeNull();
      expect(getMessagePartById('second', 'second-part')).toBeNull();
    }
  );

  it.each(['upsert', 'delta'] as const)(
    'does not access unrelated historical parts when %s creates parts with a warm index',
    (operation) => {
      let historicalPartAccesses = 0;
      const history = Array.from({ length: 1000 }, (_, index) => {
        const parts = [createTextPart(`part-${index}`, `message-${index}`, 'History')];
        return {
          info: createAssistantMessage(`message-${index}`),
          get parts() {
            historicalPartAccesses++;
            return parts;
          },
        };
      });
      setState('messages', [...history, { info: createAssistantMessage('active'), parts: [] }]);
      messageIndex.ensureIndex(state.messages);
      historicalPartAccesses = 0;

      for (let index = 0; index < 10; index++) {
        const partId = `new-${index}`;
        if (operation === 'upsert') {
          upsertPart(createTextPart(partId, 'active', 'New text'));
        } else {
          defaultAppState.streamingDeltaQueue.set({
            messageId: 'active',
            partId,
            partType: 'text',
            partStartedAt: 0,
            text: 'New text',
          });
          flushPendingStreamingDeltasFor(defaultAppState);
        }
      }

      expect(historicalPartAccesses).toBe(0);
      expect(state.messages[1000]!.parts.map((part) => part.id)).toEqual(
        Array.from({ length: 10 }, (_, index) => `new-${index}`)
      );
      expect(messageIndex.getIndexedPartLocation('new-9')).toEqual({
        msgIdx: 1000,
        partIdx: 9,
      });
    }
  );

  it.each(['upsert', 'delta'] as const)(
    '%s resolves part owners after a history prepend',
    (operation) => {
      setMessagesIncremental([
        {
          info: createAssistantMessage('active'),
          parts: [createTextPart('existing', 'active', 'Before')],
        },
      ]);
      messageIndex.ensureIndex(state.messages);
      setMessagesIncremental([
        {
          info: createAssistantMessage('older'),
          parts: [createTextPart('historical', 'older', 'History')],
        },
        ...state.messages,
      ]);

      for (const partId of ['existing', 'new']) {
        if (operation === 'upsert') {
          upsertPart(createTextPart(partId, 'active', 'Before and after'));
        } else {
          defaultAppState.streamingDeltaQueue.set({
            messageId: 'active',
            partId,
            partType: 'text',
            partStartedAt: 0,
            text: 'Before and after',
          });
        }
      }
      flushPendingStreamingDeltasFor(defaultAppState);

      expect(state.messages[0]!.parts).toEqual([createTextPart('historical', 'older', 'History')]);
      expect(state.messages[1]!.parts).toEqual([
        createTextPart('existing', 'active', 'Before and after'),
        createTextPart('new', 'active', 'Before and after'),
      ]);
      expect(messageIndex.getIndexedPartLocation('new')).toEqual({ msgIdx: 1, partIdx: 1 });
    }
  );

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

  it('removes a selected grouped permission with a single reactive flush', async () => {
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
          respondPermission: async () => {},
          removePermission,
          setError: () => {},
        },
        'session-1',
        'perm-1',
        'once'
      );
      await settlePerfEffects();

      expect(flushCount).toBe(2);
      expect(state.permissions).toHaveLength(1);
      expect(state.permissions[0]?.id).toBe('perm-2');
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
        const part = state.messages[0]?.parts[0];
        void (part?.type === 'text' ? part.text : undefined);
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
      const part = state.messages[0]?.parts[0];
      expect(part?.type === 'text' ? part.text : undefined).toBe('Final response');
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
        const info = state.messages[0]?.info;
        const part = state.messages[0]?.parts[0];
        void (info?.role === 'assistant' ? info.modelID : undefined);
        void (part?.type === 'text' ? part.text : undefined);
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
      const info = state.messages[0]?.info;
      const part = state.messages[0]?.parts[0];
      expect(info?.role === 'assistant' ? info.modelID : undefined).toBe('gpt-4.1');
      expect(part?.type === 'text' ? part.text : undefined).toBe('Final response');
      expect(state.streamingPartId).toBeNull();
      expect(state.streamingText).toBe('');
    } finally {
      dispose();
    }
  });

  it('preserves unchanged shared-prefix entries during large incremental appends', async () => {
    const existingMessages = Array.from({ length: 1000 }, (_, index) => ({
      info: createAssistantMessage(`message-${index}`),
      parts: [createTextPart(`part-${index}`, `message-${index}`, `Response ${index}`)],
    }));
    setState('messages', existingMessages);

    const firstEntry = state.messages[0];
    const middleEntry = state.messages[500];
    const lastExistingEntry = state.messages[999];

    let flushCount = 0;
    const dispose = createPerfRoot(() => {
      createEffect(() => {
        void state.messages.length;
        void state.messages[1000]?.info.id;
        flushCount += 1;
      });
    });

    try {
      await settlePerfEffects();
      expect(flushCount).toBe(1);

      setMessagesIncremental([
        ...state.messages,
        {
          info: createAssistantMessage('message-1000'),
          parts: [createTextPart('part-1000', 'message-1000', 'Appended response')],
        },
      ]);
      await settlePerfEffects();

      expect(flushCount).toBe(2);
      expect(state.messages).toHaveLength(1001);
      expect(state.messages[0]).toBe(firstEntry);
      expect(state.messages[500]).toBe(middleEntry);
      expect(state.messages[999]).toBe(lastExistingEntry);
      expect(state.messages[1000]?.info.id).toBe('message-1000');
    } finally {
      dispose();
    }
  });

  it('preserves a large retained suffix during an interleaved history insertion', () => {
    const existingMessages = Array.from({ length: 1000 }, (_, index) => ({
      info: {
        ...createAssistantMessage(`message-${index}`),
        sessionID: index === 0 ? 'child-1' : 'session-1',
      },
      parts: [createTextPart(`part-${index}`, `message-${index}`, `Response ${index}`)],
    }));
    setMessagesIncremental(existingMessages);
    const retainedEntries = [...state.messages];
    const retainedParts = state.messages.map((entry) => entry.parts[0]);

    setMessagesIncremental([
      state.messages[0]!,
      {
        info: createAssistantMessage('message-older'),
        parts: [createTextPart('part-older', 'message-older', 'Older response')],
      },
      ...state.messages.slice(1),
    ]);

    expect(state.messages).toHaveLength(1001);
    for (let index = 0; index < retainedEntries.length; index += 1) {
      const nextIndex = index === 0 ? 0 : index + 1;
      expect(state.messages[nextIndex]).toBe(retainedEntries[index]);
      expect(state.messages[nextIndex]?.parts[0]).toBe(retainedParts[index]);
    }
  });

  it.each(['refresh', 'append'] as const)(
    'does not reread retained tool bodies during a history-tail %s',
    (change) => {
      let outputReads = 0;
      const existingMessages = Array.from({ length: 1000 }, (_, index) => ({
        info: createAssistantMessage(`message-${index}`),
        parts: [
          {
            id: `tool-${index}`,
            messageID: `message-${index}`,
            sessionID: 'session-1',
            type: 'tool' as const,
            tool: 'bash',
            callID: `call-${index}`,
            state: {
              status: 'completed' as const,
              input: { command: 'pwd' },
              title: 'Working directory',
              get output() {
                outputReads += 1;
                return '/workspace';
              },
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        ],
      }));
      setState('messages', existingMessages);
      const retained = [...state.messages];
      outputReads = 0;

      setMessagesIncremental([
        ...retained.slice(0, -1),
        {
          info: createAssistantMessage('message-999'),
          parts: [createTextPart('part-999', 'message-999', 'Refreshed response')],
        },
        ...(change === 'append'
          ? [
              {
                info: createAssistantMessage('message-1000'),
                parts: [createTextPart('part-1000', 'message-1000', 'Appended response')],
              },
            ]
          : []),
      ]);

      expect(outputReads).toBe(0);
      expect(state.messages).toHaveLength(change === 'append' ? 1001 : 1000);
      expect(state.messages[0]).toBe(retained[0]);
      expect(state.messages[998]).toBe(retained[998]);
      expect(state.messages[999]?.parts[0]).toMatchObject({ text: 'Refreshed response' });
      if (change === 'append')
        expect(state.messages[1000]?.parts[0]).toMatchObject({ text: 'Appended response' });
    }
  );
});
