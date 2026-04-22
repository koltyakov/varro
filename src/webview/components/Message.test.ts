import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import type { Part } from '../types';
import { Message, getAssistantContainerVariant } from './Message';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
});

function textPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'text',
    text,
  };
}

function reasoningPart(id: string, text: string): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time: { start: 0 },
  };
}

function userMessage(id: string) {
  return {
    id,
    sessionID: 'session-1',
    role: 'user' as const,
    time: { created: 0 },
    agent: 'chat',
    model: { providerID: 'provider-1', modelID: 'model-1' },
  };
}

describe('getAssistantContainerVariant', () => {
  it('renders intermediate text updates inline when mixed with structured parts', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: true,
        layoutParts: [
          reasoningPart('reason-1', 'Inspecting'),
          textPart('text-1', 'Fixing it now.'),
        ],
        highlightFinalAnswer: false,
      })
    ).toBe('plain');
  });

  it('renders intermediate text-only updates inline by default', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: false,
        layoutParts: [textPart('text-1', 'Updating the carousel layout.')],
        highlightFinalAnswer: false,
      })
    ).toBe('plain');
  });

  it('keeps final answers in the standard assistant card', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: true,
        layoutParts: [reasoningPart('reason-1', 'Inspecting'), textPart('text-1', 'Final answer.')],
        highlightFinalAnswer: true,
      })
    ).toBe(false);
  });

  it('keeps planning final answers in the standard assistant card variant', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: false,
        layoutParts: [textPart('text-1', 'Plan summary.')],
        highlightFinalAnswer: true,
      })
    ).toBe(false);
  });

  it('renders mixed structured and final text messages flat so only the final text can be carded', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: true,
        layoutParts: [
          reasoningPart('reason-1', 'Inspecting'),
          textPart('text-1', 'Status update.'),
          textPart('text-2', 'Final answer.'),
        ],
        highlightFinalAnswer: true,
      })
    ).toBe('plain');
  });
});

describe('Message user prompt rendering', () => {
  it('wraps user prompt text in a scroll container', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-1'),
          parts: [textPart('text-1', 'Line 1'), textPart('text-2', 'Line 2')],
        }),
      container!
    );

    const scrollContainer = container?.querySelector('.user-message-text-scroll');
    expect(scrollContainer).toBeInstanceOf(HTMLDivElement);
    expect(scrollContainer?.querySelectorAll('.user-message-text')).toHaveLength(2);
  });
});
