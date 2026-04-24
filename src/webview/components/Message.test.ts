import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { FilePart, Part } from '../types';
import { Message, getAssistantContainerVariant, getUserMessagePreviewText } from './Message';

const retryMessageMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useOpenCode', () => ({
  retryMessage: retryMessageMock,
}));

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
  retryMessageMock.mockReset();
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

function assistantMessage(id: string) {
  return {
    id,
    sessionID: 'session-1',
    role: 'assistant' as const,
    time: { created: 0, completed: 1 },
    parentID: 'parent-1',
    providerID: 'provider-1',
    modelID: 'model-1',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function imageFilePart(id: string, filename: string): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime: 'image/png',
    filename,
    url: `https://example.test/${id}.png`,
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
        hasError: false,
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
        hasError: false,
      })
    ).toBe('plain');
  });

  it('renders final answers plain when reasoning precedes the final text', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: true,
        layoutParts: [reasoningPart('reason-1', 'Inspecting'), textPart('text-1', 'Final answer.')],
        highlightFinalAnswer: true,
        hasError: false,
      })
    ).toBe('plain');
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
        hasError: false,
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
        hasError: false,
      })
    ).toBe('plain');
  });

  it('keeps text-only final answers in the standard assistant card', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: false,
        layoutParts: [textPart('text-1', 'Final answer.')],
        highlightFinalAnswer: true,
        hasError: false,
      })
    ).toBe(false);
  });

  it('renders errored assistant turns plain even without a final answer', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: true,
        layoutParts: [reasoningPart('reason-1', 'Inspecting')],
        highlightFinalAnswer: false,
        hasError: true,
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

  it('renders fenced user prompt text as a scrollable code block', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-1'),
          parts: [
            textPart(
              'text-1',
              'Before\n```ts\nconst value = 1;\nconst next = value + 1;\n```\nAfter'
            ),
          ],
        }),
      container!
    );

    expect(container?.querySelectorAll('.user-message-text')).toHaveLength(2);
    expect(container?.querySelectorAll('.user-message-text')[0]?.textContent).toBe('Before');
    expect(container?.querySelectorAll('.user-message-text')[1]?.textContent).toBe('After');
    expect(container?.querySelector('.user-message-code-block')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.user-message-code-block .code-block-lang')?.textContent).toBe(
      'ts'
    );
    expect(container?.querySelector('.user-message-code-block code')?.textContent).toBe(
      'const value = 1;\nconst next = value + 1;\n'
    );
  });

  it('does not render an attachments separator for attachment-only user prompts', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-1'),
          parts: [textPart('text-1', '[Active file: src/shared/extension-message.ts]')],
        }),
      container!
    );

    const attachments = container?.querySelector('.message-attachments');

    expect(attachments).toBeInstanceOf(HTMLDivElement);
    expect(attachments?.classList.contains('message-attachments-standalone')).toBe(true);
  });
});

describe('getUserMessagePreviewText', () => {
  it('ignores working-directory boilerplate and keeps the first meaningful text', () => {
    expect(
      getUserMessagePreviewText([
        textPart('text-1', '[Working directory: /repo]'),
        textPart('text-2', 'Why it fails and how to fix?'),
      ])
    ).toBe('Why it fails and how to fix?');
  });

  it('collapses fenced code and multiline text into a compact single line', () => {
    expect(
      getUserMessagePreviewText([textPart('text-1', 'Before\n```ts\nconst value = 1;\n```\nAfter')])
    ).toBe('Before ```ts const value = 1; ``` After');
  });

  it('falls back to attachment labels when the prompt only includes file context', () => {
    expect(
      getUserMessagePreviewText([
        textPart('text-1', '[Active file: src/webview/components/Chat.tsx]'),
      ])
    ).toBe('File: Chat.tsx');
  });

  it('falls back to file attachments when no text or attachment refs exist', () => {
    expect(getUserMessagePreviewText([imageFilePart('file-1', 'diagram.png')])).toBe(
      'Attachment: diagram.png'
    );
  });
});

describe('Message streamed assistant text rendering', () => {
  it('renders streamed assistant markdown formatting immediately', () => {
    cleanup = render(
      () =>
        Message({
          info: { ...assistantMessage('message-stream-1'), time: { created: 0 } },
          parts: [textPart('text-1', 'Loading...')],
          streamingPartId: 'text-1',
          streamingText:
            '## Accessibility\n\n| # | Issue |\n| --- | --- |\n| A1 | Live region |\n\n- Fix announcer',
        }),
      container!
    );

    expect(container?.querySelector('h2')?.textContent).toBe('Accessibility');
    expect(container?.querySelector('table')).toBeInstanceOf(HTMLTableElement);
    expect(container?.querySelector('ul li')?.textContent).toContain('Fix announcer');
  });

  it('renders streamed fenced code blocks through the markdown renderer', () => {
    cleanup = render(
      () =>
        Message({
          info: { ...assistantMessage('message-stream-2'), time: { created: 0 } },
          parts: [textPart('text-1', 'Loading...')],
          streamingPartId: 'text-1',
          streamingText: 'Before\n\n```ts\nconst value = 1;\n```\n\nAfter',
        }),
      container!
    );

    expect(container?.querySelector('.interactive-result-code-block')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(
      container?.querySelector('.interactive-result-code-block .code-block-lang')?.textContent
    ).toBe('ts');
    expect(container?.querySelector('.interactive-result-code-block code')?.textContent).toBe(
      'const value = 1;'
    );
    expect(container?.textContent).toContain('Before');
    expect(container?.textContent).toContain('After');
  });

  it('does not mark streamed assistant text as a final answer before completion highlighting', () => {
    cleanup = render(
      () =>
        Message({
          info: { ...assistantMessage('message-stream-3'), time: { created: 0 } },
          parts: [reasoningPart('reason-1', 'Inspecting'), textPart('text-1', 'Loading...')],
          streamingPartId: 'text-1',
          streamingText: 'Implemented the fix.',
          highlightFinalAnswer: false,
        }),
      container!
    );

    expect(container?.querySelector('.assistant-message-flow-item-final')).toBeNull();
  });
});

describe('Message assistant final answer rendering', () => {
  it('marks the final text update inside a mixed assistant turn as a dedicated final answer block', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-2'),
          parts: [
            reasoningPart('reason-1', 'Inspecting'),
            textPart('text-1', 'Status update.'),
            textPart('text-2', 'Final answer.'),
          ],
          highlightFinalAnswer: true,
        }),
      container!
    );

    const plainContainer = container?.querySelector('.assistant-turn-content-plain');
    const finalItem = container?.querySelector('.assistant-message-flow-item-final');

    expect(plainContainer).toBeInstanceOf(HTMLDivElement);
    expect(finalItem).toBeInstanceOf(HTMLDivElement);
    expect(finalItem?.textContent).toContain('Final answer.');
  });

  it('renders thinking outside highlighted planning cards and hides workspace text', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-3'),
          parts: [
            reasoningPart('reason-1', 'Inspecting'),
            textPart('text-1', '[Working directory: /workspace]'),
            textPart('text-2', 'Dummy Plan\n\n- First step'),
          ],
          highlightFinalAnswer: true,
          highlightPlanningAnswer: true,
        }),
      container!
    );

    const plainContainer = container?.querySelector('.assistant-turn-content-plain');
    const thinkingItem = container
      ?.querySelector('.chat-thinking-box')
      ?.closest('.assistant-message-flow-item');
    const finalItem = container?.querySelector('.assistant-message-flow-item-final-planning');

    expect(plainContainer).toBeInstanceOf(HTMLDivElement);
    expect(container?.textContent).toContain('Thinking');
    expect(container?.textContent).not.toContain('[Working directory: /workspace]');
    expect(container?.textContent).toContain('Dummy Plan');
    expect(finalItem).toBeInstanceOf(HTMLDivElement);
    expect(thinkingItem).toBeInstanceOf(HTMLDivElement);
    expect(thinkingItem).not.toBe(finalItem);
    expect(container?.querySelector('.assistant-turn-content-highlighted')).toBeNull();
    expect(container?.querySelector('.assistant-turn-content-planning')).toBeNull();
  });

  it('renders thinking outside highlighted result cards and hides workspace text', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-4'),
          parts: [
            reasoningPart('reason-1', 'Inspecting'),
            textPart('text-1', '[Working directory: /workspace]'),
            textPart('text-2', 'Implemented the fix.'),
          ],
          highlightFinalAnswer: true,
        }),
      container!
    );

    const plainContainer = container?.querySelector('.assistant-turn-content-plain');
    const thinkingItem = container
      ?.querySelector('.chat-thinking-box')
      ?.closest('.assistant-message-flow-item');
    const finalItem = container?.querySelector('.assistant-message-flow-item-final');

    expect(plainContainer).toBeInstanceOf(HTMLDivElement);
    expect(container?.textContent).toContain('Thinking');
    expect(container?.textContent).not.toContain('[Working directory: /workspace]');
    expect(container?.textContent).toContain('Implemented the fix.');
    expect(finalItem).toBeInstanceOf(HTMLDivElement);
    expect(thinkingItem).toBeInstanceOf(HTMLDivElement);
    expect(thinkingItem).not.toBe(finalItem);
  });

  it('renders carousel navigation inside the image block footer row', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-5'),
          parts: [imageFilePart('image-1', 'Image 1'), imageFilePart('image-2', 'Image 2')],
        }),
      container!
    );

    const figure = container?.querySelector('.message-image-carousel-figure');
    const captionRow = container?.querySelector('.message-image-carousel-caption-row');
    const controls = container?.querySelector('.message-image-carousel-controls');

    expect(figure).toBeInstanceOf(HTMLElement);
    expect(captionRow).toBeInstanceOf(HTMLElement);
    expect(controls).toBeInstanceOf(HTMLElement);
    expect(figure?.contains(captionRow!)).toBe(true);
    expect(captionRow?.contains(controls!)).toBe(true);
    expect(captionRow?.textContent).toContain('1 / 2');
    expect(captionRow?.textContent).toContain('Image 1');
    expect(container?.querySelector('.message-image-carousel-footer')).toBeNull();
  });

  it('renders assistant message errors as an inline error block', () => {
    cleanup = render(
      () =>
        Message({
          info: {
            ...assistantMessage('message-3'),
            error: {
              name: 'server_error',
              data: { message: 'An error occurred while processing your request.' },
            },
          },
          parts: [reasoningPart('reason-1', 'Inspecting')],
        }),
      container!
    );

    const errorText = container?.querySelector('.assistant-message-flow-item-error');
    const diffSummary = container?.querySelector('.diff-summary');

    expect(errorText).toBeInstanceOf(HTMLDivElement);
    expect(errorText?.textContent).toContain('An error occurred while processing your request.');
    expect(diffSummary).toBeNull();
  });

  it('renders a retry action for the latest assistant error and retries that turn', async () => {
    const { setState } = await import('../lib/state');
    const user = userMessage('message-2');
    const assistant = {
      ...assistantMessage('message-3'),
      parentID: 'message-2',
      error: {
        name: 'server_error',
        data: { message: 'An error occurred while processing your request.' },
      },
    };

    setState('messages', [
      {
        info: user,
        parts: [textPart('text-user-1', 'Try again')],
      },
      {
        info: assistant,
        parts: [reasoningPart('reason-1', 'Inspecting')],
      },
    ]);

    cleanup = render(
      () => Message({ info: assistant, parts: [reasoningPart('reason-1', 'Inspecting')] }),
      container!
    );

    const retryButton = container?.querySelector('.assistant-message-flow-item-error-action');

    expect(retryButton).toBeInstanceOf(HTMLButtonElement);
    expect(retryButton?.textContent).toContain('Retry');

    (retryButton as HTMLButtonElement).click();

    expect(retryMessageMock).toHaveBeenCalledWith('message-3', 'session-1');
  });
});
