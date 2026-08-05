import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import {
  resetDefaultAppState,
  setCompactToolOutput,
  setIsLoading,
  setShowInlineFileChanges,
} from '../../lib/state';
import { resetToolCallExpansionState } from '../../lib/tool-call-expansion-state';
import type { AssistantMessage, Part, ReasoningPart, TextPart, ToolPart } from '../../types';
import {
  AssistantMessageContent,
  deduplicateFileEdits,
  getFileEditStackRenderKey,
} from './AssistantMessageContent';

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

function toolPart(id: string, tool: string, input: Record<string, unknown> = {}): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: completedToolState(input, tool),
  };
}

function reasoningPart(id: string): ReasoningPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'reasoning',
    text: 'Reasoning detail',
    time: { start: 0, end: 1 },
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
  resetToolCallExpansionState();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  document.body.classList.remove('chat-read-mode-open');
  markdownRendererMock.mockClear();
  messagePartMock.mockClear();
  resetToolCallExpansionState();
  resetDefaultAppState();
  vi.unstubAllGlobals();
});

function createManyTextParts(count: number): Part[] {
  return Array.from({ length: count }, (_, index) =>
    textPart(`text-${index + 1}`, `Paragraph ${index + 1}`)
  );
}

function pressShift() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
}

function releaseShift() {
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
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
  it('keeps activity parts ungrouped when compact tool output is disabled', () => {
    renderAssistantMessageContent({
      parts: [reasoningPart('reasoning-1'), toolPart('read-1', 'read')],
    });

    expect(container?.querySelector('.assistant-activity-group')).toBeNull();
    expect(container?.querySelectorAll('[data-assistant-render-key]')).toHaveLength(2);
    expect(container?.querySelectorAll('.message-part-mock')).toHaveLength(2);

    setCompactToolOutput(true);

    expect(container?.querySelectorAll('.assistant-activity-group')).toHaveLength(1);
    expect(container?.querySelectorAll('[data-assistant-render-key]')).toHaveLength(1);
    expect(container?.querySelectorAll('.message-part-mock')).toHaveLength(0);
  });

  it('groups consecutive activity, updates counters, and preserves expansion while streaming', () => {
    setCompactToolOutput(true);
    const initialParts: Part[] = [
      reasoningPart('reasoning-1'),
      toolPart('read-1', 'read', { filePath: 'src/a.ts' }),
      toolPart('read-2', 'read', { filePath: 'src/b.ts' }),
      toolPart('grep-1', 'grep', { pattern: 'activity' }),
    ];
    const [parts, setParts] = createSignal(initialParts);

    cleanup = render(
      () => (
        <AssistantMessageContent
          info={createAssistantMessage({ time: { created: 0 } })}
          parts={parts()}
          textForPart={(part) =>
            part.type === 'text' || part.type === 'reasoning' ? part.text : null
          }
        />
      ),
      container!
    );

    const summary = () =>
      container?.querySelector<HTMLButtonElement>('.assistant-activity-summary');
    expect(summary()?.textContent).toContain('Explored 2 files, 1 thought, 1 search');
    expect(summary()?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('.assistant-activity-details')).toBeNull();

    summary()?.click();

    expect(summary()?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(4);

    setParts((current) => [...current, toolPart('bash-1', 'bash', { command: 'npm test' })]);

    expect(summary()?.textContent).toContain(
      'Explored 2 files, 1 thought, 1 search, 1 command'
    );
    expect(summary()?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('.assistant-activity-detail')).toHaveLength(5);
  });

  it('keeps inline file edits outside the compact activity disclosure', () => {
    setCompactToolOutput(true);
    setShowInlineFileChanges(true);
    const edit = fileEditPart('edit-inline', 'src/app.ts');
    edit.state = completedToolState(
      {
        filePath: 'src/app.ts',
        oldString: 'const value = 1;',
        newString: 'const value = 2;',
      },
      'Edited src/app.ts'
    );

    renderAssistantMessageContent({ parts: [edit] });

    expect(container?.querySelector('.assistant-activity-summary')).toBeNull();
    expect(container?.querySelector('.assistant-file-edit-stack')).not.toBeNull();
    expect(container?.querySelector('[data-part-id="edit-inline"]')).not.toBeNull();
  });

  it('groups file edits when inline previews are disabled', () => {
    setCompactToolOutput(true);
    setShowInlineFileChanges(false);
    const edit = fileEditPart('edit-compact', 'src/app.ts');

    renderAssistantMessageContent({ parts: [edit] });

    expect(container?.querySelector('.assistant-activity-summary')?.textContent).toContain(
      'Explored 1 edit'
    );
    expect(container?.querySelector('[data-part-id="edit-compact"]')).toBeNull();
  });

  it('applies failure emphasis only to the failed-tool suffix', () => {
    setCompactToolOutput(true);
    const failed = toolPart('read-failed', 'read', { filePath: 'src/failing.ts' });
    failed.state = {
      status: 'error',
      input: { filePath: 'src/failing.ts' },
      error: 'Read failed',
      time: { start: 0, end: 1 },
    };

    renderAssistantMessageContent({ parts: [toolPart('read-1', 'read'), failed] });

    expect(container?.querySelector('.assistant-activity-summary-main')?.textContent).toBe(
      'Explored 2 files'
    );
    expect(container?.querySelector('.assistant-activity-status-failed')?.textContent).toBe(
      ' · 1 tool failed'
    );
    expect(container?.querySelector('.assistant-activity-group')?.classList).not.toContain(
      'has-failure'
    );
  });

  it('keeps actionable tools outside compact activity groups', () => {
    setCompactToolOutput(true);
    const question = toolPart('question-1', 'question');
    const [questionActive, setQuestionActive] = createSignal(false);

    renderAssistantMessageContent({
      parts: [toolPart('read-1', 'read'), question, toolPart('grep-1', 'grep')],
      questionRequestForTool: (part) =>
        questionActive() && part.id === question.id
          ? {
              id: 'question-request-1',
              sessionID: 'session-1',
              questions: [],
              tool: { messageID: 'assistant-1', callID: question.callID },
            }
          : null,
    });

    expect(container?.querySelectorAll('.assistant-activity-group')).toHaveLength(1);

    setQuestionActive(true);

    expect(container?.querySelectorAll('.assistant-activity-group')).toHaveLength(2);
    expect(
      container?.querySelector('[data-assistant-render-key="part:question-1"]')
    ).not.toBeNull();
  });

  it('keeps delegated agent tasks outside compact activity groups', () => {
    setCompactToolOutput(true);

    renderAssistantMessageContent({
      parts: [toolPart('read-1', 'read'), toolPart('task-1', 'task'), toolPart('grep-1', 'grep')],
    });

    expect(container?.querySelectorAll('.assistant-activity-group')).toHaveLength(2);
    expect(container?.querySelector('[data-assistant-render-key="part:task-1"]')).not.toBeNull();
  });

  it('shows mounted parts immediately, then reveals newly streamed parts once', () => {
    const info = createAssistantMessage({ time: { created: 0 } });
    const initialPart = textPart('text-1', 'Streaming');
    const [parts, setParts] = createSignal<Part[]>([initialPart]);

    cleanup = render(
      () => (
        <AssistantMessageContent
          info={info}
          parts={parts()}
          textForPart={(part) =>
            part.type === 'text' || part.type === 'reasoning' ? part.text : null
          }
        />
      ),
      container!
    );

    expect(
      container?.querySelector('[data-assistant-render-key="part:text-1"]')?.classList
    ).not.toContain('assistant-message-flow-item-streamed');

    setParts([{ ...initialPart, text: 'Streaming update' }]);

    expect(
      container?.querySelector('[data-assistant-render-key="part:text-1"]')?.classList
    ).not.toContain('assistant-message-flow-item-streamed');

    setParts((current) => [...current, textPart('text-2', 'Next block')]);

    expect(
      container?.querySelector('[data-assistant-render-key="part:text-2"]')?.classList
    ).toContain('assistant-message-flow-item-streamed');
  });

  it('disposes a streamed item entrance when Solid removes the item', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {
          disconnect();
        }
      }
    );
    const info = createAssistantMessage({ time: { created: 0 } });
    const initialPart = textPart('text-1', 'Streaming');
    const streamedPart = textPart('text-2', 'Temporary block');
    const [parts, setParts] = createSignal<Part[]>([initialPart]);

    cleanup = render(
      () => (
        <AssistantMessageContent
          info={info}
          parts={parts()}
          textForPart={(part) =>
            part.type === 'text' || part.type === 'reasoning' ? part.text : null
          }
        />
      ),
      container!
    );

    setParts([initialPart, streamedPart]);
    await Promise.resolve();
    const element = container?.querySelector<HTMLElement>(
      '[data-assistant-render-key="part:text-2"]'
    );
    expect(element?.classList).toContain('measured-entrance-active');

    setParts([initialPart]);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(element?.classList).not.toContain('measured-entrance-active');
    expect(element?.style.getPropertyValue('--streamed-assistant-item-height')).toBe('');
  });

  it('does not reveal parts when mounting completed history', () => {
    renderAssistantMessageContent({ parts: [textPart('text-1', 'Completed')] });

    expect(container?.querySelector('.assistant-message-flow-item-streamed')).toBeNull();
  });

  it('does not replay reveals when remounted with a shared claim function', () => {
    const info = createAssistantMessage({ time: { created: 0 } });
    const claimedKeys = new Map<string, Set<string>>();
    const claimItemReveal = (messageId: string, renderKey: string) => {
      let keys = claimedKeys.get(messageId);
      if (!keys) {
        keys = new Set();
        claimedKeys.set(messageId, keys);
      }
      if (keys.has(renderKey)) return false;
      keys.add(renderKey);
      return true;
    };
    const renderStreamingPart = () =>
      render(
        () => (
          <AssistantMessageContent
            info={info}
            parts={[textPart('text-1', 'Streaming')]}
            textForPart={(part) =>
              part.type === 'text' || part.type === 'reasoning' ? part.text : null
            }
            claimItemReveal={claimItemReveal}
            allowInitialItemReveal
          />
        ),
        container!
      );

    cleanup = renderStreamingPart();
    expect(container?.querySelector('.assistant-message-flow-item-streamed')).not.toBeNull();

    cleanup?.();
    container!.innerHTML = '';

    cleanup = renderStreamingPart();
    expect(container?.querySelector('.assistant-message-flow-item-streamed')).toBeNull();
  });

  it('does not re-animate a file-edit stack when another edit is appended', () => {
    const info = createAssistantMessage({ time: { created: 0 } });
    const [parts, setParts] = createSignal<Part[]>([fileEditPart('edit-1', 'src/a.ts')]);
    const stackSelector = '[data-assistant-render-key^="file-edit-stack:"]';

    cleanup = render(
      () => (
        <AssistantMessageContent
          info={info}
          parts={parts()}
          allowInitialItemReveal
          textForPart={(part) =>
            part.type === 'text' || part.type === 'reasoning' ? part.text : null
          }
        />
      ),
      container!
    );

    expect(container?.querySelector(stackSelector)?.classList).toContain(
      'assistant-message-flow-item-streamed'
    );

    setParts((current) => [...current, fileEditPart('edit-2', 'src/b.ts')]);

    expect(container?.querySelector(stackSelector)?.classList).not.toContain(
      'assistant-message-flow-item-streamed'
    );
  });

  it('filters highlighted-card meta text using effective text and opens read mode for the final answer while Shift is pressed', async () => {
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

    expect(container?.querySelector('.assistant-read-mode-toggle')).toBeNull();

    pressShift();

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

    releaseShift();
    expect(container?.querySelector('.assistant-read-mode-toggle')).toBeNull();
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

  it('does not group reads and searches containing edit words as file edits', () => {
    const readPart: ToolPart = {
      ...fileEditPart('read-edit-path', 'src/webview/lib/message-edit-state.ts'),
      tool: 'read',
      state: completedToolState(
        { filePath: 'src/webview/lib/message-edit-state.ts' },
        'src/webview/lib/message-edit-state.ts'
      ),
    };
    const grepPart: ToolPart = {
      ...fileEditPart('grep-edit-title', 'src/webview/components'),
      tool: 'grep',
      state: completedToolState(
        { path: 'src/webview/components', pattern: 'Editing message|editing-message' },
        'Editing message|editing-message'
      ),
    };

    renderAssistantMessageContent({ parts: [readPart, grepPart] });

    expect(container?.querySelector('.assistant-file-edit-stack')).toBeNull();
    expect(container?.querySelectorAll('[data-assistant-render-key]')).toHaveLength(2);
  });

  it('revises file stack keys only when inline preview content affects layout', () => {
    const compactPart = fileEditPart('edit-1', 'src/one.ts');
    const previewPart: ToolPart = {
      ...fileEditPart('edit-2', 'src/two.ts'),
      tool: 'edit',
      state: completedToolState(
        {
          filePath: 'src/two.ts',
          oldString: 'const value = 1;',
          newString: 'const value = 2;',
        },
        'Edited src/two.ts'
      ),
    };

    expect(getFileEditStackRenderKey([compactPart], true)).toBe(
      getFileEditStackRenderKey([compactPart], false)
    );
    expect(getFileEditStackRenderKey([previewPart], true)).not.toBe(
      getFileEditStackRenderKey([previewPart], false)
    );
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

  it('keeps completed responses fully rendered after they stop being last', () => {
    renderAssistantMessageContent({
      parts: createManyTextParts(45),
      isLastAssistant: false,
    });

    expect(container?.querySelectorAll('[data-assistant-render-key]')).toHaveLength(45);
  });

  it('keeps assistant parts fully rendered when the outer message list is virtualized', () => {
    renderAssistantMessageContent({
      parts: createManyTextParts(45),
      isLastAssistant: false,
      outerListVirtualized: true,
    });

    expect(container?.querySelectorAll('[data-assistant-render-key]')).toHaveLength(45);
  });
});
