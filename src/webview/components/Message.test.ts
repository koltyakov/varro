import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createSignal } from 'solid-js';
import type { FilePart, Part, ToolPart } from '../types';
import { client } from '../lib/client';
import { editingMessage, resetMessageEditState } from '../lib/message-edit-state';
import {
  providerConnectionRequest,
  providerRequiresReconnection,
  resolveProviderAuthFailure,
  resetProviderConnectionState,
} from '../lib/provider-connection-state';
import {
  setShowRequestTimestamps,
  setShowResponseTimestamps,
  setShowSettings,
  setResponseTimestamp,
  setState as setAppState,
  showSettings,
} from '../lib/state';
import {
  Message,
  getAssistantContainerVariant,
  getUserMessageEditContext,
  getUserMessageEditText,
  getUserMessageMarkupFormat,
  getUserMessagePreviewText,
  parseUserMessageContent,
  stripCompactionBoundaryMarkdown,
} from './Message';
import { resetToolCallExpansionState } from './ToolCall';
import { fixture } from '../test-fixtures';
import type { UnknownRecord } from '../../shared/type-utils';

const retryMessageMock = vi.hoisted(() => vi.fn());
const selectSessionMock = vi.hoisted(() => vi.fn());

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise Message actions through the useOpenCode module boundary. */
vi.mock('../hooks/useOpenCode', () => ({
  retryMessage: retryMessageMock,
  selectSession: selectSessionMock,
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let resizeObserverObserveMock: (target: Element, options?: ResizeObserverOptions) => void;
let resizeObserverDisconnectMock: () => void;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  resizeObserverObserveMock = vi.fn();
  resizeObserverDisconnectMock = vi.fn();
  globalThis.ResizeObserver = class ResizeObserver implements globalThis.ResizeObserver {
    observe(target: Element, options?: ResizeObserverOptions) {
      resizeObserverObserveMock(target, options);
    }
    unobserve(_target: Element) {}
    disconnect() {
      resizeObserverDisconnectMock();
    }
  };
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  if (originalResizeObserver) globalThis.ResizeObserver = originalResizeObserver;
  else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  document.body.classList.remove('chat-image-preview-open');
  retryMessageMock.mockReset();
  selectSessionMock.mockReset();
  resetProviderConnectionState();
  setShowSettings(false);
  setShowRequestTimestamps(true);
  setShowResponseTimestamps(true);
  setResponseTimestamp('turn-end');
  setAppState('sessions', []);
  setAppState('allAgents', []);
  resetToolCallExpansionState();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete window.__sendToExtension;
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

function reasoningPart(id: string, text: string, completed = false): Part {
  const time: Extract<Part, { type: 'reasoning' }>['time'] = { start: 0 };
  if (completed) time.end = 1;
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'reasoning',
    text,
    time,
  };
}

function pressAlt() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
}

function releaseAlt() {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
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
  input: ToolPart['state']['input'],
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
        isSubagent: false,
        hasStructuredAssistantParts: true,
        layoutParts: [reasoningPart('reason-1', 'Inspecting'), textPart('text-1', 'Final answer.')],
        highlightFinalAnswer: true,
        hasError: false,
      })
    ).toBe('plain');
  });

  it('renders planning final answers plain', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        isSubagent: false,
        hasStructuredAssistantParts: false,
        layoutParts: [textPart('text-1', 'Plan summary.')],
        highlightFinalAnswer: true,
        hasError: false,
      })
    ).toBe('plain');
  });

  it('renders mixed structured and final text messages plain', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
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

  it('renders text-only final answers plain', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
        isSubagent: false,
        hasStructuredAssistantParts: false,
        layoutParts: [textPart('text-1', 'Final answer.')],
        highlightFinalAnswer: true,
        hasError: false,
      })
    ).toBe('plain');
  });

  it('keeps diff-bearing assistant responses plain before final highlighting', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 2,
        isSubagent: false,
        hasStructuredAssistantParts: false,
        layoutParts: [textPart('text-1', 'Final answer with changed files.')],
        highlightFinalAnswer: false,
        hasError: false,
      })
    ).toBe('plain');
  });

  it('renders errored assistant turns plain even without a final answer', () => {
    expect(
      getAssistantContainerVariant({
        isUser: false,
        visibleDiffCount: 0,
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

  it('fades overflowing user prompt text until it is scrolled to the end', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-1'),
          parts: [textPart('text-1', 'A long prompt')],
        }),
      container!
    );

    const scrollContainer = container?.querySelector<HTMLElement>('.user-message-text-scroll');
    expect(scrollContainer).not.toBeNull();
    Object.defineProperties(scrollContainer!, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 240 },
    });

    scrollContainer!.scrollTop = 0;
    scrollContainer!.dispatchEvent(new Event('scroll'));
    expect(scrollContainer?.classList.contains('has-more-below')).toBe(true);

    scrollContainer!.scrollTop = 140;
    scrollContainer!.dispatchEvent(new Event('scroll'));
    expect(scrollContainer?.classList.contains('has-more-below')).toBe(false);
  });

  it('renders fenced user prompt text as a scrollable code block', async () => {
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
    await vi.waitFor(() => {
      expect(container?.querySelector('.user-message-code-block .hljs-keyword')?.textContent).toBe(
        'const'
      );
    });
  });

  it('compacts standalone SVG prompt markup into a chip that opens in an editor', () => {
    const svg = '<svg viewBox="0 0 10 10">\n  <path d="M0 0h10v10z" />\n</svg>';
    const send = vi.fn();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    fixture<UnknownRecord>(window).__sendToExtension = send;
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-svg'),
          parts: [textPart('text-svg', svg)],
        }),
      container!
    );

    const chip = container?.querySelector('.user-message-format-chip');
    expect(chip?.textContent).toBe('SVG59 B');
    expect(chip?.getAttribute('data-copy-marker')).toBe(svg);
    expect(container?.querySelector('.user-message-text')?.textContent).not.toContain('<svg');

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (chip as HTMLButtonElement | null)?.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-text',
      payload: {
        content: svg,
        title: 'SVG user message',
        language: 'xml',
      },
    });
  });

  it('preserves prompt prose while compacting a trailing XML document', () => {
    const prompt = [
      'In input, change the agent chip icon to',
      '',
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<svg width="16px" height="16px" viewBox="0 0 24 24">',
      '  <rect x="2" y="21" width="7" height="5" />',
      '</svg>',
    ].join('\n');
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-prose-svg'),
          parts: [textPart('text-prose-svg', prompt)],
        }),
      container!
    );

    const messageText = container?.querySelectorAll('.user-message-text');
    expect(messageText).toHaveLength(2);
    expect(messageText?.[0]?.textContent).toBe('In input, change the agent chip icon to');
    expect(messageText?.[1]?.textContent).toBe('SVG143 B');
    expect(
      container?.querySelector('.user-message-format-chip')?.getAttribute('data-copy-marker')
    ).toBe(prompt.slice(prompt.indexOf('<?xml')));
    expect(container?.textContent).not.toContain('<rect');
  });

  it('leaves malformed markup as user prompt text', () => {
    const malformed = '<svg><path></svg>';
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-malformed-svg'),
          parts: [textPart('text-malformed-svg', malformed)],
        }),
      container!
    );

    expect(container?.querySelector('.user-message-format-chip')).toBeNull();
    expect(container?.querySelector('.user-message-text')?.textContent).toBe(malformed);
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
    expect(container?.querySelector('.user-message-card')?.classList).toContain(
      'user-message-card-wrapperless'
    );
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
    expect(children[0]?.textContent).toContain('spec.pdf');
    expect(children[0]?.querySelectorAll('.message-attachment-chip')).toHaveLength(2);
    expect(children[1]?.classList.contains('user-message-text-scroll')).toBe(true);
    expect(children[1]?.textContent).toContain('Please review this.');
    expect(children[2]?.classList.contains('chat-image-figure')).toBe(true);
    expect(children[2]?.querySelector('img')?.getAttribute('alt')).toBe('diagram.png');
    expect(children[2]?.querySelector('.chat-image-caption')).toBeNull();
  });

  it('keeps the user bubble when prose ends in a Git remote before an attachment', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-git-remote'),
          parts: [
            textPart(
              'text-prompt',
              'All JS should be strongly typed similar as in git@github.com:koltyakov/browser-bridge.git'
            ),
            textPart('text-file', '[Attached file: app.js]'),
          ],
        }),
      container!
    );

    const card = container?.querySelector('.user-message-card');
    expect(card?.classList).not.toContain('user-message-card-wrapperless');
    expect(card?.querySelector('.user-message-text')?.textContent).toContain(
      'All JS should be strongly typed similar as in git@github.com:koltyakov/browser-bridge.git'
    );
    expect(card?.querySelectorAll('.message-attachment-chip')).toHaveLength(1);
    expect(card?.querySelector('.message-attachment-chip')?.textContent).toContain('app.js');
  });

  it('expands a terminal-only message with its terminal name and line count', () => {
    const send = vi.fn();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    fixture<UnknownRecord>(window).__sendToExtension = send;
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-terminal-selection'),
          parts: [
            textPart(
              'text-terminal-selection',
              '[Selection from terminal zsh]\n```text\nnpm test\nfailed output\n```'
            ),
          ],
        }),
      container!
    );

    const terminalBlock = container?.querySelector('.user-message-terminal-code-block');
    expect(terminalBlock).toBeInstanceOf(HTMLDivElement);
    expect(terminalBlock?.querySelector('.code-block-lang')?.textContent).toBe('zsh');
    expect(terminalBlock?.querySelector('.code-block-detail')?.textContent).toBe('2 lines');
    expect(terminalBlock?.querySelector('code')?.textContent).toBe('npm test\nfailed output');
    expect(container?.querySelector('.message-attachment-chip')).toBeNull();
    expect(container?.querySelector('.user-message-card')?.classList).toContain(
      'user-message-card-wrapperless'
    );
    expect(send).not.toHaveBeenCalled();
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
    expect(container?.querySelector('.user-message-card')?.classList).not.toContain(
      'user-message-card-wrapperless'
    );
  });

  it('renders a sole inline attachment without a user bubble', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-single-inline-file'),
          parts: [textPart('text-1', '@README.md'), textPart('text-2', 'README.md')],
        }),
      container!
    );

    expect(container?.querySelector('.user-message-text')?.textContent).toBe('README.md');
    expect(container?.querySelectorAll('.user-message-text .inline-chip')).toHaveLength(1);
    expect(container?.querySelector('.message-attachments')).toBeNull();
    expect(container?.querySelector('.user-message-card')?.classList).toContain(
      'user-message-card-wrapperless'
    );
  });

  it('links workspace session IDs in user messages and leaves unknown IDs unchanged', () => {
    setAppState('sessions', [
      {
        id: 'ses_found123',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Permission request states',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-session-reference'),
          parts: [textPart('text-1', 'Session session:ses_found123 and session:ses_missing456')],
        }),
      container!
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.session-reference-link');
    expect(link?.textContent).toBe('Permission request states');
    expect(link?.getAttribute('href')).toBe('#session/ses_found123');
    expect(link?.dataset.copyMarker).toBe('session:ses_found123');
    expect(link?.querySelector('.session-reference-icon')).not.toBeNull();
    expect(link?.querySelector('.link-leading-content')?.textContent).toBe('Permission');
    expect(container?.textContent).toContain('session:ses_missing456');

    link?.click();
    expect(selectSessionMock).toHaveBeenCalledWith('ses_found123');
  });

  it('renders HTTPS URLs as icon-prefixed external links in user messages', () => {
    const send = vi.fn();
    // SAFETY: The fixture provides the unknown fields read by this statement.
    fixture<UnknownRecord>(window).__sendToExtension = send;
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-external-link'),
          parts: [
            textPart(
              'text-1',
              'See https://example.test/docs?q=(one), but not http://example.test/insecure.'
            ),
          ],
        }),
      container!
    );

    const link = container?.querySelector<HTMLAnchorElement>('a.external-link');
    expect(link?.getAttribute('href')).toBe('https://example.test/docs?q=(one)');
    expect(link?.getAttribute('data-external')).toBe('true');
    expect(link?.firstElementChild?.classList).toContain('link-leading-content');
    expect(link?.firstElementChild?.firstElementChild?.classList).toContain('external-link-icon');
    expect(link?.querySelector('.external-link-icon')).toBeInstanceOf(HTMLImageElement);
    expect(container?.querySelectorAll('a.external-link')).toHaveLength(1);
    expect(container?.querySelector('.user-message-text')?.textContent).toContain(
      '(one), but not http://example.test/insecure.'
    );

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-external',
      payload: { url: 'https://example.test/docs?q=(one)' },
    });
  });

  it('keeps one-line prose ending in a URL as message text', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-trailing-external-link'),
          parts: [textPart('text-1', 'Test message https://iconoir.com')],
        }),
      container!
    );

    expect(container?.querySelector('.message-attachments')).toBeNull();
    expect(container?.querySelector('.user-message-text')?.textContent).toBe(
      'Test message https://iconoir.com'
    );
    const links = container?.querySelectorAll<HTMLAnchorElement>('a.external-link');
    expect(links).toHaveLength(1);
    expect(links?.[0]?.getAttribute('href')).toBe('https://iconoir.com');
  });

  it('does not linkify URLs inside user message code fences', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-code-link'),
          parts: [textPart('text-1', '```text\nhttps://example.test/docs\n```')],
        }),
      container!
    );

    expect(container?.querySelector('.user-message-code-block code')?.textContent).toBe(
      'https://example.test/docs\n'
    );
    expect(container?.querySelector('a.external-link')).toBeNull();
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

  it('renders delegated vision files and agents as chips without exposing routing context', () => {
    const image = imageFilePart('image-1', '1786723794731-image-1');
    image.source = {
      text: {
        value: '{file:/tmp/varro-drops/drop-1/1786723794731-image-1}',
        start: 102,
        end: 162,
      },
      type: 'file',
      path: '/tmp/varro-drops/drop-1/1786723794731-image-1',
    };

    cleanup = render(
      () =>
        Message({
          info: userMessage('message-delegated-vision'),
          parts: [
            textPart('text-1', "What's on this image? [Image 1] @vision"),
            {
              id: 'agent-1',
              sessionID: 'session-1',
              messageID: 'message-1',
              type: 'agent',
              name: 'vision',
              source: { value: '@vision', start: 32, end: 39 },
            },
            textPart(
              'text-2',
              '[Image for @vision: /tmp/varro-drops/drop-1/1786723794731-image-1]\n' +
                'When calling the vision subagent, include {file:/tmp/varro-drops/drop-1/1786723794731-image-1} in its task prompt.'
            ),
            image,
          ],
        }),
      container!
    );

    expect(container?.querySelector('.user-message-text')?.textContent).toBe(
      "What's on this image? Image 1 Vision"
    );
    expect(container?.querySelectorAll('.user-message-text .inline-chip')).toHaveLength(2);
    expect(container?.textContent).not.toContain('When calling the vision subagent');
    expect(container?.querySelector('.chat-image-img')).toBeInstanceOf(HTMLImageElement);
  });

  it('renders known textual agent mentions as chips when no agent part is returned', () => {
    setAppState('allAgents', [
      {
        name: 'vision',
        mode: 'subagent',
        permission: [],
      },
    ]);
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-textual-agent'),
          parts: [textPart('text-1', "What's on the image? @vision")],
        }),
      container!
    );

    const chip = container?.querySelector('.user-message-text .inline-chip');
    expect(chip?.textContent).toBe('Vision');
    expect(chip?.getAttribute('data-copy-marker')).toBe('@vision');
  });

  it('renders the legacy Image placeholder as the Image 1 pill', () => {
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-legacy-inline-image'),
          parts: [textPart('text-1', 'Review [Image]'), imageFilePart('image-1', 'Image 1')],
        }),
      container!
    );

    const imageChip = container?.querySelector('.user-message-text .inline-chip');
    expect(imageChip?.textContent?.trim()).toBe('Image 1');
    expect(imageChip?.getAttribute('data-copy-marker')).toBe('[Image]');
  });

  it('renders OpenCode CLI image source markers as numbered pills', () => {
    const firstImage = imageFilePart('image-1', 'clipboard');
    firstImage.source = {
      text: { value: '[Image 1]', start: 0, end: 9 },
      type: 'file',
      path: 'clipboard',
    };
    const secondImage = imageFilePart('image-2', 'clipboard');
    secondImage.source = {
      text: { value: '[Image 2]', start: 10, end: 19 },
      type: 'file',
      path: 'clipboard',
    };

    cleanup = render(
      () =>
        Message({
          info: userMessage('message-cli-inline-images'),
          parts: [textPart('text-1', '[Image 1] [Image 2] Review these'), firstImage, secondImage],
        }),
      container!
    );

    const imageChips = container?.querySelectorAll('.user-message-text .inline-chip');
    expect(Array.from(imageChips ?? []).map((chip) => chip.textContent?.trim())).toEqual([
      'Image 1',
      'Image 2',
    ]);
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

    const overlayImage = document.body.querySelector<HTMLImageElement>('.chat-image-preview-img');
    const overlayCaption = document.body.querySelector('.chat-image-preview-caption');
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

    container?.querySelector<HTMLButtonElement>('.assistant-activity-summary')?.click();
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
  it('classifies complete XML and SVG documents without matching surrounding prose', () => {
    expect(getUserMessageMarkupFormat('<?xml version="1.0"?>\n<feed><item /></feed>')).toEqual({
      kind: 'xml',
      byteSize: 43,
    });
    expect(getUserMessageMarkupFormat('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toEqual({
      kind: 'svg',
      byteSize: 46,
    });
    expect(getUserMessageMarkupFormat('Render <svg></svg> here')).toBeNull();
  });

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

  it('includes the line count when terminal context is the only prompt content', () => {
    expect(
      getUserMessagePreviewText([
        textPart(
          'text-1',
          '[Selection from terminal zsh]\n```text\nnpm run test:e2e\n3 failed\n```'
        ),
      ])
    ).toBe('Terminal: zsh (2 lines)');
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
      textPart('text-1', '/Users/andrew/Downloads/report final 5397.pdf'),
    ]);

    expect(parsed.messageTexts).toEqual([]);
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

  it('keeps route-like slash-prefixed prose as text', () => {
    const parsed = parseUserMessageContent([
      textPart('text-1', '/service/v2/resources should paginate results.'),
    ]);

    expect(parsed.messageTexts).toEqual(['/service/v2/resources should paginate results.']);
    expect(parsed.attachments).toEqual([]);
  });

  it('keeps standalone extensionless slash-prefixed routes as text', () => {
    const parsed = parseUserMessageContent([textPart('text-1', '/service/v2/resources')]);

    expect(parsed.messageTexts).toEqual(['/service/v2/resources']);
    expect(parsed.attachments).toEqual([]);
  });

  it('keeps test output dividers and source locations as text', () => {
    const text = [
      'FAIL src/extension/open-code-process.test.ts > OpenCodeProcess',
      'src/extension/open-code-process.test.ts:585:58',
      '--------------------[1/3]--------------------',
    ].join('\n');
    const parsed = parseUserMessageContent([textPart('text-1', text)]);

    expect(parsed.messageTexts).toEqual([text]);
    expect(parsed.attachments).toEqual([]);
  });

  it('keeps file-like lines in audit output as text', () => {
    const text = [
      'NPM audit report results:',
      '{',
      '  "@eslint/config-array": {',
      '    "via": [',
      '      "minimatch"',
      '    ],',
      '    "nodes": [',
      '      "node_modules/@eslint/config-array"',
      '    ]',
      '  }',
      '}',
    ].join('\n');
    const parsed = parseUserMessageContent([textPart('text-1', text)]);

    expect(parsed.messageTexts).toEqual([text]);
    expect(parsed.attachments).toEqual([]);
  });

  it('rejects quoted dependency paths as standalone attachments', () => {
    const lines = [
      '"@eslint/config-array": {',
      '"@typescript-eslint/type-utils",',
      '"node_modules/@typescript-eslint/parser"',
      'typescript-eslint>minimatch',
    ];
    const parsed = parseUserMessageContent(
      lines.map((line, index) => textPart(`text-${index}`, line))
    );

    expect(parsed.messageTexts).toEqual(lines);
    expect(parsed.attachments).toEqual([]);
  });

  it('keeps relative folder lines in mixed text', () => {
    const parsed = parseUserMessageContent([textPart('text-1', 'See that\n\nsrc/')]);

    expect(parsed.messageTexts).toEqual(['See that\n\nsrc/']);
    expect(parsed.attachments).toEqual([]);
  });

  it('does not extract attachment lines from mixed user text', () => {
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

    expect(container?.querySelector('.message-attachments')).toBeNull();
    expect(container?.querySelector('.user-message-text')?.textContent).toBe(
      'Test\n\n/Users/andrew/Downloads/ПД Оккервиль ЛСТ Квартплата 5397.pdf'
    );
  });

  it('extracts explicit attached files from merged user text', () => {
    const parsed = parseUserMessageContent([
      textPart('text-1', 'Summarize this document\n[Attached file: /repo/spec.pdf]'),
    ]);

    expect(parsed.messageTexts).toEqual(['Summarize this document']);
    expect(parsed.attachments).toEqual([
      { type: 'file-reference', path: '/repo/spec.pdf', isDirectory: false },
    ]);

    cleanup = render(
      () =>
        Message({
          info: userMessage('message-attached-pdf-fallback'),
          parts: [
            textPart(
              'text-attached-pdf',
              'Summarize this document\n[Attached file: /repo/spec.pdf]'
            ),
          ],
        }),
      container!
    );

    expect(container?.querySelector('.message-attachments')?.textContent).toContain('spec.pdf');
    expect(container?.querySelector('.user-message-text')?.textContent).toBe(
      'Summarize this document'
    );
    expect(container?.textContent).not.toContain('[Attached file:');
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
  it('renders a system-formatted time under the user message', () => {
    const now = new Date();
    const created = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 13, 45);
    cleanup = render(
      () =>
        Message({
          info: { ...userMessage('message-timestamp-today'), time: { created: created.getTime() } },
          parts: [textPart('text-timestamp-today', 'Timestamped prompt')],
        }),
      container!
    );

    const timestamp = container?.querySelector<HTMLTimeElement>('.message-sent-time');
    expect(timestamp?.classList.contains('is-visible')).toBe(true);
    expect(timestamp?.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(created)
    );
    expect(timestamp?.dateTime).toBe(created.toISOString());
  });

  it('renders the completion time under the assistant response', () => {
    const created = new Date(2026, 0, 2, 10, 0).getTime();
    const completed = created + 42 * 60 * 1000;
    cleanup = render(
      () =>
        Message({
          info: { ...assistantMessage('assistant-timestamp'), time: { created, completed } },
          parts: [textPart('text-assistant-timestamp', 'A response')],
          isTurnEndAssistant: true,
        }),
      container!
    );

    const timestamp = container?.querySelector<HTMLTimeElement>('.message-sent-time');
    expect(timestamp?.classList.contains('is-visible')).toBe(true);
    expect(timestamp?.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(
        new Date(completed)
      )
    );
    expect(timestamp?.dateTime).toBe(new Date(completed).toISOString());
  });

  it('includes the system-formatted date for messages sent before today', () => {
    const now = new Date();
    const created = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2, 13, 45);
    cleanup = render(
      () =>
        Message({
          info: { ...userMessage('message-timestamp-older'), time: { created: created.getTime() } },
          parts: [textPart('text-timestamp-older', 'Older prompt')],
        }),
      container!
    );

    expect(container?.querySelector('.message-sent-time')?.textContent).toBe(
      new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(created)
    );
  });

  it('hides the request timestamp when request timestamps are disabled', () => {
    setShowRequestTimestamps(false);
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-timestamp-hidden-request'),
          parts: [textPart('text-timestamp-hidden-request', 'Prompt')],
        }),
      container!
    );
    const timestamp = container?.querySelector<HTMLTimeElement>('.message-sent-time');
    expect(timestamp?.classList.contains('is-visible')).toBe(false);

    setShowRequestTimestamps(true);
    expect(timestamp?.classList.contains('is-visible')).toBe(true);
  });

  it('hides response timestamps when response timestamps are disabled', () => {
    setShowResponseTimestamps(false);
    cleanup = render(
      () =>
        Message({
          info: { ...assistantMessage('assistant-timestamp-off'), time: { created: 0, completed: 1 } },
          parts: [textPart('text-timestamp-off', 'A response')],
          isTurnEndAssistant: true,
        }),
      container!
    );
    const timestamp = container?.querySelector<HTMLTimeElement>('.message-sent-time');
    expect(timestamp?.classList.contains('is-visible')).toBe(false);
  });

  it('hides the response timestamp on intermediate steps in turn-end mode', () => {
    cleanup = render(
      () =>
        Message({
          info: {
            ...assistantMessage('assistant-mid-step'),
            time: { created: 0, completed: 1 },
          },
          parts: [textPart('text-mid-step', 'A step')],
        }),
      container!
    );
    const timestamp = container?.querySelector<HTMLTimeElement>('.message-sent-time');
    expect(timestamp?.classList.contains('is-visible')).toBe(false);

    cleanup?.();
    cleanup = render(
      () =>
        Message({
          info: {
            ...assistantMessage('assistant-mid-step-again'),
            time: { created: 0, completed: 1 },
          },
          parts: [textPart('text-mid-step-again', 'A step')],
          isTurnEndAssistant: true,
        }),
      container!
    );
    expect(
      container?.querySelector<HTMLTimeElement>('.message-sent-time')?.classList.contains(
        'is-visible'
      )
    ).toBe(true);
  });

  it('hides the turn-end response timestamp while the final step is still streaming', () => {
    cleanup = render(
      () =>
        Message({
          info: {
            ...assistantMessage('assistant-streaming-final'),
            time: { created: 0 },
          },
          parts: [textPart('text-streaming-final', 'In progress')],
          isTurnEndAssistant: true,
        }),
      container!
    );
    const timestamp = container?.querySelector<HTMLTimeElement>('.message-sent-time');
    expect(timestamp?.classList.contains('is-visible')).toBe(false);
  });

  it('shows the turn-end response timestamp when the final step ends in an error', () => {
    cleanup = render(
      () =>
        Message({
          info: {
            ...assistantMessage('assistant-error-final'),
            time: { created: 0 },
            error: { name: 'UnknownError', data: { message: 'boom' } },
          },
          parts: [textPart('text-error-final', 'Failed step')],
          isTurnEndAssistant: true,
        }),
      container!
    );
    expect(
      container?.querySelector<HTMLTimeElement>('.message-sent-time')?.classList.contains(
        'is-visible'
      )
    ).toBe(true);
  });

  it('shows response timestamps on every step in each-step mode', () => {
    setResponseTimestamp('each-step');
    cleanup = render(
      () =>
        Message({
          info: {
            ...assistantMessage('assistant-each-step'),
            time: { created: 0, completed: 1 },
          },
          parts: [textPart('text-each-step', 'A step')],
        }),
      container!
    );
    expect(
      container?.querySelector<HTMLTimeElement>('.message-sent-time')?.classList.contains(
        'is-visible'
      )
    ).toBe(true);
  });

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

  it('renders one responsive-chat notice for an omitted change set', () => {
    cleanup = render(
      () =>
        Message({
          info: {
            ...userMessage('message-large-change-set'),
            summary: { diffs: [], diffsOmitted: true, diffsTruncated: true },
          },
          parts: [textPart('text-large-change-set', 'Update the infrastructure')],
        }),
      container!
    );

    const notice = container?.querySelector('.change-set-omission');
    expect(notice?.textContent).toContain('Large change set condensed');
    expect(notice?.textContent).toContain(
      'File-by-file events were omitted to keep this chat responsive.'
    );
    expect(notice?.textContent).not.toContain('+0');
    expect(notice?.textContent).not.toContain('-0');
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

describe('getUserMessageEditText', () => {
  it('keeps prompt text and standalone file references while skipping context parts', () => {
    const editText = getUserMessageEditText([
      textPart('text-1', 'fix the failing test'),
      textPart('text-2', '[Working directory: /repo]'),
      textPart('text-3', '[Active file: src/index.ts]'),
      textPart('text-4', '[Selection from src/index.ts:1-3]'),
      textPart('text-5', 'src/utils/helper.ts'),
    ]);

    expect(editText).toBe('fix the failing test\nsrc/utils/helper.ts');
  });

  it('skips terminal selection blocks and non-text parts', () => {
    const editText = getUserMessageEditText([
      textPart('text-1', '[Selection from terminal zsh]\n```text\nnpm test\n```'),
      imageFilePart('file-1', 'screenshot.png'),
      textPart('text-2', 'why does this fail?'),
    ]);

    expect(editText).toBe('why does this fail?');
  });
});

describe('getUserMessageEditContext', () => {
  it('restores added files, terminal selections, and images', () => {
    const context = getUserMessageEditContext([
      textPart('text-1', 'src/app.ts'),
      textPart('text-2', '[Selection from src/main.ts lines 2-4]'),
      textPart('text-3', '[Selection from terminal zsh]\n```text\nnpm test\n```'),
      {
        id: 'file-image-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'file',
        mime: 'image/png',
        filename: 'screenshot.png',
        url: 'blob:image-1',
      },
    ]);

    expect(context).toEqual({
      files: [
        { path: 'src/app.ts', relativePath: 'src/app.ts', type: 'file', lineRanges: undefined },
        {
          path: 'src/main.ts',
          relativePath: 'src/main.ts',
          type: 'file',
          lineRanges: [{ startLine: 2, endLine: 4 }],
        },
      ],
      images: [
        {
          id: 'file-image-1',
          url: 'blob:image-1',
          mime: 'image/png',
          filename: 'screenshot.png',
          size: 0,
        },
      ],
      terminalSelection: { terminalName: 'zsh', text: 'npm test' },
    });
  });

  it('deduplicates files when reconstructing edited message context', () => {
    const context = getUserMessageEditContext([
      textPart('text-1', 'src/app.ts'),
      textPart('text-2', 'src/app.ts'),
      textPart('text-3', '[Selection from src/main.ts lines 2-4]'),
      textPart('text-4', '[Selection from src/main.ts lines 6-8]'),
    ]);

    expect(context.files).toEqual([
      { path: 'src/app.ts', relativePath: 'src/app.ts', type: 'file', lineRanges: undefined },
      {
        path: 'src/main.ts',
        relativePath: 'src/main.ts',
        type: 'file',
        lineRanges: [
          { startLine: 2, endLine: 4 },
          { startLine: 6, endLine: 8 },
        ],
      },
    ]);
  });
});

describe('Message user editing', () => {
  function renderEditableUserMessage(messageId = 'message-edit') {
    setAppState('activeSessionId', 'session-1');
    cleanup = render(
      () =>
        Message({
          info: userMessage(messageId),
          parts: [
            {
              id: 'text-edit',
              sessionID: 'session-1',
              messageID: messageId,
              type: 'text',
              text: 'original prompt',
            },
            {
              id: 'text-edit-cwd',
              sessionID: 'session-1',
              messageID: messageId,
              type: 'text',
              text: '[Working directory: /repo]',
            },
          ],
        }),
      container!
    );
  }

  afterEach(() => {
    setAppState('activeSessionId', null);
    setAppState('sessions', []);
    setAppState('sessionStatus', {});
    resetMessageEditState();
  });

  it('starts a composer edit with the message text on click and highlights the target', () => {
    renderEditableUserMessage();

    window.getSelection()?.removeAllRanges();
    const card = container?.querySelector<HTMLElement>('.user-message-card');
    expect(card?.classList.contains('user-message-card-editable')).toBe(true);
    expect(card?.hasAttribute('title')).toBe(false);

    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toEqual({
      messageId: 'message-edit',
      sessionId: 'session-1',
      text: 'original prompt',
      context: { files: [], images: [], terminalSelection: null },
      model: { providerID: 'provider-1', modelID: 'model-1' },
    });
    expect(card?.classList.contains('user-message-card-editable')).toBe(false);
    expect(container?.textContent).toContain('original prompt');
  });

  it('starts a composer edit for image-only user messages', () => {
    setAppState('activeSessionId', 'session-1');
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-image-only'),
          parts: [imageFilePart('file-image-1', 'screenshot.png')],
        }),
      container!
    );

    window.getSelection()?.removeAllRanges();
    const card = container?.querySelector<HTMLElement>('.user-message-card');
    expect(card?.classList.contains('user-message-card-editable')).toBe(true);
    expect(card?.classList.contains('user-message-card-wrapperless')).toBe(true);

    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(editingMessage()).toEqual({
      messageId: 'message-image-only',
      sessionId: 'session-1',
      text: '',
      context: {
        files: [],
        images: [
          {
            id: 'file-image-1',
            url: 'https://example.test/file-image-1.png',
            mime: 'image/png',
            filename: 'screenshot.png',
            size: 0,
          },
        ],
        terminalSelection: null,
      },
      model: { providerID: 'provider-1', modelID: 'model-1' },
    });
  });

  it('edits from a terminal header and opens terminal content from its body', () => {
    const send = vi.fn();
    fixture<UnknownRecord>(window).__sendToExtension = send;
    setAppState('activeSessionId', 'session-1');
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-terminal-edit'),
          parts: [
            textPart(
              'text-terminal-edit',
              '[Selection from terminal zsh]\n```text\nnpm test\nfailed output\n```'
            ),
          ],
        }),
      container!
    );

    window.getSelection()?.removeAllRanges();
    container?.querySelector<HTMLElement>('pre.code-block')?.click();
    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-text',
      payload: {
        content: 'npm test\nfailed output',
        title: 'zsh terminal selection',
        language: 'shellscript',
      },
    });
    expect(editingMessage()).toBeNull();

    container?.querySelector<HTMLElement>('.code-block-header')?.click();
    expect(editingMessage()).toMatchObject({
      messageId: 'message-terminal-edit',
      sessionId: 'session-1',
      context: {
        terminalSelection: { terminalName: 'zsh', text: 'npm test\nfailed output' },
      },
    });
  });

  it('does not offer editing when the message belongs to another session', () => {
    setAppState('activeSessionId', 'session-2');
    cleanup = render(
      () =>
        Message({
          info: userMessage('message-other-session'),
          parts: [
            {
              id: 'text-other-session',
              sessionID: 'session-1',
              messageID: 'message-other-session',
              type: 'text',
              text: 'original prompt',
            },
          ],
        }),
      container!
    );

    const card = container?.querySelector<HTMLElement>('.user-message-card');
    expect(card?.classList.contains('user-message-card-editable')).toBe(false);

    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editingMessage()).toBeNull();
  });

  it('does not offer editing while the active session is working', () => {
    setAppState('sessionStatus', { 'session-1': { type: 'busy' } });
    renderEditableUserMessage();

    const card = container?.querySelector<HTMLElement>('.user-message-card');
    expect(card?.classList.contains('user-message-card-editable')).toBe(false);

    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editingMessage()).toBeNull();
  });

  it('does not offer editing in a managed sub-agent session', () => {
    setAppState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        parentID: 'parent',
        title: 'Child session',
        version: '1',
        time: { created: 0, updated: 1 },
      },
    ]);
    renderEditableUserMessage();

    const card = container?.querySelector<HTMLElement>('.user-message-card');
    expect(card?.classList.contains('user-message-card-editable')).toBe(false);

    card?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(editingMessage()).toBeNull();
  });
});

describe('Message streamed assistant text rendering', () => {
  it('keeps a linked pending question visible outside the active activity tray', () => {
    const questionTool: ToolPart = {
      ...toolPart('question-tool', {
        status: 'running',
        input: { questions: [] },
        time: { start: 1 },
      }),
      tool: 'question',
    };

    cleanup = render(
      () =>
        Message({
          info: { ...assistantMessage('message-1'), time: { created: 0 } },
          parts: [questionTool],
          visibleActiveActivityPartKeys: new Set(),
          questionRequestForTool: (part) =>
            part.id === questionTool.id
              ? {
                  id: 'question-request',
                  sessionID: 'session-1',
                  questions: [
                    {
                      question: 'Which option?',
                      header: 'Choose',
                      options: [{ label: 'One', description: 'First option' }],
                    },
                  ],
                  tool: { messageID: questionTool.messageID, callID: questionTool.callID },
                }
              : null,
        }),
      container!
    );

    expect(container?.querySelector('.question-prompt-card')).toBeInstanceOf(HTMLDivElement);
  });

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
    // Streaming thinking auto-expands so the streamed delta is visible.
    expect(
      container?.querySelector<HTMLButtonElement>('.thinking-header')?.getAttribute('aria-expanded')
    ).toBe('true');
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

  it('marks completed text from the streaming buffer as the final answer', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-stream-final'),
          parts: [textPart('text-1', '')],
          streamingPartId: 'text-1',
          streamingText: 'Implemented the fix.',
          highlightFinalAnswer: true,
        }),
      container!
    );

    const finalItem = container?.querySelector('.assistant-message-flow-item-final');
    expect(finalItem).toBeInstanceOf(HTMLDivElement);
    expect(finalItem?.textContent).toContain('Implemented the fix.');
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
  it('observes only the compact message flow for normal-sized assistant turns', async () => {
    const host = document.createElement('div');
    host.className = 'interactive-list';
    host.appendChild(container!);
    document.body.appendChild(host);

    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-normal-observers'),
          parts: [
            reasoningPart('reason-1', 'Inspecting', true),
            toolPart('tool-1', {
              status: 'completed',
              input: { command: 'pwd' },
              output: '/workspace',
              title: 'Inspect cwd',
              time: { start: 1, end: 2 },
              metadata: {},
            }),
            textPart('text-1', 'Status update.'),
            textPart('text-2', 'Final answer.'),
          ],
          highlightFinalAnswer: true,
        }),
      container!
    );

    await Promise.resolve();

    expect(resizeObserverObserveMock).toHaveBeenCalledTimes(1);
    expect(resizeObserverObserveMock).toHaveBeenCalledWith(
      container?.querySelector('.assistant-message-flow'),
      undefined
    );

    host.remove();
  });

  it('shows the read mode toggle for large final answers only while Alt is pressed', () => {
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

    pressAlt();

    const toggle = container?.querySelector<HTMLButtonElement>('.assistant-read-mode-toggle');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);

    releaseAlt();
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

    pressAlt();

    const toggle = container?.querySelector<HTMLButtonElement>('.assistant-read-mode-toggle');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);

    toggle?.click();

    const overlay = document.querySelector('.assistant-read-overlay');
    const overlayContent = document.querySelector('.assistant-read-mode-content');

    expect(overlay).toBeInstanceOf(HTMLDivElement);
    expect(container?.contains(overlay!)).toBe(false);
    expect(document.body.classList.contains('chat-read-mode-open')).toBe(true);
    expect(overlayContent?.textContent).toContain('Final answer for reading.');
    expect(overlayContent?.textContent).not.toContain('Status update.');
    expect(overlayContent?.textContent).not.toContain('Thinking');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.querySelector('.assistant-read-overlay')).toBeNull();
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

  it('scales the final mark pulse duration with the rail height', async () => {
    const [info, setInfo] = createSignal({
      ...assistantMessage('message-final-pulse'),
      time: { created: 0 },
    });
    const [highlightFinalAnswer, setHighlightFinalAnswer] = createSignal(false);

    cleanup = render(
      () =>
        Message({
          get info() {
            return info();
          },
          parts: [textPart('text-final-pulse', 'Final answer.')],
          get highlightFinalAnswer() {
            return highlightFinalAnswer();
          },
        }),
      container!
    );

    expect(container?.querySelector('.assistant-final-mark-pulse')).toBeNull();

    const getBoundingClientRect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const height = this.classList.contains('assistant-message-flow-item-final') ? 400 : 0;
        return DOMRect.fromRect({ height });
      });
    setInfo(assistantMessage('message-final-pulse'));
    setHighlightFinalAnswer(true);
    await Promise.resolve();
    getBoundingClientRect.mockRestore();

    const pulse = container?.querySelector<HTMLElement>('.assistant-final-mark-pulse');
    expect(pulse).toBeInstanceOf(HTMLDivElement);
    expect(pulse?.style.getPropertyValue('--assistant-final-mark-pulse-duration')).toBe('2400ms');
    expect(container?.querySelector('.assistant-message-flow-item-final')).toBeInstanceOf(
      HTMLDivElement
    );

    const animationEnd = new Event('animationend', { bubbles: true });
    Object.defineProperty(animationEnd, 'animationName', { value: 'assistant-final-mark-pulse' });
    container?.querySelector('.assistant-message-flow-item-final')?.dispatchEvent(animationEnd);
    await Promise.resolve();

    expect(container?.querySelector('.assistant-final-mark-pulse')).toBeNull();
    expect(pulse?.style.getPropertyValue('--assistant-final-mark-pulse-duration')).toBe('');
  });

  it('does not pulse an existing final response when a follow-up changes its highlight', () => {
    const [info, setInfo] = createSignal({
      ...assistantMessage('message-final-follow-up'),
      time: { created: 0 },
    });
    const [highlightFinalAnswer, setHighlightFinalAnswer] = createSignal(false);

    cleanup = render(
      () =>
        Message({
          get info() {
            return info();
          },
          parts: [textPart('text-final-follow-up', 'Existing final answer.')],
          get highlightFinalAnswer() {
            return highlightFinalAnswer();
          },
        }),
      container!
    );

    setInfo(assistantMessage('message-final-follow-up'));
    setHighlightFinalAnswer(true);
    expect(container?.querySelector('.assistant-final-mark-pulse')).toBeInstanceOf(HTMLDivElement);

    setHighlightFinalAnswer(false);
    setHighlightFinalAnswer(true);

    expect(container?.querySelector('.assistant-message-flow-item-final')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(container?.querySelector('.assistant-final-mark-pulse')).toBeNull();
  });

  it('does not replay the final mark pulse for an already completed response', () => {
    cleanup = render(
      () =>
        Message({
          info: assistantMessage('message-final-restored'),
          parts: [textPart('text-final-restored', 'Restored final answer.')],
          highlightFinalAnswer: true,
        }),
      container!
    );

    expect(container?.querySelector('.assistant-message-flow-item-final')).toBeInstanceOf(
      HTMLDivElement
    );
    expect(container?.querySelector('.assistant-final-mark-pulse')).toBeNull();
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
    expect(container?.querySelector('.assistant-activity-summary')).toBeInstanceOf(
      HTMLButtonElement
    );
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
    const thinkingItem = container?.querySelector('.chat-thinking-box');
    const finalItem = container?.querySelector('.assistant-message-flow-item-final-planning');

    expect(plainContainer).toBeInstanceOf(HTMLDivElement);
    expect(container?.textContent).toContain('Inspecting');
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
    const thinkingItem = container?.querySelector('.chat-thinking-box');
    const finalItem = container?.querySelector('.assistant-message-flow-item-final');

    expect(plainContainer).toBeInstanceOf(HTMLDivElement);
    expect(container?.textContent).toContain('Inspecting');
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
    const card = container?.querySelector('.user-message-card');
    expect(trigger).toBeInstanceOf(HTMLButtonElement);
    expect(trigger?.hasAttribute('title')).toBe(false);
    expect(card?.hasAttribute('title')).toBe(false);

    trigger?.click();

    const overlay = document.body.querySelector('.chat-image-preview-overlay');
    const overlayImage = document.body.querySelector<HTMLImageElement>('.chat-image-preview-img');

    expect(overlay).toBeInstanceOf(HTMLDivElement);
    expect(document.body.classList.contains('chat-image-preview-open')).toBe(true);
    expect(overlayImage?.getAttribute('src')).toBe('https://example.test/image-1.png');
    expect(document.body.querySelector('.chat-image-preview-caption')?.textContent).toContain(
      'diagram.png'
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(document.body.querySelector('.chat-image-preview-overlay')).toBeNull();
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
    expect(trigger?.hasAttribute('title')).toBe(false);
    trigger?.click();

    const overlayImage = document.body.querySelector<HTMLImageElement>('.chat-image-preview-img');
    const overlayCaption = document.body.querySelector('.chat-image-preview-caption');

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
      document.body.querySelectorAll<HTMLButtonElement>('.chat-image-preview-nav')[1];
    expect(nextOverlayButton).toBeInstanceOf(HTMLButtonElement);

    nextOverlayButton?.click();

    let overlayImage = document.body.querySelector<HTMLImageElement>('.chat-image-preview-img');
    let overlayCaption = document.body.querySelector('.chat-image-preview-caption');

    expect(overlayImage?.getAttribute('src')).toBe('https://example.test/image-2.png');
    expect(overlayCaption?.textContent).toContain('2 / 2');
    expect(overlayCaption?.textContent).toContain('Image 2');
    expect(container?.querySelector('.message-image-carousel-caption-row')?.textContent).toContain(
      '2 / 2'
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));

    overlayImage = document.body.querySelector<HTMLImageElement>('.chat-image-preview-img');
    overlayCaption = document.body.querySelector('.chat-image-preview-caption');

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

    const retryButton = container?.querySelector<HTMLButtonElement>(
      '.assistant-message-flow-item-error-action'
    );

    expect(retryButton).toBeInstanceOf(HTMLButtonElement);
    expect(retryButton?.textContent).toContain('Retry');

    retryButton?.click();

    expect(retryMessageMock).toHaveBeenCalledWith('message-3', 'session-1');
  });

  it('hides the latest usage-limit error card while the usage-limit banner is active', async () => {
    const { setState, setSessionUsageLimit } = await import('../lib/state');
    const { parseUsageLimitNotice } = await import('../lib/usage-limit');
    const assistant = {
      ...assistantMessage('message-3'),
      error: {
        name: 'server_error',
        data: { message: '429 usage limit reached. retry in 45s attempt #2' },
      },
    };

    setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'session-1',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);
    setState('messages', [{ info: assistant, parts: [reasoningPart('reason-1', 'Inspecting')] }]);
    setSessionUsageLimit(
      'session-1',
      parseUsageLimitNotice('429 usage limit reached. retry in 45s attempt #2')!
    );

    try {
      cleanup = render(
        () =>
          Message({
            info: assistant,
            parts: [reasoningPart('reason-1', 'Inspecting')],
            isLastAssistant: true,
          }),
        container!
      );

      expect(container?.querySelector('.assistant-message-flow-item-error')).toBeNull();

      setSessionUsageLimit('session-1', null);

      const errorBlock = container?.querySelector('.assistant-message-flow-item-error');
      expect(errorBlock?.textContent).toContain('429 usage limit reached');
    } finally {
      setSessionUsageLimit('session-1', null);
      setState('sessions', []);
      setState('messages', []);
    }
  });

  it('explains a logged-out provider and runs re-authentication', async () => {
    const { setState } = await import('../lib/state');
    const assistant = {
      ...assistantMessage('message-3'),
      error: {
        name: 'ProviderAuthError',
        data: {
          providerID: 'github-copilot',
          message: 'Token refresh failed: 401',
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

    const errorBlock = container?.querySelector('.assistant-message-flow-item-error');
    const reauthenticateButton = container?.querySelector<HTMLButtonElement>(
      '.assistant-message-flow-item-error-action'
    );

    expect(errorBlock?.textContent).toContain(
      'You are signed out of this provider. Re-authenticate to continue.'
    );
    expect(errorBlock?.textContent).not.toContain('Token refresh failed: 401');
    expect(reauthenticateButton).toBeInstanceOf(HTMLButtonElement);
    expect(reauthenticateButton?.textContent).toContain('Re-authenticate');

    reauthenticateButton?.click();

    expect(providerConnectionRequest()?.providerID).toBe('github-copilot');
    expect(providerRequiresReconnection('github-copilot')).toBe(true);
    expect(showSettings()).toBe(false);
    expect(retryMessageMock).not.toHaveBeenCalled();

    resolveProviderAuthFailure('github-copilot');

    expect(errorBlock?.textContent).toContain(
      'Authentication restored. Send a new prompt to continue.'
    );
    expect(container?.querySelector('.assistant-message-flow-item-error-action')).toBeNull();
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
