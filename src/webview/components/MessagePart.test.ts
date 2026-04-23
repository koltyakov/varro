import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { setExpandThinkingAndCommandsByDefaultPreference } from '../lib/state';
import type { ReasoningPart } from '../types';
import {
  MessagePart,
  formatReasoningDuration,
  formatReasoningHeader,
  splitReasoningText,
} from './MessagePart';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setExpandThinkingAndCommandsByDefaultPreference(false);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setExpandThinkingAndCommandsByDefaultPreference(false);
});

function reasoningPart(text: string): ReasoningPart {
  return {
    id: 'reasoning-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 0, end: 1 },
  };
}

describe('formatReasoningDuration', () => {
  it('returns null while reasoning is still running', () => {
    expect(formatReasoningDuration({ start: 12 })).toBeNull();
  });

  it('formats completed reasoning time', () => {
    expect(formatReasoningDuration({ start: 10, end: 17 })).toBe('7ms');
  });
});

describe('formatReasoningHeader', () => {
  it('shows the subject without the Thinking prefix when present', () => {
    expect(formatReasoningHeader('Inspecting extension util files')).toBe(
      'Inspecting extension util files'
    );
  });

  it('falls back to Thinking when there is no subject', () => {
    expect(formatReasoningHeader(null)).toBe('Thinking');
  });

  it('appends detail labels after the primary heading', () => {
    expect(formatReasoningHeader('Inspecting extension util files', 'GPT-5 · High Reasoning')).toBe(
      'Inspecting extension util files · GPT-5 · High Reasoning'
    );
  });
});

describe('splitReasoningText', () => {
  it('moves a bold first line into the thinking header', () => {
    expect(
      splitReasoningText(
        '**Considering layout options**\n\nI am weighing warning and error displays.'
      )
    ).toEqual({
      subject: 'Considering layout options',
      body: 'I am weighing warning and error displays.',
    });
  });

  it('ignores reasoning text without a standalone bold subject line', () => {
    expect(splitReasoningText('Thinking through the layout options.')).toEqual({
      subject: null,
      body: 'Thinking through the layout options.',
    });
  });

  it('skips leading blank lines before extracting the subject', () => {
    expect(splitReasoningText('\n\n**Plan the migration**\n\nStep one\nStep two')).toEqual({
      subject: 'Plan the migration',
      body: 'Step one\nStep two',
    });
  });
});

describe('MessagePart', () => {
  it('expands reasoning blocks by default when the setting is enabled', () => {
    setExpandThinkingAndCommandsByDefaultPreference(true);

    cleanup = render(
      () => MessagePart({ part: reasoningPart('**Planning**\n\nStep one') }),
      container!
    );

    expect(container?.querySelector('.thinking-content')?.textContent).toContain('Step one');
  });
});
