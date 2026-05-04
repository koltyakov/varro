import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { resetDefaultAppState, setIsLoading } from '../../lib/state';
import type { AssistantMessage, Part, TextPart, ToolPart } from '../../types';
import { AssistantMessageContent, deduplicateFileEdits } from './AssistantMessageContent';

type MockMarkdownRendererProps = {
  content: string;
  cacheByContent?: boolean;
};

type MockMessagePartProps = {
  part: Part;
  messageInfo?: AssistantMessage;
  streamedText?: string | null;
};

const markdownRendererMock = vi.hoisted(() =>
  vi.fn((props: MockMarkdownRendererProps) => (
    <div
      class="markdown-renderer-mock"
      data-cache-by-content={props.cacheByContent ? 'true' : 'false'}
    >
      {props.content}
    </div>
  ))
);

const messagePartMock = vi.hoisted(() =>
  vi.fn((props: MockMessagePartProps) => (
    <div class="message-part-mock" data-part-id={props.part.id} data-part-type={props.part.type}>
      {props.streamedText ??
        (props.part.type === 'text' || props.part.type === 'reasoning'
          ? props.part.text
          : props.part.type)}
    </div>
  ))
);

vi.mock('../MarkdownRenderer', () => ({
  MarkdownRenderer: (props: MockMarkdownRendererProps) => markdownRendererMock(props),
}));

vi.mock('../MessagePart', () => ({
  MessagePart: (props: MockMessagePartProps) => messagePartMock(props),
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

type AssistantMessageContentProps = Parameters<typeof AssistantMessageContent>[0];

function createAssistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  const base: AssistantMessage = {
    id: 'assistant-1',
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 0, completed: 1 },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
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

  return {
    ...base,
    ...overrides,
    time: overrides.time ?? base.time,
    path: overrides.path ?? base.path,
    tokens: overrides.tokens ?? base.tokens,
  };
}

function textPart(id: string, text: string): TextPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'text',
    text,
  };
}

function completedToolState(
  input: Record<string, unknown>,
  title: string
): Extract<ToolPart['state'], { status: 'completed' }> {
  return {
    status: 'completed',
    input,
    output: 'ok',
    title,
    metadata: {},
    time: { start: 0, end: 1 },
  };
}

function fileEditPart(id: string, path: string): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: `call-${id}`,
    tool: 'write',
    state: completedToolState({ path }, `updated ${path}`),
  };
}

function renderAssistantMessageContent(props: Partial<AssistantMessageContentProps> = {}) {
  const merged: AssistantMessageContentProps = {
    info: createAssistantMessage(),
    parts: [],
    errorMessage: null,
    onRetry: undefined,
    highlightFinalAnswer: false,
    highlightPlanningAnswer: false,
    suppressHighlightedCardMetaParts: false,
    textForPart: (part) => (part.type === 'text' || part.type === 'reasoning' ? part.text : null),
    ...props,
  };

  cleanup = render(() => AssistantMessageContent(merged), container!);
  return merged;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  resetDefaultAppState();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  document.body.classList.remove('chat-read-mode-open');
  markdownRendererMock.mockClear();
  messagePartMock.mockClear();
  resetDefaultAppState();
});

function createManyTextParts(count: number): Part[] {
  return Array.from({ length: count }, (_, index) =>
    textPart(`text-${index + 1}`, `Paragraph ${index + 1}`)
  );
}

describe('deduplicateFileEdits', () => {
  it('keeps only the last file edit in each consecutive duplicate run', () => {
    const initial = textPart('text-1', 'Status update');
    const duplicateA = fileEditPart('edit-1', 'src/app.ts');
    const duplicateB = fileEditPart('edit-2', 'src/app.ts');
    const separated = textPart('text-2', 'Separator');
    const laterDuplicate = fileEditPart('edit-3', 'src/app.ts');

    expect(
      deduplicateFileEdits([initial, duplicateA, duplicateB, separated, laterDuplicate]).map(
        (part) => part.id
      )
    ).toEqual(['text-1', 'edit-2', 'text-2', 'edit-3']);
  });
});

describe('AssistantMessageContent', () => {
  it('filters highlighted-card meta text using effective text and opens read mode for the final answer', async () => {
    const filteredPart = textPart('text-1', 'Visible before text rewrite');
    const finalPart = textPart(
      'text-2',
      [
        'Final answer for read mode.',
        'This line makes the answer long enough to expose the read mode affordance.',
        'Another line keeps the final text clearly above the threshold.',
        'Only the final answer should appear in the overlay.',
        'Earlier meta text should stay filtered out.',
        'The overlay should close with Escape.',
        'The body class also needs to be toggled while open.',
        'This final sentence keeps the text comfortably beyond the cutoff.',
      ].join('\n')
    );

    renderAssistantMessageContent({
      parts: [filteredPart, finalPart],
      highlightFinalAnswer: true,
      suppressHighlightedCardMetaParts: true,
      textForPart: (part) => {
        if (part.id === filteredPart.id) return '[Working directory: /workspace]';
        return part.type === 'text' ? part.text : null;
      },
    });

    expect(container?.querySelectorAll('.message-part-mock')).toHaveLength(1);
    expect(container?.querySelector('[data-part-id="text-1"]')).toBeNull();

    const toggle = container?.querySelector('.assistant-read-mode-toggle');
    expect(toggle).toBeInstanceOf(HTMLButtonElement);

    (toggle as HTMLButtonElement).click();

    await vi.waitFor(() => {
      expect(container?.querySelector('.assistant-read-overlay')).toBeInstanceOf(HTMLDivElement);
    });

    expect(document.body.classList.contains('chat-read-mode-open')).toBe(true);
    expect(container?.querySelector('.assistant-read-mode-content')?.textContent).toContain(
      'Final answer for read mode.'
    );
    expect(container?.querySelector('.assistant-read-mode-content')?.textContent).not.toContain(
      '[Working directory: /workspace]'
    );

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    await vi.waitFor(() => {
      expect(container?.querySelector('.assistant-read-overlay')).toBeNull();
    });

    expect(document.body.classList.contains('chat-read-mode-open')).toBe(false);
  });

  it('groups consecutive file edits into a single stack container', () => {
    renderAssistantMessageContent({
      parts: [fileEditPart('edit-1', 'src/one.ts'), fileEditPart('edit-2', 'src/two.ts')],
    });

    const stack = container?.querySelector('.assistant-file-edit-stack');

    expect(stack).toBeInstanceOf(HTMLDivElement);
    expect(stack?.querySelectorAll('.message-part-mock')).toHaveLength(2);
    expect(container?.querySelectorAll('[data-assistant-render-key]')).toHaveLength(1);
  });

  it('renders retry actions for assistant errors and disables them while loading', () => {
    const onRetry = vi.fn();
    setIsLoading(true);

    renderAssistantMessageContent({
      errorMessage: 'Request failed',
      onRetry,
    });

    const button = container?.querySelector<HTMLButtonElement>(
      '.assistant-message-flow-item-error-action'
    );

    expect(container?.textContent).toContain('Request failed');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect(button?.disabled).toBe(true);

    button?.click();

    expect(onRetry).not.toHaveBeenCalled();
  });

  it('keeps the active last assistant message fully rendered even when it has many parts', () => {
    renderAssistantMessageContent({
      parts: createManyTextParts(45),
      isLastAssistant: true,
    });

    expect(container?.querySelectorAll('[data-assistant-render-key]')).toHaveLength(45);
  });

  it('still virtualizes non-last assistant messages with many parts', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const interactiveList = document.createElement('div');
      interactiveList.className = 'interactive-list';
      Object.defineProperty(interactiveList, 'clientHeight', { configurable: true, value: 240 });
      container?.appendChild(interactiveList);

      cleanup = render(
        () =>
          AssistantMessageContent({
            info: createAssistantMessage(),
            parts: createManyTextParts(45),
            errorMessage: null,
            onRetry: undefined,
            highlightFinalAnswer: false,
            highlightPlanningAnswer: false,
            suppressHighlightedCardMetaParts: false,
            isLastAssistant: false,
            textForPart: (part) =>
              part.type === 'text' || part.type === 'reasoning' ? part.text : null,
          }),
        interactiveList
      );

      expect(container?.querySelectorAll('[data-assistant-render-key]').length).toBeLessThan(45);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it('keeps assistant parts fully rendered when the outer message list is virtualized', () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      const interactiveList = document.createElement('div');
      interactiveList.className = 'interactive-list';
      Object.defineProperty(interactiveList, 'clientHeight', { configurable: true, value: 240 });
      container?.appendChild(interactiveList);

      cleanup = render(
        () =>
          AssistantMessageContent({
            info: createAssistantMessage(),
            parts: createManyTextParts(45),
            errorMessage: null,
            onRetry: undefined,
            highlightFinalAnswer: false,
            highlightPlanningAnswer: false,
            suppressHighlightedCardMetaParts: false,
            isLastAssistant: false,
            outerListVirtualized: true,
            textForPart: (part) =>
              part.type === 'text' || part.type === 'reasoning' ? part.text : null,
          }),
        interactiveList
      );

      expect(container?.querySelectorAll('[data-assistant-render-key]')).toHaveLength(45);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
