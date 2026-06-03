import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import type { FilePart, Part, ToolPart } from '../types';
import { client } from '../lib/client';
import { setExpandThinkingByDefault } from '../lib/state';
import {
  Message,
  calculateAssistantPartVirtualRange,
  getAssistantContainerVariant,
  getUserMessagePreviewText,
  parseUserMessageContent,
  stripCompactionBoundaryMarkdown,
} from './Message';
import { resetToolCallExpansionState } from './ToolCall';

const retryMessageMock = vi.hoisted(() => vi.fn());
const openProviderSetupMock = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useOpenCode', () => ({
  retryMessage: retryMessageMock,
}));

vi.mock('../lib/provider-setup', () => ({
  openProviderSetup: openProviderSetupMock,
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let resizeObserverObserveMock: ReturnType<typeof vi.fn>;
let resizeObserverDisconnectMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  resizeObserverObserveMock = vi.fn();
  resizeObserverDisconnectMock = vi.fn();
  globalThis.ResizeObserver = class ResizeObserver {
    observe = resizeObserverObserveMock;
    unobserve() {}
    disconnect = resizeObserverDisconnectMock;
  } as typeof ResizeObserver;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  globalThis.ResizeObserver = originalResizeObserver;
  document.body.classList.remove('chat-image-preview-open');
  retryMessageMock.mockReset();
  openProviderSetupMock.mockReset();
  resetToolCallExpansionState();
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

function pressShift() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
}

function releaseShift() {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
}

function compactionPart(id: string, options?: { auto?: boolean; overflow?: boolean }): Part {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'compaction',
    auto: options?.auto ?? false,
    overflow: options?.overflow,
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

function assistantSummaryMessage(id: string) {
  return {
    ...assistantMessage(id),
    summary: true,
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

function filePart(id: string, filename: string, mime = 'application/pdf'): FilePart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'file',
    mime,
    filename,
    url: `https://example.test/${id}`,
  };
}

function toolPart(id: string, state: ToolPart['state']): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'browser-bridge_browser_page',
    state,
  };
}

function completedToolState(
  input: Record<string, unknown>,
  output: string,
  title = ''
): Extract<ToolPart['state'], { status: 'completed' }> {
  return {
    status: 'completed',
    input,
    output,
    title,
    metadata: {},
    time: { start: 0, end: 1 },
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

  it('renders highlighted text with a visible tool call flat during live updates', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: true,
        layoutParts: [
          textPart('text-1', 'Let me explore the codebase and research in parallel.'),
          toolPart('tool-1', completedToolState({ prompt: 'Inspect the repo' }, 'Done', 'Explore')),
        ],
        highlightFinalAnswer: true,
        hasError: false,
      })
    ).toBe('plain');
  });

  it('does not wrap highlighted structured-only turns in an assistant card', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        fileEditStackGroup: null,
        isSubagent: false,
        hasStructuredAssistantParts: true,
        layoutParts: [
          toolPart('tool-1', completedToolState({ filePath: 'a.ts' }, 'Done', 'Read')),
          toolPart('tool-2', completedToolState({ filePath: 'b.ts' }, 'Done', 'Read')),
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

describe('stripCompactionBoundaryMarkdown', () => {
  it('removes leading and trailing hr markers used by compacted sessions', () => {
    expect(stripCompactionBoundaryMarkdown('---\n\nPlan summary\n\n---')).toBe('Plan summary');
  });

  it('removes other markdown thematic-break variants at the boundaries', () => {
    expect(stripCompactionBoundaryMarkdown('* * *\n\nPlan summary\n\n_ _ _')).toBe('Plan summary');
  });

  it('keeps interior hr markers intact', () => {
    expect(stripCompactionBoundaryMarkdown('Intro\n\n---\n\nDetails')).toBe(
      'Intro\n\n---\n\nDetails'
    );
  });
});

describe('calculateAssistantPartVirtualRange', () => {
  it('uses measured heights to compute padded visible ranges', () => {
    expect(
      calculateAssistantPartVirtualRange({
        itemKeys: ['part-1', 'part-2', 'part-3', 'part-4', 'part-5'],
        measuredHeights: new Map([
          ['part-1', 100],
          ['part-2', 250],
          ['part-3', 100],
          ['part-4', 100],
          ['part-5', 100],
        ]),
        scrollTop: 260,
        viewportHeight: 120,
        defaultItemHeight: 100,
        overscan: 1,
      })
    ).toEqual({
      start: 1,
      end: 4,
      topPad: 100,
      bottomPad: 100,
    });
  });

  it('keeps at least one item rendered even with a collapsed viewport sample', () => {
    expect(
      calculateAssistantPartVirtualRange({
        itemKeys: ['part-1', 'part-2', 'part-3'],
        measuredHeights: new Map(),
        scrollTop: 1000,
        viewportHeight: 0,
        defaultItemHeight: 100,
        overscan: 0,
      })
    ).toEqual({
      start: 2,
      end: 3,
      topPad: 200,
      bottomPad: 0,
    });
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
    expect(container?.querySelector('.user-message-code-block code.hljs')).toBeInstanceOf(
      HTMLElement
    );
    expect(container?.querySelector('.user-message-code-block .hljs-keyword')?.textContent).toBe(
      'const'
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

  it('renders sent attachments above the user text while leaving images below', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-1'),
          parts: [
            textPart('text-1', '[Active file: src/shared/extension-message.ts]'),
            filePart('file-1', 'spec.pdf'),
            textPart('text-2', 'Please review this.'),
            imageFilePart('image-1', 'diagram.png'),
          ],
        }),
      container!
    );

    const rendered = container?.querySelector('.rendered-markdown');
    const children = Array.from(rendered?.children ?? []);

    expect(children[0]?.classList.contains('message-attachments')).toBe(true);
    expect(children[0]?.textContent).toContain('extension-message.ts');
    expect(children[1]?.classList.contains('chat-attachment-chip')).toBe(true);
    expect(children[1]?.textContent).toContain('spec.pdf');
    expect(children[2]?.classList.contains('user-message-text-scroll')).toBe(true);
    expect(children[2]?.textContent).toContain('Please review this.');
    expect(children[3]?.classList.contains('chat-image-figure')).toBe(true);
    expect(children[3]?.textContent).toContain('diagram.png');
  });

  it('renders inline file mentions as chips inside the user bubble text', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-inline-file'),
          parts: [
            textPart('text-1', 'Test @README.md and @preview.html'),
            textPart('text-2', 'README.md'),
            textPart('text-3', 'preview.html'),
          ],
        }),
      container!
    );

    const messageText = container?.querySelector('.user-message-text');

    expect(messageText?.textContent).toContain('Test README.md and preview.html');
    expect(messageText?.querySelectorAll('.inline-chip')).toHaveLength(2);
    expect(messageText?.querySelectorAll('.inline-chip-clickable')).toHaveLength(2);
    expect(container?.querySelector('.message-attachments')).toBeNull();
  });

  it('renders inline image placeholders as chips inside the user bubble text', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-inline-image'),
          parts: [
            textPart('text-1', 'Test @e2e/tests/review.spec.ts and this @preview.html [Image 2]'),
            textPart('text-2', 'e2e/tests/review.spec.ts'),
            textPart('text-3', 'preview.html'),
            imageFilePart('image-1', 'Image 1'),
            imageFilePart('image-2', 'Image 2'),
          ],
        }),
      container!
    );

    const messageText = container?.querySelector('.user-message-text');
    const inlineChips = messageText?.querySelectorAll('.inline-chip');

    expect(messageText?.textContent).toContain('Test review.spec.ts and this preview.html Image 2');
    expect(inlineChips).toHaveLength(3);
    expect(messageText?.querySelectorAll('.inline-chip-clickable')).toHaveLength(3);
    expect(Array.from(inlineChips ?? []).map((chip) => chip.textContent?.trim())).toContain(
      'Image 2'
    );
    expect(container?.querySelector('.message-image-carousel')).toBeInstanceOf(HTMLDivElement);
    expect(container?.querySelector('.message-image-carousel-caption-row')?.textContent).toContain(
      'Image 1'
    );
  });

  it('opens the matching image preview from an inline image chip and syncs the carousel', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-inline-image-preview'),
          parts: [
            textPart('text-1', 'Test @e2e/tests/review.spec.ts and this @preview.html [Image 2]'),
            textPart('text-2', 'e2e/tests/review.spec.ts'),
            textPart('text-3', 'preview.html'),
            imageFilePart('image-1', 'Image 1'),
            imageFilePart('image-2', 'Image 2'),
          ],
        }),
      container!
    );

    const imageChip = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('.user-message-text .inline-chip-clickable') ??
        []
    ).find((chip) => chip.textContent?.includes('Image 2'));

    expect(imageChip).toBeInstanceOf(HTMLButtonElement);

    imageChip?.click();

    const overlayImage = container?.querySelector<HTMLImageElement>('.chat-image-preview-img');
    const overlayCaption = container?.querySelector('.chat-image-preview-caption');
    const carouselCaption = container?.querySelector('.message-image-carousel-caption-row');

    expect(overlayImage?.getAttribute('src')).toBe('https://example.test/image-2.png');
    expect(overlayCaption?.textContent).toContain('Image 2');
    expect(carouselCaption?.textContent).toContain('2 / 2');
    expect(carouselCaption?.textContent).toContain('Image 2');
  });

  it('keeps unrelated context attachments in the leading attachment strip', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-inline-file-with-extra-context'),
          parts: [
            textPart('text-1', 'Test @README.md'),
            textPart('text-2', 'README.md'),
            textPart('text-3', 'preview.html'),
          ],
        }),
      container!
    );

    const inlineChips = container?.querySelectorAll('.user-message-text .inline-chip');
    const attachmentStrip = container?.querySelector('.message-attachments');

    expect(inlineChips).toHaveLength(1);
    expect(attachmentStrip).toBeInstanceOf(HTMLDivElement);
    expect(attachmentStrip?.textContent).toContain('preview.html');
    expect(attachmentStrip?.textContent).not.toContain('README.md');
  });

  it('renders trailing slash-style inline file mentions without duplicating the attachment strip', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-inline-file-trailing-path'),
          parts: [
            textPart('text-1', 'test @e2e/tests/review.spec.ts'),
            textPart('text-2', 'e2e/tests/review.spec.ts'),
          ],
        }),
      container!
    );

    const messageText = container?.querySelector('.user-message-text');

    expect(messageText?.textContent).toContain('test review.spec.ts');
    expect(messageText?.querySelectorAll('.inline-chip')).toHaveLength(1);
    expect(container?.querySelector('.message-attachments')).toBeNull();
  });
});

describe('Message tool call expansion', () => {
  it('preserves expanded tool calls across assistant message updates', () => {
    const [parts, setParts] = createSignal<Part[]>([
      toolPart(
        'tool-1',
        completedToolState(
          { action: 'text', textBudget: 5000 },
          'Page text: 2908 chars.',
          'browser_page'
        )
      ),
    ]);

    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-1'),
          parts: parts(),
        }),
      container!
    );

    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();
    expect(container?.querySelector('.tool-invocation-detail')).not.toBeNull();

    setParts([
      toolPart(
        'tool-1',
        completedToolState(
          { action: 'text', budgetPreset: 'normal', textBudget: 5000 },
          'Page text: 2908 chars.',
          'browser_page'
        )
      ),
      textPart('text-1', 'The current page is cursor.com.'),
    ]);

    expect(container?.querySelector('.tool-invocation-detail')).not.toBeNull();
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

describe('parseUserMessageContent', () => {
  it('treats absolute paths with spaces as attachments', () => {
    const parsed = parseUserMessageContent([
      textPart('text-1', 'Test\n\n/Users/andrew/Downloads/report final 5397.pdf'),
    ]);

    expect(parsed.messageTexts).toEqual(['Test']);
    expect(parsed.attachments).toEqual([
      {
        type: 'file-reference',
        path: '/Users/andrew/Downloads/report final 5397.pdf',
        isDirectory: false,
      },
    ]);
  });

  it('keeps slash-containing prose as text when whitespace touches the slash', () => {
    const parsed = parseUserMessageContent([textPart('text-1', 'Use /help')]);

    expect(parsed.messageTexts).toEqual(['Use /help']);
    expect(parsed.attachments).toEqual([]);
  });

  it('treats relative folder references as attachments', () => {
    const parsed = parseUserMessageContent([textPart('text-1', 'See that\n\nsrc/')]);

    expect(parsed.messageTexts).toEqual(['See that']);
    expect(parsed.attachments).toEqual([
      {
        type: 'file-reference',
        path: 'src/',
        isDirectory: true,
      },
    ]);
  });

  it('renders extracted attachment lines from mixed user text', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-inline-attachment'),
          parts: [
            textPart(
              'text-inline-attachment',
              'Test\n\n/Users/andrew/Downloads/ПД Оккервиль ЛСТ Квартплата 5397.pdf'
            ),
          ],
        }),
      container!
    );

    expect(container?.querySelector('.message-attachments .chip-label')?.textContent).toBe(
      'ПД Оккервиль ЛСТ Квартплата 5397.pdf'
    );
    expect(container?.querySelector('.user-message-text')?.textContent).toBe('Test');
  });

  it('keeps inline mentions in message text while hiding duplicated attachment refs', () => {
    const parsed = parseUserMessageContent([
      textPart('text-1', 'Test @README.md and @preview.html'),
      textPart('text-2', 'README.md'),
      textPart('text-3', 'preview.html'),
    ]);

    expect(parsed.messageTexts).toEqual(['Test @README.md and @preview.html']);
    expect(parsed.attachments).toEqual([
      {
        type: 'file-reference',
        path: 'README.md',
        isDirectory: false,
      },
      {
        type: 'file-reference',
        path: 'preview.html',
        isDirectory: false,
      },
    ]);
  });

  it('keeps prose text when it ends with a slash-style inline file mention', () => {
    const parsed = parseUserMessageContent([
      textPart('text-1', 'test @e2e/tests/review.spec.ts'),
      textPart('text-2', 'e2e/tests/review.spec.ts'),
    ]);

    expect(parsed.messageTexts).toEqual(['test @e2e/tests/review.spec.ts']);
    expect(parsed.attachments).toEqual([
      {
        type: 'file-reference',
        path: 'e2e/tests/review.spec.ts',
        isDirectory: false,
      },
    ]);
  });
});

describe('Message user rendering', () => {
  it('does not render empty user message shells with no meaningful content', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-empty-user'),
          parts: [
            {
              id: 'text-empty-user',
              sessionID: 'session-1',
              messageID: 'message-empty-user',
              type: 'text',
              text: '[Working directory: /repo]',
            },
          ],
        }),
      container!
    );

    expect(container?.textContent).toBe('');
    expect(container?.querySelector('.user-message-empty')).toBeNull();
  });

  it('copies inline attachment mentions using their original marker text', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-copy-inline-attachment'),
          parts: [
            textPart(
              'text-copy-inline-attachment',
              "Check @broserbridge/bbx and @handlers.js if it's aligned @README.md - don't do anything this is template test"
            ),
            textPart('attachment-broserbridge', 'broserbridge/bbx'),
            textPart('attachment-handlers', 'handlers.js'),
            textPart('attachment-readme', 'README.md'),
          ],
        }),
      container!
    );

    const messageCard = container?.querySelector<HTMLElement>('.rendered-markdown');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(messageCard!);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const setData = vi.fn();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData },
    });

    messageCard?.dispatchEvent(event);

    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      "Check @broserbridge/bbx and @handlers.js if it's aligned @README.md - don't do anything this is template test"
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

  it('renders streamed reasoning updates without mutating the stored part text', () => {
    setExpandThinkingByDefault(true);

    cleanup = render(
      () =>
        Message({
          info: { ...assistantMessage('message-stream-reasoning'), time: { created: 0 } },
          parts: [reasoningPart('reason-1', 'Planning')],
          streamingPartId: 'reason-1',
          streamingText: '**Plan**\n\nInspect logs',
        }),
      container!
    );

    expect(container?.querySelector('.thinking-label-text')?.textContent).toContain('Plan');
    expect(container?.querySelector('.thinking-text')?.textContent).toContain('Inspect logs');
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

  it('hides compaction boundary hr markers from rendered streamed text', () => {
    cleanup = render(
      () =>
        Message({
          info: { ...assistantMessage('message-stream-4'), time: { created: 0 } },
          parts: [compactionPart('compaction-1', { auto: true }), textPart('text-1', 'Loading...')],
          streamingPartId: 'text-1',
          streamingText: '---\n\nCompacted session summary.\n\n---',
        }),
      container!
    );

    expect(container?.textContent).toContain('Compacted session summary.');
    expect(container?.querySelectorAll('hr')).toHaveLength(0);
  });

  it('hides compaction boundary hr markers for assistant summary messages', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantSummaryMessage('message-stream-5'),
          parts: [textPart('text-1', '---\n\nGoal\n\n- Fix issue\n\n---')],
        }),
      container!
    );

    expect(container?.textContent).toContain('Goal');
    expect(container?.querySelectorAll('hr')).toHaveLength(0);
  });
});

describe('Message assistant final answer rendering', () => {
  it('does not attach assistant part observers for normal-sized assistant turns', async () => {
    const host = document.createElement('div');
    host.className = 'interactive-list';
    host.appendChild(container!);
    document.body.appendChild(host);

    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-normal-observers'),
          parts: [
            reasoningPart('reason-1', 'Inspecting'),
            textPart('text-1', 'Status update.'),
            textPart('text-2', 'Final answer.'),
          ],
          highlightFinalAnswer: true,
        }),
      container!
    );

    await Promise.resolve();

    expect(resizeObserverObserveMock).not.toHaveBeenCalled();

    host.remove();
  });

  it('shows the read mode toggle for large final answers only while Shift is pressed', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-read-large'),
          parts: [
            reasoningPart('reason-1', 'Inspecting'),
            textPart('text-1', 'Status update.'),
            textPart(
              'text-2',
              [
                'Implemented the final fix across the highlighted layout and kept the intermediate updates separate.',
                'The final answer now has enough detail to warrant read mode.',
                'It includes multiple lines of explanation so longer responses stay comfortable to read.',
                'This also gives the toggle a clear threshold-based behavior.',
                'Users will no longer see the expand affordance for very short replies.',
                'Only responses with enough content should show the button.',
                'That keeps the card cleaner for compact confirmations.',
                'This paragraph pushes the response over the large-response threshold.',
              ].join('\n\n')
            ),
          ],
          highlightFinalAnswer: true,
        }),
      container!
    );

    expect(container?.querySelector('.assistant-read-mode-toggle')).toBeNull();

    pressShift();

    const toggle = container?.querySelector('.assistant-read-mode-toggle');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);

    releaseShift();
    expect(container?.querySelector('.assistant-read-mode-toggle')).toBeNull();
  });

  it('hides the read mode toggle for short final answers', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-read-short'),
          parts: [
            reasoningPart('reason-1', 'Inspecting'),
            textPart('text-1', 'Status update.'),
            textPart('text-2', 'Final answer for reading.'),
          ],
          highlightFinalAnswer: true,
        }),
      container!
    );

    expect(container?.querySelector('.assistant-read-mode-toggle')).toBeNull();
  });

  it('opens the final answer in read mode and closes with Escape', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-read-1'),
          parts: [
            reasoningPart('reason-1', 'Inspecting'),
            textPart('text-1', 'Status update.'),
            textPart(
              'text-2',
              [
                'Final answer for reading.',
                'This version is intentionally long enough to trigger the read mode affordance.',
                'It spans several paragraphs so the expanded reading surface is useful.',
                'That keeps the test aligned with the production behavior for large responses.',
                'The extra lines ensure the threshold is crossed without depending on exact markdown rendering.',
                'Read mode should open from the final answer only.',
                'Earlier status updates must stay out of the overlay.',
                'Escape should still close the overlay cleanly.',
              ].join('\n\n')
            ),
          ],
          highlightFinalAnswer: true,
        }),
      container!
    );

    pressShift();

    const toggle = container?.querySelector('.assistant-read-mode-toggle');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);

    (toggle as HTMLButtonElement).click();

    const overlay = container?.querySelector('.assistant-read-overlay');
    const overlayContent = container?.querySelector('.assistant-read-mode-content');

    expect(overlay).toBeInstanceOf(HTMLDivElement);
    expect(document.body.classList.contains('chat-read-mode-open')).toBe(true);
    expect(overlayContent?.textContent).toContain('Final answer for reading.');
    expect(overlayContent?.textContent).not.toContain('Status update.');
    expect(overlayContent?.textContent).not.toContain('Thinking');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(container?.querySelector('.assistant-read-overlay')).toBeNull();
    expect(document.body.classList.contains('chat-read-mode-open')).toBe(false);
  });

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

  it('does not mark text as a dedicated final answer block when a visible tool call follows it', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-tool-after-text'),
          parts: [
            textPart('text-1', 'Selected excerpt'),
            toolPart('tool-1', {
              status: 'completed',
              input: { command: 'pwd' },
              output: '/workspace',
              title: 'Inspect cwd',
              time: { start: 1, end: 2 },
              metadata: {},
            }),
          ],
          highlightFinalAnswer: true,
        }),
      container!
    );

    expect(container?.querySelector('.assistant-turn-content-plain')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(container?.querySelector('.assistant-turn-content-highlighted')).toBeNull();
    expect(container?.querySelector('.assistant-message-flow-item-final')).toBeNull();
    expect(container?.querySelector('.tool-invocation-header')).toBeInstanceOf(HTMLButtonElement);
  });

  it('renders changed files outside the assistant response block', async () => {
    vi.spyOn(client.session, 'diff').mockResolvedValue([
      {
        file: 'src/webview/components/Chat.tsx',
        before: '',
        after: '',
        additions: 71,
        deletions: 80,
      },
    ]);

    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-with-diff'),
          parts: [textPart('text-1', 'Hello\nworld')],
          isLastAssistant: true,
          highlightFinalAnswer: true,
        }),
      container!
    );

    await vi.waitFor(() => {
      expect(container?.querySelector('.diff-summary')).toBeInstanceOf(HTMLDivElement);
    });

    const chatTurn = container?.querySelector('.chat-turn-assistant');
    const responseBlock = container?.querySelector('.chat-turn-content');
    const diffSummary = container?.querySelector('.diff-summary');

    expect(chatTurn).toBeInstanceOf(HTMLDivElement);
    expect(responseBlock).toBeInstanceOf(HTMLDivElement);
    expect(diffSummary).toBeInstanceOf(HTMLDivElement);
    expect(chatTurn?.lastElementChild).toBe(diffSummary);
    expect(responseBlock?.contains(diffSummary!)).toBe(false);
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

  it('opens a larger preview for a single image and closes with Escape', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-image-preview-1'),
          parts: [imageFilePart('image-1', 'diagram.png')],
        }),
      container!
    );

    const trigger = container?.querySelector<HTMLButtonElement>('.chat-image-preview-trigger');
    expect(trigger).toBeInstanceOf(HTMLButtonElement);

    trigger?.click();

    const overlay = container?.querySelector('.chat-image-preview-overlay');
    const overlayImage = container?.querySelector<HTMLImageElement>('.chat-image-preview-img');

    expect(overlay).toBeInstanceOf(HTMLDivElement);
    expect(document.body.classList.contains('chat-image-preview-open')).toBe(true);
    expect(overlayImage?.getAttribute('src')).toBe('https://example.test/image-1.png');
    expect(container?.querySelector('.chat-image-preview-caption')?.textContent).toContain(
      'diagram.png'
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(container?.querySelector('.chat-image-preview-overlay')).toBeNull();
    expect(document.body.classList.contains('chat-image-preview-open')).toBe(false);
  });

  it('opens the current carousel image in the larger preview', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-image-preview-2'),
          parts: [imageFilePart('image-1', 'Image 1'), imageFilePart('image-2', 'Image 2')],
        }),
      container!
    );

    const nextButton = container?.querySelectorAll<HTMLButtonElement>(
      '.message-image-carousel-nav'
    )[1];
    expect(nextButton).toBeInstanceOf(HTMLButtonElement);

    nextButton?.click();

    const trigger = container?.querySelector<HTMLButtonElement>(
      '.message-image-carousel-preview-trigger'
    );
    trigger?.click();

    const overlayImage = container?.querySelector<HTMLImageElement>('.chat-image-preview-img');
    const overlayCaption = container?.querySelector('.chat-image-preview-caption');

    expect(overlayImage?.getAttribute('src')).toBe('https://example.test/image-2.png');
    expect(overlayCaption?.textContent).toContain('Image 2');
    expect(overlayCaption?.textContent).toContain('image/png');
  });

  it('navigates between attached images from the larger preview', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-image-preview-3'),
          parts: [imageFilePart('image-1', 'Image 1'), imageFilePart('image-2', 'Image 2')],
        }),
      container!
    );

    const trigger = container?.querySelector<HTMLButtonElement>(
      '.message-image-carousel-preview-trigger'
    );
    trigger?.click();

    const nextOverlayButton =
      container?.querySelectorAll<HTMLButtonElement>('.chat-image-preview-nav')[1];
    expect(nextOverlayButton).toBeInstanceOf(HTMLButtonElement);

    nextOverlayButton?.click();

    let overlayImage = container?.querySelector<HTMLImageElement>('.chat-image-preview-img');
    let overlayCaption = container?.querySelector('.chat-image-preview-caption');

    expect(overlayImage?.getAttribute('src')).toBe('https://example.test/image-2.png');
    expect(overlayCaption?.textContent).toContain('2 / 2');
    expect(overlayCaption?.textContent).toContain('Image 2');
    expect(container?.querySelector('.message-image-carousel-caption-row')?.textContent).toContain(
      '2 / 2'
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));

    overlayImage = container?.querySelector<HTMLImageElement>('.chat-image-preview-img');
    overlayCaption = container?.querySelector('.chat-image-preview-caption');

    expect(overlayImage?.getAttribute('src')).toBe('https://example.test/image-1.png');
    expect(overlayCaption?.textContent).toContain('1 / 2');
    expect(overlayCaption?.textContent).toContain('Image 1');
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
      () =>
        Message({
          info: assistant,
          parts: [reasoningPart('reason-1', 'Inspecting')],
          isLastAssistant: true,
        }),
      container!
    );

    const retryButton = container?.querySelector('.assistant-message-flow-item-error-action');

    expect(retryButton).toBeInstanceOf(HTMLButtonElement);
    expect(retryButton?.textContent).toContain('Retry');

    (retryButton as HTMLButtonElement).click();

    expect(retryMessageMock).toHaveBeenCalledWith('message-3', 'session-1');
  });

  it('renders a connect provider action for invalidated provider auth errors', async () => {
    const { setState } = await import('../lib/state');
    const assistant = {
      ...assistantMessage('message-3'),
      error: {
        name: 'ProviderAuthError',
        data: {
          message: 'Your authentication token has been invalidated. Please try signing in again.',
        },
      },
    };

    setState('messages', [
      {
        info: assistant,
        parts: [reasoningPart('reason-1', 'Inspecting')],
      },
    ]);

    cleanup = render(
      () =>
        Message({
          info: assistant,
          parts: [reasoningPart('reason-1', 'Inspecting')],
          isLastAssistant: true,
        }),
      container!
    );

    const connectButton = container?.querySelector('.assistant-message-flow-item-error-action');

    expect(connectButton).toBeInstanceOf(HTMLButtonElement);
    expect(connectButton?.textContent).toContain('Connect provider');

    (connectButton as HTMLButtonElement).click();

    expect(openProviderSetupMock).toHaveBeenCalledTimes(1);
    expect(retryMessageMock).not.toHaveBeenCalled();
  });

  it('shows friendly label for MessageOutputLengthError (no data.message)', () => {
    cleanup = render(
      () =>
        Message({
          info: {
            ...assistantMessage('message-3'),
            error: { name: 'MessageOutputLengthError' },
          },
          parts: [reasoningPart('reason-1', 'Inspecting')],
        }),
      container!
    );

    const errorText = container?.querySelector('.assistant-message-flow-item-error');
    expect(errorText?.textContent).toContain('Output length exceeded');
  });

  it('does not render a retry action for aborted assistant errors', async () => {
    const { setState } = await import('../lib/state');
    const assistant = {
      ...assistantMessage('message-3'),
      error: {
        name: 'aborted',
        data: { message: 'Aborted' },
      },
    };

    setState('messages', [
      {
        info: assistant,
        parts: [reasoningPart('reason-1', 'Inspecting')],
      },
    ]);

    cleanup = render(
      () => Message({ info: assistant, parts: [reasoningPart('reason-1', 'Inspecting')] }),
      container!
    );

    const errorBlock = container?.querySelector('.assistant-message-flow-item-error');
    const retryButton = container?.querySelector('.assistant-message-flow-item-error-action');

    expect(errorBlock).toBeNull();
    expect(retryButton).toBeNull();
    expect(retryMessageMock).not.toHaveBeenCalled();
  });
});
