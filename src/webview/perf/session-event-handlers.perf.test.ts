import { createEffect } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../../shared/protocol';
import { registerSessionEventHandlers } from '../hooks/session/session-event-handlers';
import { SessionLifecycleOperations } from '../hooks/session/session-lifecycle';
import { serverEvents } from '../lib/client';
import {
  getAssistantActivityGroupMap,
  preserveAssistantActivityGroupKeys,
  type AssistantActivityGroupInfo,
} from '../lib/assistant-activity';
import {
  getCompactActivityDisclosureLayoutSignatures,
  getRenderEmptyMessageIds,
} from '../components/message-list/row-layout';
import {
  applyMessagePartDelta,
  finishMessageStreaming,
  isLoading,
  messageInfoVersion,
  messageStructureVersion,
  resetDefaultAppState,
  setMessagesIncremental,
  setState,
  startLoading,
  state,
} from '../lib/state';
import { sessionStore } from '../lib/stores/session-store';
import type { AssistantMessage, MessageEntry } from '../types';
import { createPerfRoot, settlePerfEffects } from './harness';

function assistant(id: string, completed?: number): AssistantMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 1, completed },
    parentID: 'user-1',
    modelID: 'test-model',
    providerID: 'test-provider',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

describe('settlement event perf guards', () => {
  beforeEach(() => {
    resetDefaultAppState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDefaultAppState();
    vi.useRealTimers();
  });

  it.each([
    { boundary: 'event', pendingDelta: true, busyChild: false },
    { boundary: 'event', pendingDelta: false, busyChild: false },
    { boundary: 'event', pendingDelta: false, busyChild: true },
    { boundary: 'event', pendingDelta: false, busyChild: 'new' },
    { boundary: 'state', pendingDelta: true, busyChild: false },
    { boundary: 'state', pendingDelta: false, busyChild: false },
    { boundary: 'part', pendingDelta: false, busyChild: false },
  ])(
    'publishes $boundary settlement once after long reasoning history, pending delta: $pendingDelta, busy child: $busyChild',
    async ({ boundary, pendingDelta, busyChild }) => {
      const markdown =
        '# Settlement report\n\n- Generated fixture item\n\n```ts\nconst ready = true;\n```\n'.repeat(
          120
        );
      let baselineReads = 0;
      const messages: MessageEntry[] = Array.from({ length: 200 }, (_, index) => ({
        info: assistant(`history-${index}`, 2),
        parts: [
          {
            id: `history-part-${index}`,
            get messageID() {
              baselineReads += 1;
              return `history-${index}`;
            },
            sessionID: 'session-1',
            type: boundary === 'part' ? 'reasoning' : 'text',
            text: `Baseline ${index}\n${markdown}`,
            time: { start: 1, end: 2 },
          },
        ],
      }));
      messages.push({
        info: assistant('final'),
        parts: [
          {
            id: 'reasoning',
            messageID: 'final',
            sessionID: 'session-1',
            type: 'reasoning',
            text: 'Check the generated results.\n'.repeat(160),
            time: { start: 1, end: 2 },
          },
          { id: 'text', messageID: 'final', sessionID: 'session-1', type: 'text', text: '' },
        ],
      });
      setMessagesIncremental(messages);
      if (boundary === 'part') setState(storePath('messages', messages));
      setState(storePath('activeSessionId', 'session-1'));
      const parent = {
        id: 'session-1',
        directory: '/workspace',
        projectID: 'project',
        title: 'Parent',
        version: '1',
        time: { created: 1, updated: 2 },
      };
      const child = { ...parent, id: 'child', parentID: parent.id };
      if (busyChild) {
        sessionStore.setSessions(busyChild === 'new' ? [parent] : [parent, child]);
      }
      setState(storePath('sessionStatus', 'session-1', { type: 'busy' }));
      startLoading();
      setState(storePath('streamingPartId', 'text'));
      const finalText = `${markdown}\nFinal audit sentence.`;
      setState(storePath('streamingText', pendingDelta ? markdown : finalText));
      await settlePerfEffects();
      if (pendingDelta) {
        applyMessagePartDelta('final', 'text', '\nFinal audit sentence.', 'session-1');
      }

      const handlers = new Map<string, (event: ServerEvent) => void>();
      vi.spyOn(serverEvents, 'on').mockImplementation((type, handler) => {
        handlers.set(type, handler);
        return () => {
          handlers.delete(type);
        };
      });
      const cleanups = registerSessionEventHandlers({
        getActiveSessionId: () => state.activeSessionId,
        getSessionStatus: (id) => state.sessionStatus[id],
        getMessages: () => state.messages,
        handoffTodosToMessages: () => true,
        upsertSession: new SessionLifecycleOperations({
          getCurrentWorkspacePath: () => '/workspace',
          clearPendingAbort: vi.fn(),
          clearPendingAbortTree: vi.fn(),
          resetTodoSync: vi.fn(),
          resetToolCallExpansionState: vi.fn(),
          publishSessionModel: vi.fn(),
        }).upsertSession,
        isSessionInActiveTree: (id) =>
          sessionStore.getSessionTreeRootId(id) === sessionStore.getSessionTreeRootId(parent.id),
        setSessionCompacting: vi.fn(),
        removeDeletedSessionTree: vi.fn(),
        shouldIgnorePendingAbortStatus: () => false,
        hasPendingAbort: () => false,
        markPendingAbort: vi.fn(),
        clearPendingAbort: vi.fn(),
        setSessionStatusEntry: sessionStore.setSessionStatusEntry,
        clearUsageLimitOnResumedProgress: vi.fn(),
        updateUsageLimitState: vi.fn(),
        syncSession: async () => {},
        shouldResyncSessionAfterIdle: () => false,
        syncSessionMessages: async () => {},
        applyUsageLimitNotice: vi.fn(),
        syncTodosFromMessages: vi.fn(),
        shouldAutoApprovePermissions: () => false,
        respondPermission: async () => {},
        setDiffs: vi.fn(),
        abortRemoteSession: async () => {},
        logError: vi.fn(),
      });
      const retainedHistory = state.messages[0];
      const retainedMessage = state.messages[200];
      const retainedReasoning = retainedMessage!.parts[0];
      let recomputations = 0;
      let groups = new Map<string, AssistantActivityGroupInfo[]>();
      const dispose = createPerfRoot(() => {
        createEffect(
          () => {
            messageInfoVersion();
            messageStructureVersion();
            void state.streamingPartId;
            void state.streamingText;
            isLoading();
            void state.sessionStatus['session-1']?.type;
            for (const entry of state.messages) {
              if (entry.info.role === 'assistant') void entry.info.time.completed;
              for (const part of entry.parts) {
                if (part.type === 'text' || part.type === 'reasoning') void part.text;
              }
            }
            if (boundary === 'part') {
              groups = preserveAssistantActivityGroupKeys(
                getAssistantActivityGroupMap(state.messages),
                groups
              );
              getCompactActivityDisclosureLayoutSignatures(groups, () => false);
              getRenderEmptyMessageIds(state.messages, groups, () => false);
            }
          },
          () => {
            recomputations += 1;
          }
        );
      });
      try {
        await settlePerfEffects();
        const before = recomputations;
        baselineReads = 0;
        if (boundary === 'event') {
          handlers.get('message.updated')!({
            type: 'message.updated',
            properties: { info: { ...assistant('final', 3), finish: 'stop' } },
          });
        } else if (boundary === 'part') {
          handlers.get('message.part.updated')!({
            type: 'message.part.updated',
            properties: {
              part: {
                id: 'text',
                messageID: 'final',
                sessionID: 'session-1',
                type: 'text',
                text: finalText,
                time: { start: 2, end: 3 },
              },
            },
          });
        } else {
          finishMessageStreaming('final');
        }
        await settlePerfEffects();
        const completionPasses = recomputations - before;
        if (boundary === 'part') {
          expect
            .soft(baselineReads, 'part.updated historical activity work')
            .toBeLessThan(200 * 50);
        }
        expect(state.streamingPartId).toBeNull();
        expect(state.streamingText).toBe('');
        expect(state.messages[200]!.parts[1]).toMatchObject({
          text: finalText,
        });
        expect(state.messages[0]).toBe(retainedHistory);
        expect(state.messages[200]).toBe(retainedMessage);
        expect(state.messages[200]!.parts[0]).toBe(retainedReasoning);
        if (boundary === 'part') {
          handlers.get('message.updated')!({
            type: 'message.updated',
            properties: { info: { ...assistant('final', 3), finish: 'stop' } },
          });
          await settlePerfEffects();
        }
        if (boundary === 'event' || boundary === 'part') {
          const beforeIdle = recomputations;
          // Child progress and parent idle can arrive before either status commits.
          if (busyChild === 'new') {
            expect(state.sessions.some((session) => session.id === child.id)).toBe(false);
            handlers.get('session.created')!({
              type: 'session.created',
              properties: { info: child },
            });
          }
          if (busyChild) {
            handlers.get('session.status')!({
              type: 'session.status',
              properties: { sessionID: child.id, status: { type: 'busy' } },
            });
          }
          if (busyChild === 'new') {
            expect(state.sessions.some((session) => session.id === child.id)).toBe(false);
            expect(state.sessionStatus[child.id]).toBeUndefined();
          }
          handlers.get('session.idle')!({
            type: 'session.idle',
            properties: { sessionID: 'session-1' },
          });
          await settlePerfEffects();
          expect(state.sessionStatus['session-1']?.type).toBe('idle');
          if (busyChild) {
            expect(state.sessions.find((session) => session.id === child.id)?.parentID).toBe(
              parent.id
            );
            expect(state.sessionStatus[child.id]?.type).toBe('busy');
          }
          expect(isLoading()).toBe(Boolean(busyChild));
          expect(state.messages[200]!.info.time).toMatchObject({ completed: 3 });
          expect.soft(recomputations - beforeIdle, 'idle publication passes').toBe(1);
          const afterIdle = recomputations;
          handlers.get('session.idle')!({
            type: 'session.idle',
            properties: { sessionID: 'session-1' },
          });
          await settlePerfEffects();
          expect(recomputations, 'duplicate idle is inert').toBe(afterIdle);
        }
        expect(completionPasses, 'completion publication passes').toBe(1);
        await vi.advanceTimersByTimeAsync(20);
        expect(state.streamingPartId).toBeNull();
        expect(state.messages[200]!.parts[1]).toMatchObject({ text: finalText });
      } finally {
        dispose();
        for (const cleanup of cleanups) cleanup();
      }
    }
  );
});
