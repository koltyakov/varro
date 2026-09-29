import { describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { replaceMessages, setState } from '../lib/state';
import type { Session } from '../types';
import { MessageList } from './MessageList';
import {
  assistantMessage,
  installMessageListTestEnvironment,
  session,
  textPart,
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
  setCleanup: (nextCleanup) => {
    cleanup = nextCleanup;
  },
});

async function renderTranscript() {
  setState('activeSessionId', 'session-1');
  setState('serverStatus', { state: 'running', url: 'mock://opencode', apiVersion: 2 });
  setState('sessions', [session('session-1')]);
  replaceMessages([
    { info: userMessage('prompt-1'), parts: [textPart('prompt-1-text', 'First prompt')] },
    { info: assistantMessage('assistant-1'), parts: [textPart('reply-1', 'First reply')] },
    { info: userMessage('prompt-2'), parts: [textPart('prompt-2-text', 'Second prompt')] },
    { info: assistantMessage('assistant-2'), parts: [textPart('reply-2', 'Second reply')] },
  ]);
  cleanup = render(() => MessageList(), container!);
  await Promise.resolve();
}

describe('MessageList hide AI responses', () => {
  it('shows assistant responses by default and hides them after toggling', async () => {
    await renderTranscript();

    const assistantRowsBefore = container?.querySelectorAll(
      '[data-msg-id="assistant-1"], [data-msg-id="assistant-2"]'
    );
    expect(assistantRowsBefore).toHaveLength(2);
    for (const row of assistantRowsBefore ?? []) {
      expect(row.classList.contains('interactive-item-render-empty')).toBe(false);
    }

    const toggle = container?.querySelector<HTMLButtonElement>('.turn-navigation-hide-ai');
    expect(toggle).not.toBeNull();
    toggle?.click();
    await Promise.resolve();

    for (const row of assistantRowsBefore ?? []) {
      expect(row.classList.contains('interactive-item-render-empty')).toBe(true);
      expect(row.querySelector('.chat-turn-content')).toBeNull();
    }
    expect(container?.querySelector('[data-msg-id="prompt-1"] .chat-turn-content')).not.toBeNull();
    expect(container?.querySelector('[data-msg-id="prompt-2"] .chat-turn-content')).not.toBeNull();
    expect(
      container
        ?.querySelector<HTMLButtonElement>('.turn-navigation-hide-ai')
        ?.getAttribute('aria-pressed')
    ).toBe('true');
  });

  it('re-shows assistant responses when a numbered marker is clicked', async () => {
    await renderTranscript();

    container?.querySelector<HTMLButtonElement>('.turn-navigation-hide-ai')?.click();
    await Promise.resolve();

    const firstMarker = container?.querySelector<HTMLButtonElement>('.turn-navigation-marker');
    expect(firstMarker).not.toBeNull();
    firstMarker?.click();
    await Promise.resolve();

    const assistantRow = container?.querySelector('[data-msg-id="assistant-1"]');
    expect(assistantRow?.classList.contains('interactive-item-render-empty')).toBe(false);
    expect(
      container
        ?.querySelector<HTMLButtonElement>('.turn-navigation-hide-ai')
        ?.getAttribute('aria-pressed')
    ).toBe('false');
  });

  it('shows prompt numbers on user message cards while hidden, without Alt', async () => {
    await renderTranscript();

    expect(container?.querySelector('[data-msg-id="prompt-1"] .prompt-number-badge')).toBeNull();

    container?.querySelector<HTMLButtonElement>('.turn-navigation-hide-ai')?.click();
    await Promise.resolve();

    expect(
      container?.querySelector('[data-msg-id="prompt-1"] .prompt-number-badge')?.textContent
    ).toBe('1');
    expect(
      container?.querySelector('[data-msg-id="prompt-2"] .prompt-number-badge')?.textContent
    ).toBe('2');
  });

  it('re-shows assistant responses when a user message number is clicked', async () => {
    await renderTranscript();

    container?.querySelector<HTMLButtonElement>('.turn-navigation-hide-ai')?.click();
    await Promise.resolve();

    const badge = container?.querySelector<HTMLElement>(
      '[data-msg-id="prompt-2"] .prompt-number-badge'
    );
    expect(badge).not.toBeNull();
    badge?.click();
    await Promise.resolve();

    expect(
      container
        ?.querySelector<HTMLButtonElement>('.turn-navigation-hide-ai')
        ?.getAttribute('aria-pressed')
    ).toBe('false');
    expect(
      container
        ?.querySelector('[data-msg-id="assistant-2"]')
        ?.classList.contains('interactive-item-render-empty')
    ).toBe(false);
  });

  it('resets the hide state when the active session changes', async () => {
    await renderTranscript();

    container?.querySelector<HTMLButtonElement>('.turn-navigation-hide-ai')?.click();
    await Promise.resolve();

    setState('activeSessionId', 'session-2');
    setState('sessions', (current: Session[]) => [
      ...current.filter((item) => item.id !== 'session-1'),
      session('session-2'),
    ]);
    replaceMessages([
      {
        info: { ...userMessage('other-prompt'), sessionID: 'session-2' },
        parts: [textPart('other-prompt-text', 'Other')],
      },
      {
        info: assistantMessage('other-assistant', { sessionID: 'session-2' }),
        parts: [textPart('other-reply', 'Other reply')],
      },
    ]);
    await Promise.resolve();

    const otherAssistant = container?.querySelector('[data-msg-id="other-assistant"]');
    expect(otherAssistant?.classList.contains('interactive-item-render-empty')).toBe(false);
  });
});
