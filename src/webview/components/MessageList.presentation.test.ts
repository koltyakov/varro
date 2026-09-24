import { describe, expect, it, vi } from 'vitest';
import { batch } from 'solid-js';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import type { SessionMessageAssistant } from '@opencode/client';
import {
  replaceMessages,
  setMessagesIncremental,
  setShowFileDiffs,
  setState,
  state,
  upsertPart,
} from '../lib/state';
import { flushMessagePresentation } from '../lib/message-list-layout';
import type { CompactionPart, MessageEntry, Part, ToolPart } from '../types';
import { projectV2Event } from '../../extension/opencode-v2-events';
import { projectV2Message } from '../../extension/opencode-v2-projection';
import { parseServerEvent } from '../../shared/protocol';
import { createProjectedSessionEventHandler } from '../hooks/session/session-projected-events';
import { MessageList } from './MessageList';
import {
  assistantMessage,
  installMessageListTestEnvironment,
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

function searchPart(): ToolPart {
  return {
    ...toolPart('search', 'answer', 'search-call'),
    tool: 'grep',
    state: {
      status: 'running',
      input: { pattern: 'queue' },
      title: 'Searching',
      time: { start: 1 },
    },
  };
}

function completeSearch(part: ToolPart): ToolPart {
  return {
    ...part,
    state: {
      status: 'completed',
      input: { pattern: 'queue' },
      title: 'Searching',
      output: 'Found matches',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function openChat(parts: Part[] = []) {
  setState('activeSessionId', 'session-1');
  setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
  replaceMessages([
    { info: userMessage('prompt'), parts: [textPart('prompt-text', 'Inspect the queue')] },
    { info: assistantMessage('answer', { parentID: 'prompt', time: { created: 1 } }), parts },
  ]);
  cleanup = render(() => MessageList(), container!);
}

describe('streaming presentation handoff', () => {
  it('groups queued siblings when their disclosure opens and never replays them on collapse', async () => {
    const parts = Array.from({ length: 3 }, (_, index) => ({
      ...searchPart(),
      id: `search-${index}`,
      callID: `search-call-${index}`,
    }));
    openChat([completeSearch(searchPart()), ...parts]);
    await vi.advanceTimersByTimeAsync(600);
    expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(2);
    batch(() => parts.forEach((part) => upsertPart(completeSearch(part))));
    const summary = container!.querySelector<HTMLButtonElement>(
      'button.assistant-activity-summary'
    )!;
    summary.click();
    await vi.advanceTimersByTimeAsync(16);
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(0);
    expect(container?.textContent).toContain('4 searches');
    summary.click();
    for (let frame = 0; frame < 200; frame += 1) {
      await vi.advanceTimersByTimeAsync(16);
      expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(0);
    }
  });

  it.each([false, true])(
    'keeps presented content through a background notice and continuation with splitDelivery=%s',
    async (splitDelivery) => {
      const answer = 'Keep this already-presented answer visible while background work finishes.';
      openChat([
        completeSearch(searchPart()),
        { ...textPart('answer-text', answer), messageID: 'answer' },
      ]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(container?.textContent).toContain(answer);

      const noticePart: Part = {
        id: 'background-notice-text',
        sessionID: 'session-1',
        type: 'text',
        messageID: 'background-notice',
        synthetic: true,
        text: '<shell id="test" state="completed">Done</shell>',
      };
      setMessagesIncremental([
        ...state.messages,
        { info: userMessage('background-notice'), parts: splitDelivery ? [] : [noticePart] },
      ]);
      if (splitDelivery) {
        await vi.advanceTimersByTimeAsync(16);
        upsertPart(noticePart);
      }
      await vi.advanceTimersByTimeAsync(16);
      setMessagesIncremental([
        ...state.messages,
        {
          info: assistantMessage('continuation', { parentID: 'prompt', time: { created: 5 } }),
          parts: [],
        },
      ]);
      for (let frame = 0; frame < 150; frame += 1) {
        expect(container?.textContent).toContain(answer);
        await vi.advanceTimersByTimeAsync(16);
      }
    }
  );

  it.each([true, false])(
    'keeps presented content visible through compaction and continuation with auto=%s',
    async (auto) => {
      const answer = 'This answer was already visible before compaction.';
      openChat([
        completeSearch(searchPart()),
        { ...textPart('answer-text', answer), messageID: 'answer' },
      ]);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(container?.textContent).toContain(answer);
      const compactionPart: CompactionPart = {
        id: 'compaction-part',
        messageID: 'compaction',
        sessionID: 'session-1',
        type: 'compaction',
        auto,
        status: 'running',
      };
      const compaction: MessageEntry = {
        info: userMessage('compaction'),
        parts: [compactionPart],
      };
      setMessagesIncremental([...state.messages, compaction]);
      for (let frame = 0; frame < 20; frame += 1) {
        expect(container?.textContent).toContain(answer);
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(container?.textContent).toContain('Compacting context');

      upsertPart({ ...compactionPart, status: 'completed' });
      expect(container?.textContent).toContain('Context compacted');
      setMessagesIncremental([
        ...state.messages,
        {
          info: assistantMessage('continuation', { parentID: 'prompt', time: { created: 5 } }),
          parts: [
            { ...textPart('continuation-text', 'Continuing the work.'), messageID: 'continuation' },
          ],
        },
      ]);
      for (let frame = 0; frame < 150; frame += 1) {
        expect(container?.textContent).toContain(answer);
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(container?.textContent).toContain('Continuing the work.');
      expect(container?.textContent).toContain('Explored: 1 search');
    }
  );

  it.each([false, true])(
    'keeps a v2 answer visible through snapshot reconciliation with preserveExtraParts=%s',
    async (preserveExtraParts) => {
      const native: SessionMessageAssistant = {
        id: 'answer',
        type: 'assistant',
        agent: 'build',
        model: { providerID: 'provider', id: 'model' },
        time: { created: 1 },
        content: [
          { type: 'reasoning', text: 'Inspecting the queue', time: { created: 1, completed: 2 } },
          {
            type: 'tool',
            id: 'search',
            name: 'grep',
            time: { created: 2, completed: 3 },
            state: {
              status: 'completed',
              input: { pattern: 'queue' },
              content: [{ type: 'text', text: 'Found matches' }],
            },
          },
        ],
      };
      // SAFETY: This typed native fixture projects into the legacy parts consumed by the webview.
      const initialParts = projectV2Message(native, 'session-1').parts as Part[];
      openChat(initialParts);
      const handle = createProjectedSessionEventHandler({
        isSessionInActiveTree: (sessionId) => sessionId === 'session-1',
        getMessages: () => state.messages,
        findAssistantMessage: (_sessionId, id) =>
          state.messages.find((entry) => entry.info.id === id) ?? null,
        findPart: (messageID, partID) =>
          state.messages
            .find((entry) => entry.info.id === messageID)
            ?.parts.find((part) => part.id === partID) ?? null,
        scheduleActiveMessageSync: vi.fn(),
        syncTodosFromMessages: vi.fn(),
      });
      const answer = 'The queue is ready.';
      const event = parseServerEvent(
        projectV2Event({
          id: 'evt_answer',
          type: 'session.text.ended',
          created: 4,
          data: { sessionID: 'session-1', assistantMessageID: 'answer', ordinal: 0, text: answer },
        })[0]
      );
      if (!event?.properties) throw new Error('Expected a projected v2 text event');
      expect(handle(event.type, event.properties)).toBe(true);
      await vi.advanceTimersByTimeAsync(350);
      expect(container?.textContent).toContain(answer);

      // SAFETY: The completed native snapshot uses the same projection as initial hydration.
      const finalParts = projectV2Message(
        { ...native, content: [...native.content, { type: 'text', text: answer }] },
        'session-1'
      ).parts as Part[];
      setMessagesIncremental(
        [state.messages[0]!, { info: state.messages[1]!.info, parts: finalParts }],
        { preserveExtraParts }
      );
      for (let frame = 0; frame < 150; frame += 1) {
        if (frame === 60) {
          batch(() => {
            setState('messages', 1, 'info', 'time', { created: 1, completed: 5 });
            setState('sessionStatus', reconcile({ 'session-1': { type: 'idle' } }));
          });
        }
        expect(container?.textContent).toContain(answer);
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(state.messages[1]?.parts.map((part) => part.type)).toEqual([
        'reasoning',
        'tool',
        'text',
      ]);
    }
  );

  it.each([false, true])(
    'shows a streaming v2 patch before its input arrives with diffs=%s',
    async (diffs) => {
      setShowFileDiffs(diffs);
      openChat([completeSearch(searchPart())]);
      upsertPart({
        ...toolPart('patch-streaming', 'answer', 'patch-call'),
        tool: 'patch',
        state: { status: 'pending', input: {}, raw: '' },
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(
        container?.querySelector('.tool-status-running'),
        container?.textContent
      ).not.toBeNull();
      expect(container?.textContent).toContain('Editing');
    }
  );

  it('flushes available text when Stop interrupts an activity preview', async () => {
    openChat();
    upsertPart(completeSearch(searchPart()));
    await vi.advanceTimersByTimeAsync(100);
    expect(container?.querySelector('[data-activity-part-id="search"]')).not.toBeNull();
    upsertPart({ ...textPart('answer-text', 'Available before stopping.'), messageID: 'answer' });
    expect(container?.textContent).not.toContain('Available before stopping.');
    flushMessagePresentation('session-1');
    await Promise.resolve();
    expect(container?.textContent).toContain('Available before stopping.');
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
  });

  it('reveals an actionable permission immediately while presentation is queued', async () => {
    openChat();
    upsertPart(completeSearch(searchPart()));
    upsertPart({ ...textPart('answer-text', 'The command needs approval.'), messageID: 'answer' });
    await vi.advanceTimersByTimeAsync(100);
    setState('permissions', [
      {
        id: 'permission',
        type: 'bash',
        sessionID: 'session-1',
        messageID: 'answer',
        callID: 'approval-call',
        title: 'Allow command',
        metadata: { command: 'pwd' },
        time: { created: 1 },
      },
    ]);
    await Promise.resolve();
    expect(container?.querySelector('.permission-prompt')).not.toBeNull();
    expect(container?.textContent).toContain('The command needs approval.');
    expect(state.permissions).toHaveLength(1);
  });

  it('cancels the old queue during hydration and shows the replacement snapshot immediately', async () => {
    openChat();
    upsertPart(completeSearch(searchPart()));
    upsertPart({ ...textPart('answer-text', 'Old queued answer.'), messageID: 'answer' });
    await vi.advanceTimersByTimeAsync(100);
    setState('messagesLoading', true);
    replaceMessages([
      {
        info: assistantMessage('replacement'),
        parts: [{ ...textPart('replacement-text', 'Loaded snapshot.'), messageID: 'replacement' }],
      },
    ]);
    setState('messagesLoading', false);
    await Promise.resolve();
    expect(container?.textContent).toContain('Loaded snapshot.');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(container?.textContent).not.toContain('Old queued answer.');
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
  });

  it('groups a fast completed tool immediately when the answer arrives', async () => {
    openChat();
    await Promise.resolve();
    const search = searchPart();
    upsertPart(search);
    await vi.advanceTimersByTimeAsync(40);
    batch(() => {
      upsertPart(completeSearch(search));
      upsertPart({
        ...textPart('answer-text', 'The queue is ready.'),
        messageID: 'answer',
      });
    });
    await vi.advanceTimersByTimeAsync(100);

    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
    expect(container?.textContent).toContain('The queue is ready.');
    expect(state.messages.at(-1)?.parts.at(-1)).toMatchObject({ text: 'The queue is ready.' });

    await vi.advanceTimersByTimeAsync(2_300);
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
    expect(container?.textContent).toContain('Explored: 1 search');
    expect(container?.textContent).toContain('The queue is ready.');
    expect(container?.querySelector('[data-msg-id="answer"]')?.classList).not.toContain(
      'interactive-item-render-empty'
    );
  });

  it('groups an already visible activity when text arrives in the completion batch', async () => {
    const search = searchPart();
    openChat([search]);
    await vi.advanceTimersByTimeAsync(500);
    expect(container?.querySelector('[data-activity-part-id="search"]')).not.toBeNull();

    batch(() => {
      upsertPart(completeSearch(search));
      upsertPart({
        ...textPart('answer-text', 'A readable handoff.'),
        messageID: 'answer',
      });
      setState('streamingPartId', 'answer-text');
      setState('streamingText', 'A readable handoff.');
    });
    await Promise.resolve();
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
    expect(container?.textContent).toContain('Explored: 1 search');
    expect(container?.textContent).not.toContain('A readable handoff.');

    await vi.advanceTimersByTimeAsync(32);
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
    expect(container?.textContent).toContain('A readable handoff.');
  });

  it('drains a completed text burst without delaying canonical completion', async () => {
    openChat();
    await Promise.resolve();
    const text = 'Readable streaming words. '.repeat(100);
    batch(() => {
      upsertPart({ ...textPart('answer-text', text), messageID: 'answer' });
      setState('messages', 1, 'info', {
        ...assistantMessage('answer', { parentID: 'prompt' }),
        time: { created: 1, completed: Date.now() },
      });
      setState('sessionStatus', reconcile({ 'session-1': { type: 'idle' } }));
    });
    await Promise.resolve();
    expect(state.messages[1]?.info.time).toHaveProperty('completed');
    expect(state.messages[1]?.parts[0]).toMatchObject({ text });
    expect(
      container?.querySelector('[data-msg-id="answer"] .rendered-markdown')?.textContent?.trim()
    ).not.toBe(text.trim());
    await vi.advanceTimersByTimeAsync(350);
    expect(
      container?.querySelector('[data-msg-id="answer"] .rendered-markdown')?.textContent?.trim()
    ).toBe(text.trim());
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
  });
});
