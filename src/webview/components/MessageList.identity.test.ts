import { describe, expect, it } from 'vitest';
import { batch } from 'solid-js';
import { render } from 'solid-js/web';
import {
  applyMessagePartDelta,
  clearMessages,
  finishMessageStreaming,
  replaceMessages,
  setMessagesIncremental,
  setSessions,
  setState,
  state,
  upsertMessage,
  upsertPart,
} from '../lib/state';
import type { MessageEntry, TextPart } from '../types';
import { MessageList } from './MessageList';
import {
  assistantMessage,
  installMessageListTestEnvironment,
  installQueuedAnimationFrameMocks,
  session,
  textPart,
  toolPart,
  userMessage,
} from './MessageList.test-utils';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

installMessageListTestEnvironment({
  getContainer: () => container,
  setContainer: (element) => {
    container = element;
  },
  getCleanup: () => cleanup,
  setCleanup: (dispose) => {
    cleanup = dispose;
  },
});

describe('MessageList text ownership', () => {
  it.each(['session switch', 'early assistant recovery'] as const)(
    'keeps a late paragraph in its sole owning row after %s',
    async (transition) => {
      const frames = installQueuedAnimationFrameMocks();
      const promptId = 'msg_07ee36b0c001NmjWxvv1bEs5zU';
      const lateId = 'msg_07ee5d85f0017lFYT29SA1rAZC';
      const paragraph = 'The referenced session confirms the ACP transport requirements.';
      const lateText: TextPart = {
        id: 'prt_07ee5e7b7001aHxfz7qhD4xjOi',
        sessionID: 'session-1',
        messageID: lateId,
        type: 'text',
        text: '',
      };
      const prompt: MessageEntry = {
        info: userMessage(promptId),
        parts: [{ ...textPart('prompt-text', 'Implement ACP'), messageID: promptId }],
      };
      const steps: MessageEntry[] = Array.from({ length: 8 }, (_, index) => {
        const id = index === 6 ? lateId : `assistant-step-${index}`;
        const tool = toolPart(`tool-${index}`, id, `call-${index}`);
        tool.tool = index === 5 ? 'task' : 'read';
        tool.state = {
          status: 'completed',
          input: {},
          output: '',
          title: index === 5 ? 'Inspect adapter' : 'Inspect source',
          metadata: {},
          time: { start: index + 2, end: index + 3 },
        };
        return {
          info: assistantMessage(id, { parentID: promptId, time: { created: index + 2 } }),
          parts:
            index === 0
              ? [
                  {
                    ...textPart('first-text', 'I will check the provider architecture.'),
                    messageID: id,
                  },
                  tool,
                ]
              : index === 6
                ? [lateText, tool]
                : [tool],
        };
      });
      const transcript = [prompt, ...steps];

      try {
        setSessions([session('session-1'), session('previous-session')]);
        setState('activeSessionId', 'previous-session');
        replaceMessages([
          {
            info: assistantMessage('previous-assistant', { sessionID: 'previous-session' }),
            parts: [
              {
                ...lateText,
                id: 'previous-text',
                sessionID: 'previous-session',
                messageID: 'previous-assistant',
                text: 'Previous session text.',
              },
            ],
          },
        ]);
        cleanup = render(() => MessageList(), container!);
        applyMessagePartDelta(
          'previous-assistant',
          'previous-text',
          ' Pending old delta.',
          'previous-session'
        );
        batch(() => {
          setState('activeSessionId', 'session-1');
          clearMessages();
          if (transition === 'session switch') setMessagesIncremental(transcript);
          else upsertMessage(steps[6]!);
        });

        applyMessagePartDelta(lateId, lateText.id, paragraph, 'session-1');
        setMessagesIncremental(transcript, { preserveExtraParts: true });

        const assertOwnership = () => {
          const rows = [...container!.querySelectorAll<HTMLElement>('[data-msg-id]')];
          expect(rows.map((row) => row.dataset.msgId)).toEqual(
            transcript.map((entry) => entry.info.id)
          );
          const owners = rows.filter((row) => row.textContent?.includes(paragraph));
          expect(owners.map((row) => row.dataset.msgId)).toEqual([lateId]);
          expect(container!.textContent?.split(paragraph).length).toBe(2);
          expect(container!.textContent).not.toContain('Previous session text');
          expect(container!.textContent).not.toContain('Pending old delta');
          expect(
            state.messages
              .filter((entry) => entry.parts.some((part) => part.id === lateText.id))
              .map((entry) => entry.info.id)
          ).toEqual([lateId]);
        };

        for (let frame = 0; frame < 3; frame += 1) {
          frames.flush();
          await Promise.resolve();
          assertOwnership();
        }
        upsertPart({ ...lateText, text: paragraph });
        finishMessageStreaming(lateId);
        setMessagesIncremental(
          transcript.map((entry) => ({
            ...entry,
            parts: entry.parts.map((part) =>
              part.id === lateText.id ? { ...lateText, text: paragraph } : part
            ),
          }))
        );
        frames.flush();
        await Promise.resolve();
        assertOwnership();
      } finally {
        frames.restore();
      }
    }
  );
});
