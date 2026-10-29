import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import * as bridge from '../lib/bridge';
import * as clipboard from '../lib/write-clipboard';
import * as feedback from './chat/SessionActionFeedback';
import {
  error,
  inputText,
  isLoading,
  resetDefaultAppState,
  setInputText,
  setIsLoading,
  setState,
  state,
} from '../lib/state';
import { closeSideQuestion } from '../lib/side-question';
import { flushInputDraft } from '../lib/input-draft-persistence';
import type { Session } from '../types';
import { fixture } from '../test-fixtures';
import { SideQuestionDialog } from './SideQuestionDialog';

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function mount(question = '', context?: string) {
  const onClose = vi.fn(() => {
    cleanup?.();
    cleanup = undefined;
  });
  cleanup = render(
    () => (
      <SideQuestionDialog
        sessionID="ses_side"
        directory="/repo"
        question={question}
        context={context}
        onClose={onClose}
      />
    ),
    container
  );
  return onClose;
}

function dialog() {
  return document.querySelector<HTMLElement>('.side-question-dialog')!;
}

function button(text: string) {
  const element = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (entry) => entry.textContent === text || entry.getAttribute('aria-label') === text
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

function edit(text: string) {
  const input = dialog().querySelector<HTMLDivElement>('.rich-composer')!;
  input.textContent = text;
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  return input;
}

function paste(input: HTMLElement, text: string, source: 'text' | 'image-items' | 'image-files') {
  const getAsFile = vi.fn(() => new File([], 'pasted.png', { type: 'image/png' }));
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: source === 'image-items' ? [{ kind: 'file', type: 'image/png', getAsFile }] : [],
      files: source === 'image-files' ? [new File([], 'pasted.png', { type: 'image/png' })] : [],
      getData: (type: string) => (type === 'text/plain' ? text : ''),
    },
  });
  input.dispatchEvent(event);
  return { event, getAsFile };
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  resetDefaultAppState();
  setIsLoading(false);
  setState('sessions', [
    fixture<Session>({
      id: 'ses_side',
      directory: '/repo',
      title: 'Fix migration',
      time: { created: 1, updated: 2 },
    }),
  ]);
  setState('activeSessionId', 'ses_side');
  setState('serverStatus', { state: 'running', apiVersion: 2, url: 'http://localhost:4096' });
  setInputText('Unsent task draft');
  container = document.createElement('div');
  document.body.append(container);
  vi.spyOn(bridge, 'apiCall').mockResolvedValue({ text: '**Because** the default was missing.' });
  vi.spyOn(clipboard, 'writeClipboard').mockResolvedValue(true);
  vi.spyOn(feedback, 'showSessionActionFeedback').mockImplementation(() => {});
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  closeSideQuestion();
  flushInputDraft();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SideQuestionDialog', () => {
  it('opens answer citations in the modal session even when another session is active', async () => {
    vi.mocked(bridge.apiCall).mockResolvedValue({ text: '`models/file.py:710-744`' });
    const open = vi.spyOn(bridge, 'openPathWithResult').mockResolvedValue('opened');
    mount('Where is the implementation?');
    await settle();
    button('Send (Enter)').click();
    await settle();
    setState('activeSessionId', 'another-session');
    setState('editorContext', 'workspacePath', '/other');
    dialog().querySelector<HTMLAnchorElement>('a.file-path-link')!.click();
    expect(open).toHaveBeenCalledWith({
      path: 'models/file.py',
      line: 710,
      endLine: 744,
      kind: 'file',
      sessionID: 'ses_side',
      directory: '/repo',
    });
  });

  it('sends successive questions without creating unowned computations', async () => {
    const warn = vi.spyOn(console, 'warn');
    mount();
    await settle();
    for (const question of ['First question', 'Second question', 'Third question']) {
      expect(button('Send (Enter)').disabled).toBe(true);
      edit(question);
      expect(button('Send (Enter)').disabled).toBe(false);
      button('Send (Enter)').click();
      await settle();
    }
    expect(bridge.apiCall).toHaveBeenCalledTimes(3);
    expect(dialog().querySelectorAll('.side-question-answer')).toHaveLength(3);
    button('Close side question').click();
    expect(document.querySelector('.side-question-dialog')).toBeNull();
    expect(warn).not.toHaveBeenCalledWith(
      'computations created outside a `createRoot` or `render` will never be disposed'
    );
  });

  it('sends captured context once and renders the usual attachment chips in the bubble', async () => {
    const context = '[Attached file: src/file.ts]\n\n[Selection from src/other.ts lines 2-4]';
    mount('Explain these', context);
    await settle();
    expect(vi.mocked(bridge.apiCall).mock.calls[0]![2]).toEqual({
      question: `Explain these\n\n${context}`,
    });
    expect(dialog().querySelector('.message-attachment-chip')).not.toBeNull();
    expect(dialog().querySelector('.side-question-question')?.textContent).toContain('file.ts');
    edit('And why?');
    button('Send (Enter)').click();
    await settle();
    expect(vi.mocked(bridge.apiCall).mock.calls[1]![2]).toEqual({
      question: 'And why?',
      history: [
        { question: `Explain these\n\n${context}`, answer: '**Because** the default was missing.' },
      ],
    });
  });

  it('keeps context on retry without inserting serialized attachment blocks into the editor', async () => {
    vi.mocked(bridge.apiCall).mockRejectedValueOnce(new Error('Provider unavailable'));
    mount('Explain', '[Attached file: src/file.ts]');
    await settle();
    expect(dialog().querySelector('.rich-composer')?.textContent).toBe('Explain');
    button('Retry').click();
    await settle();
    expect(vi.mocked(bridge.apiCall).mock.calls[1]![2]).toEqual({
      question: 'Explain\n\n[Attached file: src/file.ts]',
    });
  });

  it('blocks unsupported inline skills in follow-ups instead of sending them as plain text', async () => {
    mount('First');
    await settle();
    edit('$[docs] Explain');
    expect(button('Send (Enter)').disabled).toBe(true);
    dialog()
      .querySelector('.rich-composer')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    await settle();
    expect(bridge.apiCall).toHaveBeenCalledTimes(1);
    expect(feedback.showSessionActionFeedback).toHaveBeenCalledWith(
      'Side questions cannot use skills',
      'warning',
      expect.any(HTMLElement)
    );
  });
  it.each(['image-items', 'image-files'] as const)(
    'warns on %s paste without reading images, losing drafts, or changing main attachments',
    async (source) => {
      mount();
      await settle();
      const input = edit('Keep this side draft');
      const attachments = state.clipboardImages;
      const documentPaste = vi.fn();
      document.addEventListener('paste', documentPaste);
      try {
        const { event, getAsFile } = paste(input, '', source);
        await settle();
        expect(event.defaultPrevented).toBe(true);
        expect(getAsFile).not.toHaveBeenCalled();
        expect(documentPaste).not.toHaveBeenCalled();
        expect(feedback.showSessionActionFeedback).toHaveBeenCalledExactlyOnceWith(
          'Side questions support text only',
          'warning',
          input.closest('.chat-input-container')
        );
        expect(input.textContent).toBe('Keep this side draft');
        expect(input.querySelector('img')).toBeNull();
        expect(state.clipboardImages).toBe(attachments);
        expect(inputText()).toBe('Unsent task draft');
        expect(bridge.apiCall).not.toHaveBeenCalled();
        expect(dialog().querySelector('[role="alert"]')).toBeNull();
      } finally {
        document.removeEventListener('paste', documentPaste);
      }
    }
  );

  it('warns for a mixed image/text paste but preserves and sends only the text', async () => {
    mount();
    await settle();
    const input = edit('Question: ');
    const { getAsFile } = paste(input, 'keep this text', 'image-items');
    await settle();
    expect(input.textContent).toBe('Question: keep this text');
    expect(getAsFile).not.toHaveBeenCalled();
    expect(feedback.showSessionActionFeedback).toHaveBeenCalledOnce();
    expect(state.clipboardImages).toEqual([]);
    expect(bridge.apiCall).not.toHaveBeenCalled();
    button('Send (Enter)').click();
    await settle();
    expect(vi.mocked(bridge.apiCall).mock.calls[0]![2]).toEqual({
      question: 'Question: keep this text',
    });
    expect(inputText()).toBe('Unsent task draft');
  });

  it('pastes ordinary text without a warning', async () => {
    mount();
    await settle();
    const input = edit('Question: ');
    paste(input, 'plain text', 'text');
    await settle();
    expect(input.textContent).toBe('Question: plain text');
    expect(feedback.showSessionActionFeedback).not.toHaveBeenCalled();
  });

  it("shows each answer's response time without sending timing metadata in follow-up history", async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    let complete!: (value: { text: string }) => void;
    vi.mocked(bridge.apiCall).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    mount('First question');
    await settle();
    expect(dialog().querySelector('.side-question-response-time')).toBeNull();
    now = 3_400;
    complete({ text: 'First answer' });
    await settle();
    expect(dialog().querySelector('.side-question-response-time')?.textContent).toBe('2s');
    expect(dialog().querySelector('.side-question-response-time')?.getAttribute('aria-label')).toBe(
      'Response time: 2s'
    );

    now = 10_000;
    edit('Second question');
    button('Send (Enter)').click();
    await settle();
    expect(vi.mocked(bridge.apiCall).mock.calls[1]![2]).toEqual({
      question: 'Second question',
      history: [{ question: 'First question', answer: 'First answer' }],
    });
    now = 10_250;
    complete({ text: 'Second answer' });
    await settle();
    expect(
      [...dialog().querySelectorAll('.side-question-response-time')].map(
        (element) => element.textContent
      )
    ).toEqual(['2s', '250ms']);
  });

  it('puts Copy below the answer in a divider row without an extra composer toolbar and preserves the main task', async () => {
    const messages = state.messages;
    mount('Why did the migration fail?');
    await settle();
    expect(bridge.apiCall).toHaveBeenCalledExactlyOnceWith(
      'POST',
      '/session/ses_side/side-question?directory=%2Frepo',
      { question: 'Why did the migration fail?' },
      expect.objectContaining({ signal: expect.any(AbortSignal), retries: 0 })
    );
    expect(dialog().querySelector('strong')?.textContent).toBe('Because');
    expect(
      dialog().querySelector('.side-question-question .user-message-card')?.textContent
    ).toContain('Why did the migration fail?');
    expect(dialog().querySelector('.side-question-role')).toBeNull();
    expect(dialog().querySelector('textarea')).toBeNull();
    expect(dialog().querySelector('.user-message-card-editable')).toBeNull();
    expect(dialog().textContent).not.toContain("isn't saved");
    expect(dialog().textContent).not.toContain("Won't add to history");
    const answer = dialog().querySelector('.side-question-answer')!;
    expect(answer.firstElementChild?.classList.contains('chat-turn-content')).toBe(true);
    expect(answer.firstElementChild?.querySelector('.rendered-markdown')).not.toBeNull();
    expect(answer.lastElementChild?.classList.contains('side-question-answer-actions')).toBe(true);
    const copy = answer.querySelector<HTMLButtonElement>(
      '.assistant-dialog-summary-turn-actions [aria-label="Copy answer"]'
    )!;
    copy.click();
    await settle();
    expect(clipboard.writeClipboard).toHaveBeenCalledWith('**Because** the default was missing.');
    expect(copy.getAttribute('aria-label')).toBe('Answer copied');
    expect(copy.classList.contains('assistant-dialog-summary-copy')).toBe(true);
    expect(
      dialog().querySelector('.side-question-close')?.classList.contains('provider-connect-close')
    ).toBe(true);
    expect(dialog().querySelector('.chat-input-toolbars')).toBeNull();
    expect(dialog().querySelector('.interactive-request .user-message-card')).not.toBeNull();
    expect(
      dialog().querySelector('.side-question-composer-actions [aria-label="Send (Enter)"]')
    ).not.toBeNull();
    expect(dialog().querySelector('[aria-label="Follow-up question"]')).not.toBeNull();
    expect(inputText()).toBe('Unsent task draft');
    expect(state.messages).toBe(messages);
    expect(state.queuedMessages).toEqual([]);
    expect(isLoading()).toBe(false);
    expect(error()).toBeNull();
  });

  it('opens an empty form without generating and restores focus on close', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = mount();
    await settle();
    expect(document.activeElement).toBe(dialog().querySelector('.rich-composer'));
    expect(bridge.apiCall).not.toHaveBeenCalled();
    expect(button('Send (Enter)').disabled).toBe(true);
    const emptyState = dialog().querySelector('.side-question-empty-state')!;
    expect(emptyState.textContent).toContain('Ask anything about this session.');
    expect(emptyState.querySelectorAll('p')).toHaveLength(1);
    expect(emptyState.querySelector('img.chat-empty-logo')?.getAttribute('src')).toBeTruthy();
    expect(emptyState.querySelector('img')?.getAttribute('aria-hidden')).toBe('true');
    expect(emptyState.querySelector('.chat-empty-logo-waves')).not.toBeNull();
    dialog().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(opener);
    opener.remove();
    expect(inputText()).toBe('Unsent task draft');
  });

  it('keeps the welcome while drafting and removes it as soon as the first question is sent', async () => {
    let complete!: (answer: { text: string }) => void;
    vi.mocked(bridge.apiCall).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    mount();
    await settle();
    edit('Why did that fail?');
    expect(dialog().querySelector('.side-question-empty-state')).not.toBeNull();
    button('Send (Enter)').click();
    await settle();
    expect(dialog().querySelector('.side-question-empty-state')).toBeNull();
    expect(dialog().querySelector('[role="status"]')).not.toBeNull();
    complete({ text: 'Because of the missing default.' });
    await settle();
    expect(dialog().querySelector('.side-question-empty-state')).toBeNull();
    expect(dialog().querySelector('[aria-label="Follow-up question"]')).not.toBeNull();
  });

  it('retains the measured welcome height while waiting and after receiving an answer', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.classList.contains('side-question-dialog')
        ? new DOMRect(0, 0, 640, 372)
        : new DOMRect();
    });
    let complete!: (answer: { text: string }) => void;
    vi.mocked(bridge.apiCall).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    mount();
    await settle();
    edit('Why?');
    button('Send (Enter)').click();
    await settle();
    expect(dialog().style.getPropertyValue('--side-question-min-height')).toBe('372px');
    expect(dialog().querySelector('.chat-empty-logo-waves')).toBeNull();
    complete({ text: 'Because.' });
    await settle();
    expect(dialog().style.getPropertyValue('--side-question-min-height')).toBe('372px');
  });

  it('retains the question and offers Retry after a request error without a chat-wide error', async () => {
    vi.mocked(bridge.apiCall).mockRejectedValueOnce(new Error('Provider unavailable'));
    mount('Why?');
    await settle();
    expect(dialog().querySelector('.rich-composer')?.textContent).toBe('Why?');
    expect(document.activeElement).toBe(dialog().querySelector('.rich-composer'));
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Provider unavailable');
    expect(dialog().querySelector('.side-question-empty-state')).toBeNull();
    expect(error()).toBeNull();
    button('Retry').click();
    await settle();
    expect(bridge.apiCall).toHaveBeenCalledTimes(2);
    expect(dialog().querySelector('strong')?.textContent).toBe('Because');
  });

  it('asks while the main task is busy without changing its state', async () => {
    setState('sessionStatus', 'ses_side', { type: 'busy' });
    mount();
    const input = edit('Why?');
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await settle();
    expect(bridge.apiCall).toHaveBeenCalledTimes(1);
    expect(dialog().querySelector('.side-question-answer')?.textContent).toContain('Because');
    expect(state.sessionStatus.ses_side).toEqual({ type: 'busy' });
    expect(state.queuedMessages).toEqual([]);
  });

  it('cancels the request on close and ignores a late answer without task interruption', async () => {
    let complete!: (value: { text: string }) => void;
    vi.mocked(bridge.apiCall).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    mount('Why?');
    await settle();
    const signal = vi.mocked(bridge.apiCall).mock.calls[0]![3]!.signal!;
    dialog().querySelector<HTMLButtonElement>('[aria-label="Close side question"]')!.click();
    expect(signal.aborted).toBe(true);
    complete({ text: 'Late answer' });
    await settle();
    expect(document.querySelector('.side-question-dialog')).toBeNull();
    expect(bridge.apiCall).toHaveBeenCalledTimes(1);
    expect(inputText()).toBe('Unsent task draft');
  });

  it('keeps a side request running when the main task becomes busy', async () => {
    vi.mocked(bridge.apiCall).mockImplementation(() => new Promise(() => {}));
    mount('Why?');
    await settle();
    const signal = vi.mocked(bridge.apiCall).mock.calls[0]![3]!.signal!;
    setState('sessionStatus', 'ses_side', { type: 'busy' });
    await settle();
    expect(signal.aborted).toBe(false);
    expect(dialog().querySelector('[role="status"]')).not.toBeNull();
    expect(state.sessionStatus.ses_side).toEqual({ type: 'busy' });
    expect(bridge.apiCall).toHaveBeenCalledTimes(1);
  });

  it('keeps an admitted context snapshot independent of later main-draft changes', async () => {
    vi.mocked(bridge.apiCall).mockImplementation(() => new Promise(() => {}));
    mount('Explain', '[Attached file: src/file.ts]');
    await settle();
    const signal = vi.mocked(bridge.apiCall).mock.calls[0]![3]!.signal!;
    setInputText('$[docs] A different main draft');
    await settle();
    expect(signal.aborted).toBe(false);
    expect(dialog().querySelector('[role="status"]')).not.toBeNull();
    expect(vi.mocked(bridge.apiCall).mock.calls[0]![2]).toEqual({
      question: 'Explain\n\n[Attached file: src/file.ts]',
    });
  });

  it('keeps a local question/answer thread and includes it in follow-ups without changing main history', async () => {
    const messages = state.messages;
    mount('What is the retry budget?');
    await settle();
    const input = dialog().querySelector<HTMLDivElement>('[aria-label="Follow-up question"]')!;
    expect(document.activeElement).toBe(input);
    edit('Why that number?');
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    await settle();
    expect(bridge.apiCall).toHaveBeenNthCalledWith(
      2,
      'POST',
      expect.stringContaining('/side-question'),
      {
        question: 'Why that number?',
        history: [
          { question: 'What is the retry budget?', answer: '**Because** the default was missing.' },
        ],
      },
      expect.anything()
    );
    expect(dialog().querySelectorAll('.side-question-turn')).toHaveLength(2);
    expect(dialog().querySelectorAll('.side-question-question')[1]?.textContent).toContain(
      'Why that number?'
    );
    expect(state.messages).toBe(messages);
    expect(inputText()).toBe('Unsent task draft');
  });

  it('preserves a follow-up being typed while a later answer is pending', async () => {
    let complete!: (value: { text: string }) => void;
    vi.mocked(bridge.apiCall)
      .mockResolvedValueOnce({ text: 'First answer' })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      );
    mount('First question');
    await settle();
    edit('Second question');
    button('Send (Enter)').click();
    await settle();
    const input = edit('Keep this next question');
    complete({ text: 'Second answer' });
    await settle();
    expect(input.textContent).toBe('Keep this next question');
    expect(dialog().querySelectorAll('.side-question-turn')).toHaveLength(2);
  });

  it('shows only the first question and Thinking while pending, with Close focused and no composer or Stop', async () => {
    vi.mocked(bridge.apiCall).mockImplementation(() => new Promise(() => {}));
    mount('Why?');
    await settle();
    expect(
      dialog().querySelector('[role="status"] .shimmer-progress.loading-verb')?.textContent
    ).toBe('Thinking');
    expect(dialog().querySelector('[role="status"] .chat-animated-ellipsis')).not.toBeNull();
    expect(dialog().querySelector('.user-message-card')?.textContent).toContain('Why?');
    expect(dialog().querySelector('.side-question-composer')).toBeNull();
    expect(dialog().querySelector('.rich-composer')).toBeNull();
    expect(dialog().querySelector('[aria-label="Stop"]')).toBeNull();
    expect(document.activeElement).toBe(button('Close side question'));
    expect(isLoading()).toBe(false);
  });

  it('stops only the side request, preserves the next draft, and ignores a late answer', async () => {
    let complete!: (value: { text: string }) => void;
    vi.mocked(bridge.apiCall)
      .mockResolvedValueOnce({ text: 'First answer' })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      );
    mount('First question');
    await settle();
    edit('Second question');
    button('Send (Enter)').click();
    await settle();
    const signal = vi.mocked(bridge.apiCall).mock.calls[1]![3]!.signal!;
    edit('Next draft');
    button('Stop').click();
    await settle();
    expect(signal.aborted).toBe(true);
    expect(dialog().querySelector('[role="status"]')).toBeNull();
    expect(dialog().querySelector('.rich-composer')?.textContent).toBe('Next draft');
    complete({ text: 'Late answer' });
    await settle();
    expect(dialog().querySelectorAll('.side-question-answer')).toHaveLength(1);
    expect(inputText()).toBe('Unsent task draft');
    expect(bridge.apiCall).toHaveBeenCalledTimes(2);
    expect(isLoading()).toBe(false);
  });

  it('reuses composer undo and redo without touching the main draft', async () => {
    mount();
    await settle();
    const input = edit('First edit');
    edit('Second replacement');
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    );
    await settle();
    expect(input.textContent).toBe('First edit');
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    await settle();
    expect(input.textContent).toBe('Second replacement');
    expect(inputText()).toBe('Unsent task draft');
  });
});
