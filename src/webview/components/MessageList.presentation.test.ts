import { describe, expect, it, vi } from 'vitest';
import { batch } from 'solid-js';
import { render } from 'solid-js/web';
import { reconcile } from 'solid-js/store';
import { replaceMessages, setState, state, upsertPart } from '../lib/state';
import { flushMessagePresentation } from '../lib/message-list-layout';
import type { ToolPart } from '../types';
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

function openChat(parts: ToolPart[] = []) {
  setState('activeSessionId', 'session-1');
  setState('sessionStatus', reconcile({ 'session-1': { type: 'busy' } }));
  replaceMessages([
    { info: userMessage('prompt'), parts: [textPart('prompt-text', 'Inspect the queue')] },
    { info: assistantMessage('answer', { parentID: 'prompt', time: { created: 1 } }), parts },
  ]);
  cleanup = render(() => MessageList(), container!);
}

describe('streaming presentation handoff', () => {
  it('flushes available text when Stop interrupts an activity preview', async () => {
    openChat();
    upsertPart(completeSearch(searchPart()));
    upsertPart({ ...textPart('answer-text', 'Available before stopping.'), messageID: 'answer' });
    await vi.advanceTimersByTimeAsync(100);
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

  it('gives a fast completed tool a preview before releasing the available answer', async () => {
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

    expect(container?.querySelector('[data-activity-part-id="search"]')).not.toBeNull();
    expect(container?.textContent).not.toContain('The queue is ready.');
    expect(state.messages.at(-1)?.parts.at(-1)).toMatchObject({ text: 'The queue is ready.' });

    await vi.advanceTimersByTimeAsync(2_300);
    expect(container?.querySelector('[data-activity-part-id="search"]')).toBeNull();
    expect(container?.textContent).toContain('Explored: 1 search');
    expect(container?.textContent).toContain('The queue is ready.');
    expect(container?.querySelector('[data-msg-id="answer"]')?.classList).not.toContain(
      'interactive-item-render-empty'
    );
  });

  it('retains an already visible activity when text arrives in the completion batch', async () => {
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
    expect(container?.querySelector('[data-activity-part-id="search"]')).not.toBeNull();
    expect(container?.textContent).not.toContain('A readable handoff.');

    await vi.advanceTimersByTimeAsync(2_400);
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
