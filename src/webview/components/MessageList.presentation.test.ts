import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it, vi } from 'vitest';

import { render } from '@solidjs/web';
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
  setStateRecord,
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
  setState(storePath('activeSessionId', 'session-1'));
  setStateRecord('sessionStatus', { 'session-1': { type: 'busy' } });
  replaceMessages([
    { info: userMessage('prompt'), parts: [textPart('prompt-text', 'Inspect the queue')] },
    { info: assistantMessage('answer', { parentID: 'prompt', time: { created: 1 } }), parts },
  ]);
  cleanup = render(() => MessageList(), container!);
}

describe('streaming presentation handoff', () => {
  it('mounts a paced text part once and keeps its node as the remaining text arrives', async () => {
    openChat([{ ...textPart('first', 'Already visible'), messageID: 'answer' }]);
    flushSolid();
    const flow = container!.querySelector<HTMLElement>('.assistant-message-flow')!;
    const selector = '[data-assistant-render-key="part:second"]';
    const mounts: Element[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.matches(selector)) mounts.push(node);
        }
      }
    });
    observer.observe(flow, { childList: true });
    try {
      const text = 'A paced response with enough words for several updates. '.repeat(8).trim();
      upsertPart({ ...textPart('second', text), messageID: 'answer' });
      flushSolid();
      await vi.advanceTimersByTimeAsync(2_000);
      flushSolid();
      expect(mounts).toHaveLength(1);
      expect(flow.querySelector(selector)).toBe(mounts[0]);
      expect(mounts[0]?.textContent).toContain(text);
    } finally {
      observer.disconnect();
    }
  });

  it('restores the turn verb cycle and duration after hydration with a recent completion', async () => {
    vi.setSystemTime(12_001);
    flushSolid();
    const completed = completeSearch(searchPart());
    if (completed.state.status !== 'completed') throw new Error('Expected completed tool fixture');
    completed.state.time.end = Date.now();
    openChat([completed]);
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Considering');
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('0s');
    await vi.advanceTimersByTimeAsync(6_000);
    flushSolid();
    upsertPart({
      ...completed,
      state: { ...completed.state, time: { start: 1, end: Date.now() } },
    });
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Pondering');
    expect(container?.querySelector('.loading-elapsed')?.textContent).toBe('0s');
  });

  it('keeps one summary around a delayed running tool and its completion', async () => {
    const before = completeSearch({ ...searchPart(), id: 'before', callID: 'before-call' });
    const running = { ...searchPart(), id: 'long', callID: 'long-call' };
    const after = completeSearch({ ...searchPart(), id: 'after', callID: 'after-call' });
    openChat([before, running, after]);
    flushSolid();
    expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 2 searches'
    );
    for (let frame = 0; frame < 250; frame += 1) {
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
      expect(container?.querySelector('.assistant-activity-summary-placeholder')).toBeNull();
    }
    upsertPart(completeSearch(running));
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored: 3 searches'
    );
  });

  it('shares one summary across messages on both sides of a delayed running tool', async () => {
    openChat([completeSearch(searchPart())]);
    flushSolid();
    const running = { ...searchPart(), id: 'middle-tool', messageID: 'middle' };
    const after = completeSearch({ ...searchPart(), id: 'after-tool', messageID: 'after' });
    setMessagesIncremental([
      ...state.messages,
      {
        info: assistantMessage('middle', { parentID: 'prompt', time: { created: 3 } }),
        parts: [running],
      },
      {
        info: assistantMessage('after', { parentID: 'prompt', time: { created: 4 } }),
        parts: [after],
      },
    ]);
    flushSolid();
    for (let frame = 0; frame < 250; frame += 1) {
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
      expect(container?.querySelector('.assistant-activity-summary-placeholder')).toBeNull();
    }
  });

  it('does not add Exploring after Explored when a queued tool separates them', async () => {
    openChat([completeSearch(searchPart())]);
    flushSolid();
    const queued = { ...searchPart(), id: 'queued', callID: 'queued-call' };
    const running = { ...searchPart(), id: 'running', callID: 'running-call' };
    (() => {
      upsertPart(queued);
      upsertPart(running);
    })();
    for (let frame = 0; frame < 300; frame += 1) {
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      expect(container?.querySelectorAll('.assistant-activity-summary')).toHaveLength(1);
      expect(container?.querySelector('.assistant-activity-summary-placeholder')).toBeNull();
    }
  });

  it('rotates the visible tool while queued running tools stay out of Explored', async () => {
    openChat();
    flushSolid();
    const startedAt = Date.now();
    const tools = ['long', 'two', 'three'].map((id) => ({
      ...searchPart(),
      id,
      callID: `${id}-call`,
      state: {
        status: 'running' as const,
        input: { pattern: id },
        time: { start: startedAt },
      },
    }));
    (() => tools.forEach(upsertPart))();
    await vi.advanceTimersByTimeAsync(2_999);
    flushSolid();
    expect(container?.querySelector('[data-activity-part-id="long"]')).not.toBeNull();
    const tray = container?.querySelector('.assistant-active-activity-tray');
    for (const expected of ['two', 'long', 'three', 'long']) {
      for (let frame = 0; frame < 70; frame += 1) {
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
        expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(1);
        expect(container?.querySelector('.loading-verb')?.textContent).not.toBe('Waiting');
        expect(container?.querySelector('.interactive-loading-row')?.classList).toContain(
          'is-reserved'
        );
        expect(container?.querySelector('.assistant-active-activity-item.is-exiting')).toBeNull();
        expect(container?.textContent).not.toContain('Explored:');
        if (container?.querySelector(`[data-activity-part-id="${expected}"]`)) break;
      }
      expect(container?.querySelector(`[data-activity-part-id="${expected}"]`)).not.toBeNull();
      expect(container?.querySelector('.assistant-active-activity-tray')).toBe(tray);
      expect(container?.querySelector('.assistant-active-activity-item.is-entering')).toBeNull();
    }
    expect(
      state.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === 'tool')
        .every((part) => part.state.status === 'running')
    ).toBe(true);
  });

  it('hides the existing status row during a tool preview and restores it when tools finish', async () => {
    vi.setSystemTime(1);
    flushSolid();
    openChat();
    flushSolid();
    const row = container?.querySelector('.interactive-loading-row');
    expect(row?.textContent).toContain('Thinking');
    const running = searchPart();
    upsertPart(running);
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(container?.querySelector('.interactive-loading-row')).toBe(row);
    expect(row?.classList).toContain('is-reserved');
    expect(row?.getAttribute('aria-hidden')).toBe('true');
    expect(container?.querySelector('.loading-verb')?.textContent).not.toBe('Waiting');
    upsertPart(completeSearch(running));
    flushSolid();
    await vi.advanceTimersByTimeAsync(3_000);
    flushSolid();
    expect(container?.querySelector('.interactive-loading-row')).toBe(row);
    expect(row?.classList).not.toContain('is-reserved');
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Thinking');
    expect(container?.querySelectorAll('.interactive-loading-row')).toHaveLength(1);
  });

  it('hides the loading label for pending tool previews and restores it after a tool error', async () => {
    vi.setSystemTime(1);
    flushSolid();
    openChat();
    flushSolid();
    const pending = searchPart();
    pending.state = { status: 'pending', input: { pattern: 'queue' }, raw: '' };
    upsertPart(pending);
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(container?.querySelector('.interactive-loading-row')?.classList).toContain(
      'is-reserved'
    );
    expect(container?.querySelector('.loading-verb')?.textContent).not.toBe('Waiting');
    upsertPart({
      ...pending,
      state: {
        status: 'error',
        input: { pattern: 'queue' },
        error: 'Search failed',
        time: { start: 1, end: 2 },
      },
    });
    flushSolid();
    await vi.advanceTimersByTimeAsync(3_000);
    flushSolid();
    expect(container?.querySelector('.loading-verb')?.textContent).toBe('Thinking');
  });

  it.each(['running', 'completed'] as const)(
    'replaces a completed tool with a %s preview instantly',
    async (status) => {
      openChat();
      flushSolid();
      const completed = completeSearch(searchPart());
      if (completed.state.status !== 'completed')
        throw new Error('Expected completed tool fixture');
      completed.state.time.end = 1_001;
      const replacement = {
        ...(status === 'running' ? searchPart() : completed),
        id: 'replacement',
        callID: 'replacement-call',
      };
      (() => {
        upsertPart(completed);
        upsertPart(replacement);
      })();
      await vi.advanceTimersByTimeAsync(1_299);
      flushSolid();
      expect(container?.querySelector('[data-activity-part-id="search"]')).not.toBeNull();
      expect(container?.querySelector('[data-activity-part-id="replacement"]')).toBeNull();
      const tray = container?.querySelector('.assistant-active-activity-tray');
      for (let frame = 0; frame < 20; frame += 1) {
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
        expect(container?.querySelector('.assistant-active-activity-item.is-exiting')).toBeNull();
        expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(1);
        if (!container?.querySelector('[data-activity-part-id="search"]')) break;
      }
      expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
      expect(container?.querySelector('[data-activity-part-id="replacement"]')).not.toBeNull();
      expect(container?.querySelector('.assistant-active-activity-tray')).toBe(tray);
      expect(container?.querySelector('.assistant-active-activity-item.is-entering')).toBeNull();
      expect(container?.querySelector('.assistant-active-activity-item.is-exiting')).toBeNull();
      expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
        'Explored: 1 search'
      );
    }
  );

  it.each(['completed', 'error'] as const)(
    'groups a short %s tool and previews the running alternative',
    async (status) => {
      openChat();
      flushSolid();
      const short = completeSearch(searchPart());
      if (status === 'error') {
        short.state = {
          status: 'error',
          input: { pattern: 'queue' },
          error: 'Search failed',
          time: { start: 1, end: 2 },
        };
      }
      const running = { ...searchPart(), id: 'running', callID: 'running-call' };
      (() => {
        upsertPart(short);
        upsertPart(running);
      })();
      await vi.advanceTimersByTimeAsync(600);
      flushSolid();
      const items = container?.querySelectorAll<HTMLElement>('.assistant-active-activity-item');
      expect(items).toHaveLength(1);
      expect(items?.[0]?.dataset.activityPartId).toBe('running');
      expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
        'Explored: 1 search'
      );
      upsertPart(completeSearch(running));
      flushSolid();
      await vi.advanceTimersByTimeAsync(3_000);
      flushSolid();
      expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(0);
      expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
        'Explored: 2 searches'
      );
    }
  );

  it.each([
    { boundary: 'text', delay: 600 },
    { boundary: 'edit', delay: 600 },
    { boundary: 'compaction', delay: 0 },
    { boundary: 'compaction', delay: 600 },
    { boundary: 'compaction', delay: 1_400 },
  ])(
    'groups the remaining burst immediately when $boundary arrives after $delay ms',
    async ({ boundary, delay }) => {
      openChat([completeSearch(searchPart())]);
      flushSolid();
      const parts = Array.from({ length: 32 }, (_, index) =>
        completeSearch({
          ...searchPart(),
          id: `search-${index}`,
          callID: `search-call-${index}`,
        })
      );
      (() => parts.forEach(upsertPart))();
      await vi.advanceTimersByTimeAsync(delay);
      flushSolid();
      if (delay === 600) {
        expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(1);
      }

      if (boundary === 'compaction') {
        // Metadata can precede the divider part. It must not reset the active turn.
        setMessagesIncremental([...state.messages, { info: userMessage('compaction'), parts: [] }]);
        flushSolid();
        upsertPart({
          id: 'compaction-part',
          messageID: 'compaction',
          sessionID: 'session-1',
          type: 'compaction',
          auto: true,
          status: 'running',
        });
        flushSolid();
        expect(container?.textContent).toContain('Compacting context');
      } else if (boundary === 'text') {
        upsertPart({ ...textPart('answer-text', 'The queue is ready.'), messageID: 'answer' });
        flushSolid();
      } else {
        upsertPart({
          ...toolPart('patch-streaming', 'answer', 'patch-call'),
          tool: 'patch',
          state: { status: 'pending', input: {}, raw: '' },
        });
        flushSolid();
      }
      flushSolid();

      expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(0);
      expect(container?.textContent).toContain('Explored: 33 searches');
      for (let frame = 0; frame < 200; frame += 1) {
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
        expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(0);
        expect(container?.textContent).toContain('Explored: 33 searches');
      }
    }
  );

  it('groups queued siblings when their disclosure opens and never replays them on collapse', async () => {
    const parts = Array.from({ length: 3 }, (_, index) => ({
      ...searchPart(),
      id: `search-${index}`,
      callID: `search-call-${index}`,
    }));
    openChat([completeSearch(searchPart()), ...parts]);
    flushSolid();
    await vi.advanceTimersByTimeAsync(600);
    flushSolid();
    expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(1);
    (() => parts.forEach((part) => upsertPart(completeSearch(part))))();
    const summary = container!.querySelector<HTMLButtonElement>(
      'button.assistant-activity-summary'
    )!;
    summary.click();
    flushSolid();
    await vi.advanceTimersByTimeAsync(16);
    flushSolid();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('.assistant-active-activity-item')).toHaveLength(0);
    expect(container?.textContent).toContain('4 searches');
    summary.click();
    flushSolid();
    for (let frame = 0; frame < 200; frame += 1) {
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
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
      flushSolid();
      await vi.advanceTimersByTimeAsync(3_000);
      flushSolid();
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
      flushSolid();
      if (splitDelivery) {
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
        upsertPart(noticePart);
        flushSolid();
      }
      flushSolid();
      await vi.advanceTimersByTimeAsync(16);
      flushSolid();
      setMessagesIncremental([
        ...state.messages,
        {
          info: assistantMessage('continuation', { parentID: 'prompt', time: { created: 5 } }),
          parts: [],
        },
      ]);
      flushSolid();
      for (let frame = 0; frame < 150; frame += 1) {
        expect(container?.textContent).toContain(answer);
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
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
      flushSolid();
      await vi.advanceTimersByTimeAsync(3_000);
      flushSolid();
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
      flushSolid();
      for (let frame = 0; frame < 20; frame += 1) {
        expect(container?.textContent).toContain(answer);
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
      }
      expect(container?.textContent).toContain('Compacting context');

      upsertPart({ ...compactionPart, status: 'completed' });
      flushSolid();
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
      flushSolid();
      for (let frame = 0; frame < 150; frame += 1) {
        expect(container?.textContent).toContain(answer);
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
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
      flushSolid();
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
      flushSolid();
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
      flushSolid();
      for (let frame = 0; frame < 150; frame += 1) {
        if (frame === 60) {
          (() => {
            setState(storePath('messages', 1, 'info', 'time', { created: 1, completed: 5 }));
            setStateRecord('sessionStatus', { 'session-1': { type: 'idle' } });
          })();
        }
        expect(container?.textContent).toContain(answer);
        await vi.advanceTimersByTimeAsync(16);
        flushSolid();
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
      flushSolid();
      openChat([completeSearch(searchPart())]);
      flushSolid();
      upsertPart({
        ...toolPart('patch-streaming', 'answer', 'patch-call'),
        tool: 'patch',
        state: { status: 'pending', input: {}, raw: '' },
      });
      flushSolid();
      await vi.advanceTimersByTimeAsync(3_000);
      flushSolid();
      expect(
        container?.querySelector('.tool-status-running'),
        container?.textContent
      ).not.toBeNull();
      expect(container?.textContent).toContain('Editing');
    }
  );

  it('flushes available text when Stop interrupts an activity preview', async () => {
    openChat();
    flushSolid();
    upsertPart(completeSearch(searchPart()));
    flushSolid();
    await vi.advanceTimersByTimeAsync(100);
    flushSolid();
    expect(container?.querySelector('[data-activity-part-id="search"]')).not.toBeNull();
    upsertPart({ ...textPart('answer-text', 'Available before stopping.'), messageID: 'answer' });
    flushSolid();
    expect(container?.textContent).not.toContain('Available before stopping.');
    flushMessagePresentation('session-1');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.textContent).toContain('Available before stopping.');
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
  });

  it('reveals an actionable permission immediately while presentation is queued', async () => {
    openChat();
    flushSolid();
    upsertPart(completeSearch(searchPart()));
    flushSolid();
    upsertPart({ ...textPart('answer-text', 'The command needs approval.'), messageID: 'answer' });
    flushSolid();
    await vi.advanceTimersByTimeAsync(100);
    flushSolid();
    setState(
      storePath('permissions', [
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
      ])
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('.permission-prompt')).not.toBeNull();
    expect(container?.textContent).toContain('The command needs approval.');
    expect(state.permissions).toHaveLength(1);
  });

  it('cancels the old queue during hydration and shows the replacement snapshot immediately', async () => {
    openChat();
    flushSolid();
    upsertPart(completeSearch(searchPart()));
    flushSolid();
    upsertPart({ ...textPart('answer-text', 'Old queued answer.'), messageID: 'answer' });
    flushSolid();
    await vi.advanceTimersByTimeAsync(100);
    flushSolid();
    setState(storePath('messagesLoading', true));
    flushSolid();
    replaceMessages([
      {
        info: assistantMessage('replacement'),
        parts: [{ ...textPart('replacement-text', 'Loaded snapshot.'), messageID: 'replacement' }],
      },
    ]);
    flushSolid();
    setState(storePath('messagesLoading', false));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(container?.textContent).toContain('Loaded snapshot.');
    await vi.advanceTimersByTimeAsync(3_000);
    flushSolid();
    expect(container?.textContent).not.toContain('Old queued answer.');
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
  });

  it('groups a fast completed tool immediately when the answer arrives', async () => {
    openChat();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const search = searchPart();
    upsertPart(search);
    flushSolid();
    await vi.advanceTimersByTimeAsync(40);
    flushSolid();
    (() => {
      upsertPart(completeSearch(search));
      upsertPart({
        ...textPart('answer-text', 'The queue is ready.'),
        messageID: 'answer',
      });
    })();
    await vi.advanceTimersByTimeAsync(100);
    flushSolid();

    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
    expect(container?.textContent).toContain('The queue is ready.');
    expect(state.messages.at(-1)?.parts.at(-1)).toMatchObject({ text: 'The queue is ready.' });

    await vi.advanceTimersByTimeAsync(2_300);
    flushSolid();
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
    flushSolid();
    await vi.advanceTimersByTimeAsync(500);
    flushSolid();
    expect(container?.querySelector('[data-activity-part-id="search"]')).not.toBeNull();

    (() => {
      upsertPart(completeSearch(search));
      upsertPart({
        ...textPart('answer-text', 'A readable handoff.'),
        messageID: 'answer',
      });
      setState(storePath('streamingPartId', 'answer-text'));
      setState(storePath('streamingText', 'A readable handoff.'));
    })();
    await Promise.resolve();
    flushSolid();
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
    expect(container?.textContent).toContain('Explored: 1 search');
    expect(container?.textContent).not.toContain('A readable handoff.');

    await vi.advanceTimersByTimeAsync(32);
    flushSolid();
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
    expect(container?.textContent).toContain('A readable handoff.');
  });

  it('drains a completed text burst without delaying canonical completion', async () => {
    openChat();
    flushSolid();
    await Promise.resolve();
    flushSolid();
    const text = 'Readable streaming words. '.repeat(100);
    (() => {
      upsertPart({ ...textPart('answer-text', text), messageID: 'answer' });
      setState(
        storePath('messages', 1, 'info', {
          ...assistantMessage('answer', { parentID: 'prompt' }),
          time: { created: 1, completed: Date.now() },
        })
      );
      setStateRecord('sessionStatus', { 'session-1': { type: 'idle' } });
    })();
    await Promise.resolve();
    flushSolid();
    expect(state.messages[1]?.info.time).toHaveProperty('completed');
    expect(state.messages[1]?.parts[0]).toMatchObject({ text });
    expect(
      container?.querySelector('[data-msg-id="answer"] .rendered-markdown')?.textContent?.trim()
    ).not.toBe(text.trim());
    await vi.advanceTimersByTimeAsync(350);
    flushSolid();
    expect(
      container?.querySelector('[data-msg-id="answer"] .rendered-markdown')?.textContent?.trim()
    ).toBe(text.trim());
    expect(container?.querySelector('.streaming-markdown-pending')).toBeNull();
  });
});
