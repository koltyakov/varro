import { flush as flushSolid, createSignal } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { MessageEntry } from '../../types';
import type { SessionMessagePage } from '../../lib/client';
import { client } from '../../lib/client';
import {
  getSessionHistoryCursor,
  resetMessageWindowState,
  setSessionHistoryCursor,
} from '../../lib/message-window';
import { assistantMessage, textPart, userMessage } from '../MessageList.test-utils';
import { SessionSearch } from './SessionSearch';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.appendChild(container);
  resetMessageWindowState();
  flushSolid();
});
afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container.remove();
  flushSolid();
  resetMessageWindowState();
  flushSolid();
  vi.useRealTimers();
  vi.restoreAllMocks();
  flushSolid();
});

const entries: MessageEntry[] = [
  { info: userMessage('prompt'), parts: [textPart('prompt-text', 'Find this needle')] },
  {
    info: { ...assistantMessage('response'), time: { created: 2 } },
    parts: [textPart('response-text', 'The NEEDLE is here')],
  },
];

function key(value: string, options: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', {
    key: value,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  target.dispatchEvent(event);
  flushSolid();
  return event;
}
async function search(value: string) {
  const input = container.querySelector<HTMLInputElement>('input')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(121);
  return input;
}
function mount(messages = entries) {
  const onNavigate = vi.fn(async (_id: string) => {});
  const onClose = vi.fn();
  cleanup = render(
    () => (
      <SessionSearch
        sessionId="session-1"
        messages={messages}
        loading={false}
        onNavigate={onNavigate}
        onClose={onClose}
      />
    ),
    container
  );
  return { onNavigate, onClose };
}

describe('SessionSearch', () => {
  it('browses prompts without a query, filters only prompts, and retains the mode on reopen', async () => {
    const { onNavigate } = mount([
      ...entries,
      {
        info: { ...userMessage('new-prompt'), time: { created: 3 } },
        parts: [textPart('new-text', 'A different question')],
      },
    ]);
    flushSolid();
    key('f', { metaKey: true });
    const input = await search('needle');
    flushSolid();
    const toggle = container.querySelector<HTMLButtonElement>('.session-search-prompts-toggle')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    toggle.click();
    flushSolid();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(input.value).toBe('needle');
    expect(document.activeElement).toBe(input);
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('1 matching prompt');
    container.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click();
    flushSolid();
    expect(
      [...container.querySelectorAll('[role="option"]')].map((item) =>
        item.getAttribute('aria-label')
      )
    ).toEqual(['Prompt: A different question', 'Prompt: Find this needle']);
    expect(container.querySelector('mark')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('2 prompts');
    expect(container.querySelector('[aria-label="Assistant responses"]')).toBeNull();
    const options = container.querySelectorAll<HTMLButtonElement>('[role="option"]');
    options[1]!.scrollIntoView = vi.fn();
    key('ArrowDown', {}, input);
    container.querySelector('.session-search-results')!.scrollTop = 45;
    key('Escape');
    key('f', { metaKey: true });
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector('[aria-pressed="true"]')?.textContent).toContain('All prompts');
    expect(container.querySelector('.session-search-results')?.scrollTop).toBe(45);
    expect(container.querySelectorAll('[role="option"]')[1]?.getAttribute('aria-selected')).toBe(
      'true'
    );
    const reopenedInput = container.querySelector<HTMLInputElement>('input')!;
    key('Enter', {}, reopenedInput);
    await Promise.resolve();
    expect(onNavigate).toHaveBeenCalledWith('prompt');
    key('f', { metaKey: true });
    await Promise.resolve();
    flushSolid();
    container.querySelector<HTMLButtonElement>('.session-search-prompts-toggle')!.click();
    flushSolid();
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
    await search('needle');
    flushSolid();
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
  });

  it('loads all historical prompts without changing transcript pagination', async () => {
    setSessionHistoryCursor('session-1', 'older');
    flushSolid();
    const read = vi.spyOn(client.session, 'messages').mockResolvedValue([
      { info: userMessage('old-prompt'), parts: [textPart('old-text', 'An older question')] },
      {
        info: assistantMessage('old-response'),
        parts: [textPart('old-answer', 'An older answer')],
      },
    ]);
    const { onNavigate } = mount();
    flushSolid();
    key('f', { ctrlKey: true });
    expect(read).not.toHaveBeenCalled();
    container.querySelector<HTMLButtonElement>('.session-search-prompts-toggle')!.click();
    flushSolid();
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(read).toHaveBeenCalledOnce();
    expect(getSessionHistoryCursor('session-1')).toBe('older');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('2 prompts');
    const oldPrompt = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (item) => item.textContent?.includes('An older question')
    )!;
    oldPrompt.click();
    flushSolid();
    await Promise.resolve();
    expect(onNavigate).toHaveBeenCalledWith('old-prompt');
    key('f', { ctrlKey: true });
    await Promise.resolve();
    flushSolid();
    expect(read).toHaveBeenCalledOnce();
  });

  it('cancels prompt browsing on close and resets the mode when switching sessions', async () => {
    setSessionHistoryCursor('session-1', 'older');
    flushSolid();
    const read = vi.spyOn(client.session, 'messages').mockImplementation(
      (_id, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const [sessionId, setSessionId] = createSignal('session-1');
    cleanup = render(
      () => (
        <SessionSearch
          sessionId={sessionId()}
          messages={entries}
          loading={false}
          onNavigate={async () => {}}
          onClose={() => {}}
        />
      ),
      container
    );
    flushSolid();
    key('f', { metaKey: true });
    container.querySelector<HTMLButtonElement>('.session-search-prompts-toggle')!.click();
    flushSolid();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Loading history');
    key('Escape');
    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    key('f', { metaKey: true });
    expect(read).toHaveBeenCalledTimes(2);
    setSessionId('session-2');
    flushSolid();
    expect(read.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    key('f', { metaKey: true });
    expect(
      container.querySelector('.session-search-prompts-toggle')?.getAttribute('aria-pressed')
    ).toBe('false');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])(
    'opens with find, selects results, and restores focus on Escape with %o',
    async (modifier) => {
      const { onNavigate, onClose } = mount();
      flushSolid();
      const composer = document.createElement('textarea');
      document.body.insertBefore(composer, container);
      composer.focus();
      flushSolid();
      expect(key('f', modifier).defaultPrevented).toBe(true);
      await Promise.resolve();
      flushSolid();
      const input = await search('needle');
      flushSolid();
      expect(document.activeElement).toBe(input);
      const results = container.querySelectorAll<HTMLButtonElement>('.session-search-result');
      expect(results).toHaveLength(2);
      expect(results[0]?.getAttribute('aria-label')).toBe('Prompt: Find this needle');
      expect(results[1]?.getAttribute('aria-label')).toBe('Response: The NEEDLE is here');
      expect(container.querySelector('.session-search-role')).toBeNull();
      expect(
        container
          .querySelector('[role="group"][aria-label="Your prompts"]')
          ?.querySelectorAll('[role="option"]')
      ).toHaveLength(1);
      expect(
        container
          .querySelector('[role="group"][aria-label="Assistant responses"]')
          ?.querySelectorAll('[role="option"]')
      ).toHaveLength(1);
      expect(results[0]?.querySelector('mark')?.textContent).toBe('needle');
      expect(results[0]?.classList.contains('is-prompt')).toBe(true);
      expect(results[1]?.classList.contains('is-prompt')).toBe(false);
      expect(
        [...container.querySelectorAll('.session-search-group')].map((group) => group.textContent)
      ).toEqual(['Your prompts1', 'Assistant responses1']);
      results[0]!.click();
      flushSolid();
      await Promise.resolve();
      expect(onNavigate).toHaveBeenLastCalledWith('prompt');
      expect(container.querySelector('.session-search')).toBeNull();
      expect(onClose).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(composer);
      key('f', modifier);
      await Promise.resolve();
      flushSolid();
      const reopened = container.querySelector<HTMLInputElement>('input')!;
      expect(reopened.value).toBe('needle');
      const reopenedResults =
        container.querySelectorAll<HTMLButtonElement>('.session-search-result');
      expect(reopenedResults).toHaveLength(2);
      reopenedResults[1]!.scrollIntoView = vi.fn();
      key('ArrowDown', {}, reopened);
      key('Enter', {}, reopened);
      await Promise.resolve();
      expect(onNavigate).toHaveBeenLastCalledWith('response');
      expect(container.querySelector('.session-search')).toBeNull();
      key('f', modifier);
      await Promise.resolve();
      flushSolid();
      expect(key('Escape').defaultPrevented).toBe(true);
      expect(container.querySelector('.session-search')).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(3);
      expect(document.activeElement).toBe(composer);
      composer.remove();
      flushSolid();
    }
  );

  it('reads older pages without changing transcript history state and reuses text for another query', async () => {
    setSessionHistoryCursor('session-1', 'page-1');
    flushSolid();
    const first: SessionMessagePage = [
      { info: userMessage('old-prompt'), parts: [textPart('old-text', 'Older needle')] },
    ];
    first.nextCursor = 'page-2';
    const read = vi
      .spyOn(client.session, 'messages')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([
        {
          info: assistantMessage('old-answer'),
          parts: [textPart('old-answer-text', 'Ancient answer')],
        },
      ]);
    mount();
    flushSolid();
    key('f', { metaKey: true });
    expect(read).not.toHaveBeenCalled();
    await search('needle');
    flushSolid();
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[0]?.[1]).toMatchObject({ before: 'page-1', limit: 200 });
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(3);
    expect(getSessionHistoryCursor('session-1')).toBe('page-1');
    await search('ancient');
    flushSolid();
    expect(read).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.session-search-result')?.textContent).toContain(
      'Ancient answer'
    );
    key('Escape');
    key('f', { metaKey: true });
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('ancient');
    expect(container.querySelector('.session-search-result')?.textContent).toContain(
      'Ancient answer'
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('aborts and discards stale history when the session changes', async () => {
    setSessionHistoryCursor('session-1', 'older');
    flushSolid();
    let complete: (page: SessionMessagePage) => void = () => {};
    const read = vi.spyOn(client.session, 'messages').mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const [sessionId, setSessionId] = createSignal<string | null>('session-1');
    cleanup = render(
      () => (
        <SessionSearch
          sessionId={sessionId()}
          messages={entries}
          loading={false}
          onNavigate={async () => {}}
          onClose={() => {}}
        />
      ),
      container
    );
    flushSolid();
    key('f', { ctrlKey: true });
    await search('needle');
    flushSolid();
    const signal = read.mock.calls[0]?.[1]?.signal;
    setSessionId('session-2');
    flushSolid();
    expect(signal?.aborted).toBe(true);
    complete([{ info: userMessage('stale'), parts: [textPart('stale-text', 'stale needle')] }]);
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector('.session-search')).toBeNull();
    key('f', { ctrlKey: true });
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('');
    await search('needle');
    flushSolid();
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(0);
  });

  it('cancels reads on close and leaves no global shortcut handler after disposal', async () => {
    setSessionHistoryCursor('session-1', 'older');
    flushSolid();
    const read = vi.spyOn(client.session, 'messages').mockImplementation(
      (_id, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    mount();
    flushSolid();
    key('f', { ctrlKey: true });
    await search('needle');
    flushSolid();
    key('Escape');
    expect(read.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    cleanup?.();
    flushSolid();
    cleanup = undefined;
    expect(key('f', { ctrlKey: true }).defaultPrevented).toBe(false);
  });

  it('retains partial history and resumes the unread page when reopened', async () => {
    setSessionHistoryCursor('session-1', 'page-1');
    flushSolid();
    const first: SessionMessagePage = [
      { info: userMessage('old-prompt'), parts: [textPart('old-text', 'Older needle')] },
    ];
    first.nextCursor = 'page-2';
    const read = vi
      .spyOn(client.session, 'messages')
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(
        (_id, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      )
      .mockResolvedValueOnce([
        {
          info: assistantMessage('old-response'),
          parts: [textPart('old-answer-text', 'Ancient needle')],
        },
      ]);
    mount();
    flushSolid();
    key('f', { metaKey: true });
    await search('needle');
    flushSolid();
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(3);
    key('Escape');
    key('f', { metaKey: true });
    await vi.advanceTimersByTimeAsync(1);
    flushSolid();
    expect(read.mock.calls.map(([, options]) => options?.before)).toEqual([
      'page-1',
      'page-2',
      'page-2',
    ]);
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(4);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('keeps loaded matches visible when history fails and detects repeated cursors', async () => {
    setSessionHistoryCursor('session-1', 'repeat');
    flushSolid();
    const page: SessionMessagePage = [];
    page.nextCursor = 'repeat';
    const read = vi.spyOn(client.session, 'messages').mockResolvedValue(page);
    mount();
    flushSolid();
    key('f', { ctrlKey: true });
    await search('needle');
    flushSolid();
    expect(read).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'History search incomplete'
    );
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(2);
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain(
      'Searching history'
    );
  });

  it('updates matches when loaded text is edited or streamed', async () => {
    const [messages, setMessages] = createSignal(entries);
    cleanup = render(
      () => (
        <SessionSearch
          sessionId="session-1"
          messages={messages()}
          loading={false}
          onNavigate={async () => {}}
          onClose={() => {}}
        />
      ),
      container
    );
    flushSolid();
    key('f', { ctrlKey: true });
    await search('needle');
    flushSolid();
    setMessages([
      { info: assistantMessage('response'), parts: [textPart('changed-text', 'Changed answer')] },
    ]);
    flushSolid();
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(0);
    setMessages([
      { info: assistantMessage('response'), parts: [textPart('changed-text', 'Streaming needle')] },
    ]);
    flushSolid();
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(1);
  });

  it('reports read failures as partial results and clears errors with the query', async () => {
    setSessionHistoryCursor('session-1', 'older');
    flushSolid();
    vi.spyOn(client.session, 'messages').mockRejectedValue(new Error('History is unavailable'));
    mount();
    flushSolid();
    key('f', { metaKey: true });
    await search('needle');
    flushSolid();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'History is unavailable'
    );
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(2);
    await search('');
    flushSolid();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not claim find without an open session or with other shortcut modifiers', () => {
    const [sessionId, setSessionId] = createSignal<string | null>(null);
    cleanup = render(
      () => (
        <SessionSearch
          sessionId={sessionId()}
          messages={entries}
          loading={false}
          onNavigate={async () => {}}
          onClose={() => {}}
        />
      ),
      container
    );
    flushSolid();
    expect(key('f', { metaKey: true }).defaultPrevented).toBe(false);
    setSessionId('session-1');
    flushSolid();
    expect(key('f', { metaKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    expect(key('f', { metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
    expect(container.querySelector('.session-search')).toBeNull();
  });

  it.each(['search', 'all prompts'])(
    'allows access beyond the initial result page in %s',
    async (mode) => {
      mount(
        Array.from({ length: 205 }, (_, index) => ({
          info: userMessage(`prompt-${index}`),
          parts: [textPart(`text-${index}`, `needle ${index}`)],
        }))
      );
      flushSolid();
      key('f', { metaKey: true });
      if (mode === 'search') await search('needle');
      else container.querySelector<HTMLButtonElement>('.session-search-prompts-toggle')!.click();
      flushSolid();
      expect(container.querySelectorAll('.session-search-result')).toHaveLength(200);
      const more = [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'Show more results'
      );
      more!.click();
      flushSolid();
      expect(container.querySelectorAll('.session-search-result')).toHaveLength(205);
    }
  );

  it('dismisses on outside pointer input without stealing focus and retains the search', async () => {
    const { onClose, onNavigate } = mount();
    flushSolid();
    key('f', { metaKey: true });
    const input = await search('needle');
    flushSolid();
    input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    flushSolid();
    expect(container.querySelector('.session-search')).not.toBeNull();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    flushSolid();
    outside.focus();
    flushSolid();
    expect(container.querySelector('.session-search')).toBeNull();
    expect(document.activeElement).toBe(outside);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
    key('f', { metaKey: true });
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('needle');
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(2);
    outside.remove();
    flushSolid();
  });

  it('ranks all prompts before newer responses and keeps newest prompts first', async () => {
    mount([
      ...entries,
      {
        info: { ...userMessage('newer-prompt'), time: { created: 3 } },
        parts: [textPart('newer-text', 'Another needle')],
      },
    ]);
    flushSolid();
    key('f', { metaKey: true });
    await search('needle');
    flushSolid();
    expect(
      [...container.querySelectorAll('.session-search-snippet')].map(
        (snippet) => snippet.textContent
      )
    ).toEqual(['Another needle', 'Find this needle', 'The NEEDLE is here']);
  });

  it('restores the selected result, result page, and scroll position when reopened', async () => {
    mount(
      Array.from({ length: 205 }, (_, index) => ({
        info: userMessage(`prompt-${index}`),
        parts: [textPart(`text-${index}`, `needle ${index}`)],
      }))
    );
    flushSolid();
    key('f', { metaKey: true });
    const input = await search('needle');
    flushSolid();
    [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Show more results')!
      .click();
    flushSolid();
    const options = container.querySelectorAll<HTMLButtonElement>('.session-search-result');
    options[1]!.scrollIntoView = vi.fn();
    key('ArrowDown', {}, input);
    container.querySelector('.session-search-results')!.scrollTop = 240;
    key('Escape');
    key('f', { metaKey: true });
    await Promise.resolve();
    flushSolid();
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(205);
    expect(container.querySelector('.session-search-results')?.scrollTop).toBe(240);
    expect(
      container.querySelectorAll('.session-search-result')[1]?.getAttribute('aria-selected')
    ).toBe('true');
  });

  it('closes before navigation starts and reopens with an actionable error on failure', async () => {
    const { onNavigate } = mount();
    flushSolid();
    onNavigate.mockImplementation(async () => {
      expect(container.querySelector('.session-search')).toBeNull();
      throw new Error('Could not load this message. Try again.');
    });
    key('f', { metaKey: true });
    await search('needle');
    flushSolid();
    container.querySelector<HTMLButtonElement>('.session-search-result')!.click();
    flushSolid();
    await Promise.resolve();
    await Promise.resolve();
    flushSolid();
    expect(container.querySelector('.session-search')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load this message'
    );
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('needle');
  });

  it('uses the sessions-search clear control without closing the panel', async () => {
    const { onClose } = mount();
    flushSolid();
    key('f', { metaKey: true });
    const input = await search('needle');
    flushSolid();
    expect(input.type).toBe('text');
    expect(container.querySelector('[aria-label="Close session search"]')).toBeNull();
    const clear = container.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!;
    expect(clear.classList.contains('session-list-search-clear')).toBe(true);
    expect(clear.querySelector('.session-list-search-clear-icon')).not.toBeNull();
    clear.click();
    flushSolid();
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(container.querySelectorAll('.session-search-result')).toHaveLength(0);
    expect(container.querySelector('[aria-label="Clear search"]')).toBeNull();
    expect(container.querySelector('.session-search')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    key('Escape');
    expect(container.querySelector('.session-search')).toBeNull();
  });

  it('uses one selection for pointer and keyboard navigation without stationary-pointer retargeting', async () => {
    const { onNavigate } = mount([
      ...entries,
      {
        info: { ...assistantMessage('new-response'), time: { created: 3 } },
        parts: [textPart('new-response-text', 'Another needle')],
      },
    ]);
    flushSolid();
    key('f', { metaKey: true });
    const input = await search('needle');
    flushSolid();
    const options = container.querySelectorAll<HTMLButtonElement>('.session-search-result');
    const move = (x: number) =>
      options[2]!.dispatchEvent(
        new MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: 100 })
      );
    move(40);
    flushSolid();
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[2]?.id);
    options[1]!.scrollIntoView = vi.fn();
    key('ArrowUp', {}, input);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(options[2]?.getAttribute('aria-selected')).toBe('false');
    move(40);
    flushSolid();
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    move(41);
    flushSolid();
    expect(options[2]?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelectorAll('[role="option"][aria-selected="true"]')).toHaveLength(1);
    key('Enter', {}, input);
    await Promise.resolve();
    expect(onNavigate).toHaveBeenCalledWith('response');
  });
});
