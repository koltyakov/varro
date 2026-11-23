import { flush as flushSolid, createComponent, createSignal, reconcile } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import { setShowFileDiffs, setState } from '../lib/state';
import type { AssistantMessage, Permission, QuestionRequest, Session, ToolPart } from '../types';
import {
  ToolCall,
  formatToolTitle,
  getVisibleInputEntries,
  getToolCallExpansionKey,
  resetToolCallExpansionState,
} from './ToolCall';
import { getToolCallExpanded, setToolCallExpanded } from '../lib/tool-call-expansion-state';
import { client } from '../lib/client';
import { clearDirectSessionReturn, getDirectSessionReturnId } from '../lib/session-navigation';
import { fixture } from '../test-fixtures';
import type { UnknownRecord } from '../../shared/type-utils';
import {
  cableTagIcon,
  chatBubbleQuestionIcon,
  checkCircleIcon,
  copyIcon,
  editPencilIcon,
  eyeIcon,
  hourglassIcon,
  languageIcon,
  searchIcon,
  terminalIcon,
} from '../lib/ui-icons';
import { toCssUrl } from './UiIcon';
import { getFileTypeIcon } from './FileTypeIcon';
import { getFolderTypeIcon } from './FolderTypeIcon';

const selectSessionMock = vi.hoisted(() => vi.fn(async () => {}));

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise ToolCall's useOpenCode module integration. */
vi.mock('../hooks/useOpenCode', async () => {
  const actual = await vi.importActual<typeof UseOpenCodeModule>('../hooks/useOpenCode');
  return {
    ...actual,
    selectSession: selectSessionMock,
  };
});

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function setExtensionSender() {
  const sendSpy = vi.fn();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  fixture<UnknownRecord>(window).__sendToExtension = sendSpy;
  return sendSpy;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setShowFileDiffs(false);
  flushSolid();
  selectSessionMock.mockClear();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete fixture<UnknownRecord>(window).__sendToExtension;
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container?.remove();
  flushSolid();
  container = null;
  setShowFileDiffs(false);
  flushSolid();
  applyState(storePath('permissions', []));
  applyState(storePath('questions', []));
  applyState((draft) => {
    const current = draft['sessionStatus'];
    const incoming = {} satisfies typeof current;
    if (incoming === null || incoming === undefined || current === null || current === undefined)
      draft['sessionStatus'] = incoming;
    else reconcile(incoming)(current);
  });
  applyState(storePath('messages', []));
  applyState(storePath('sessions', []));
  applyState(storePath('allAgents', []));
  applyState(storePath('activeSessionId', null));
  clearDirectSessionReturn();
  flushSolid();
  resetToolCallExpansionState();
  flushSolid();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete fixture<UnknownRecord>(window).__sendToExtension;
  vi.useRealTimers();
});

function completedState(
  input: UnknownRecord = {},
  title = '',
  output = ''
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

function toolPart(tool: string, state: ToolPart['state']): ToolPart {
  return {
    id: 'tool-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool,
    state,
  };
}

function applyState(setter: Parameters<typeof setState>[0]) {
  setState(setter);
  flushSolid();
}

function openRepoWorkspace() {
  applyState(
    storePath('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    })
  );
}

/** A pending question linked to the default tool part through its message and call IDs. */
function linkedCommandQuestion(): QuestionRequest {
  return {
    id: 'question-1',
    sessionID: 'session-1',
    tool: { messageID: 'message-1', callID: 'call-1' },
    questions: [
      {
        question: 'Which command should run?',
        header: 'Choose command',
        options: [{ label: 'git status', description: 'Inspect working tree' }],
      },
    ],
  };
}

function renderToolCall(part: ToolPart) {
  cleanup = render(() => ToolCall({ part }), container!);
  flushSolid();
}

function toggleHeader() {
  container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();
  flushSolid();
}

function assistantMessage(id: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  const base: AssistantMessage = {
    id,
    sessionID: 'session-1',
    role: 'assistant',
    time: { created: 0 },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'subagent',
    path: { cwd: '/repo', root: '/repo' },
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

function session(id: string, overrides: Partial<Session> = {}): Session {
  const base: Session = {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: 0, updated: 0 },
  };

  return {
    ...base,
    ...overrides,
    time: overrides.time ?? base.time,
  };
}

describe('formatToolTitle', () => {
  it.each([
    ['question', ''],
    ['question', 'question'],
    ['functions.question', ''],
    ['functions.question', 'functions.question'],
  ])('capitalizes the default question title for %s with title "%s"', (toolName, title) => {
    expect(formatToolTitle(toolName, completedState({}, title))).toBe('Question');
  });

  it('preserves descriptive question titles', () => {
    expect(formatToolTitle('question', completedState({}, 'Asked 3 questions'))).toBe(
      'Asked 3 questions'
    );
  });

  it('shows search tools as Search with the input pattern', () => {
    expect(formatToolTitle('grep', completedState({ pattern: 'Thinking:' }, 'Thinking:'))).toBe(
      'Search: Thinking:'
    );
  });

  it('supports namespaced search tool names', () => {
    expect(formatToolTitle('functions.grep', completedState({ pattern: 'MessagePart' }))).toBe(
      'Search: MessagePart'
    );
  });

  it('keeps non-search tool titles unchanged', () => {
    expect(formatToolTitle('bash', completedState({ command: 'git status' }, 'git status'))).toBe(
      'git status'
    );
  });

  it('uses the command preview for completed bash calls without a title', () => {
    expect(formatToolTitle('bash', completedState({ command: 'npm run lint' }, ''))).toBe(
      'npm run lint'
    );
  });

  it('uses the description as the task title', () => {
    expect(
      formatToolTitle('task', completedState({ description: 'Trace Varro diff logic' }, 'Working'))
    ).toBe('Trace Varro diff logic');
  });

  it('uses the URL as the webfetch title', () => {
    expect(
      formatToolTitle(
        'webfetch',
        completedState({ url: 'https://sourcegraph.com/search/stream?q=context' })
      )
    ).toBe('https://sourcegraph.com/search/stream?q=context');
  });

  it('falls back to the command for errored bash calls without a title', () => {
    expect(
      formatToolTitle('bash', {
        status: 'error',
        input: { command: 'npm test' },
        error: 'Command failed with exit code 1',
        time: { start: 0, end: 1 },
      })
    ).toBe('npm test');
  });

  it('keeps the raw tool name for errored bash calls without a command', () => {
    expect(
      formatToolTitle('bash', {
        status: 'error',
        input: {},
        error: 'Command failed',
        time: { start: 0, end: 1 },
      })
    ).toBe('bash');
  });
});

describe('getVisibleInputEntries', () => {
  it('hides empty string fields while keeping meaningful values', () => {
    expect(
      getVisibleInputEntries({
        description: 'stability perf scan',
        prompt: 'Research the VS Code extension/webview codebase',
        task_id: '',
        command: '   ',
        count: 0,
        enabled: false,
      })
    ).toEqual([
      ['description', 'stability perf scan'],
      ['prompt', 'Research the VS Code extension/webview codebase'],
      ['count', 0],
      ['enabled', false],
    ]);
  });
});

describe('ToolCall', () => {
  describe('Code Mode', () => {
    function executePart(metadata: UnknownRecord = {}, tool = 'execute'): ToolPart {
      return {
        id: 'tool-execute',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'tool',
        callID: 'call-execute',
        tool,
        state: {
          ...completedState({ code: 'return await tools.docs.lookup({ id: 1 });' }, '', 'Result'),
          metadata,
        },
      };
    }

    it.each([
      { error: true },
      { error: true, toolCalls: [{ tool: 'docs.lookup', status: 'error' }] },
    ])('styles completed execute failures from metadata %j', (metadata) => {
      const part = executePart(metadata);
      renderToolCall(part);

      expect(container?.querySelector('.tool-call-icon')?.classList).toContain('tool-status-error');
      expect(container?.querySelector('.tool-invocation-error-label')?.textContent).toBe('failed');
      toggleHeader();
      const result = container?.querySelector('.structured-tool-row-result');
      expect(result?.classList).toContain('structured-tool-row-error');
      expect(result?.querySelector('.tool-invocation-error')?.textContent).toBe('Result');
      expect(part.state.status).toBe('completed');
    });

    it.each([
      {},
      { error: false },
      { error: 'true' },
      { toolCalls: [{ tool: 'docs.lookup', status: 'completed' }] },
      { toolCalls: [{ tool: 'docs.lookup', status: 'running' }] },
    ])('keeps successful execute results neutral with metadata %j', (metadata) => {
      const part = executePart(metadata);
      renderToolCall(part);

      expect(container?.querySelector('.tool-call-icon')?.classList).toContain(
        'tool-status-completed'
      );
      expect(container?.querySelector('.tool-invocation-error-label')).toBeNull();
      toggleHeader();
      expect(container?.querySelector('.structured-tool-row-error')).toBeNull();
      expect(container?.querySelector('.structured-tool-row-result')?.textContent).toContain(
        'Result'
      );
    });

    it.each(['bash', 'task', 'docs_lookup'])(
      'does not apply Code Mode metadata rendering or failure classification to %s',
      (tool) => {
        const part = executePart(
          { error: true, toolCalls: [{ tool: 'docs.lookup', status: 'error' }] },
          tool
        );
        renderToolCall(part);

        expect(container?.querySelector('.tool-call-icon')?.classList).toContain(
          'tool-status-completed'
        );
        expect(container?.querySelector('.tool-invocation-error-label')).toBeNull();
        toggleHeader();
        expect(container?.querySelector('.code-mode-tool-calls')).toBeNull();
        expect(container?.querySelector('.structured-tool-row-error')).toBeNull();
      }
    );

    it('renders nested call inputs and all three statuses for namespaced execute tools', () => {
      const part = executePart(
        {
          toolCalls: [
            {
              tool: 'docs.lookup',
              status: 'running',
              input: { id: 0, cached: false, filter: { tags: ['api'] } },
            },
            { tool: 'docs.lookup', status: 'completed', input: { id: 2 } },
            { tool: 'docs.lookup', status: 'error' },
          ],
        },
        'functions.execute'
      );
      renderToolCall(part);
      toggleHeader();

      const list = container?.querySelector('.code-mode-tool-calls');
      expect(list?.getAttribute('aria-label')).toBe('Code Mode tool calls');
      const calls = Array.from(list?.querySelectorAll('.code-mode-tool-call') ?? []);
      expect(calls).toHaveLength(3);
      expect(
        calls.map((call) => call.querySelector('.code-mode-tool-call-name')?.textContent)
      ).toEqual(['docs.lookup', 'docs.lookup', 'docs.lookup']);
      expect(calls.map((call) => call.querySelector('[role="status"]')?.textContent)).toEqual([
        'Running',
        'Completed',
        'Error',
      ]);
      expect(calls.map((call) => call.getAttribute('data-status'))).toEqual([
        'running',
        'completed',
        'error',
      ]);
      for (const call of calls) {
        expect(call.querySelector('.tool-call-icon')?.classList).toContain(
          `tool-status-${call.getAttribute('data-status')}`
        );
      }
      expect(calls[0]?.textContent).toContain('id0');
      expect(calls[0]?.textContent).toContain('cachedfalse');
      expect(calls[0]?.textContent).toContain('"api"');
      expect(calls[1]?.textContent).toContain('id2');
      expect(calls[2]?.querySelectorAll('.structured-tool-row')).toHaveLength(0);
    });

    it.each([
      {},
      { toolCalls: [] },
      { toolCalls: null },
      { toolCalls: { tool: 'docs.lookup', status: 'error' } },
      { toolCalls: [null, 1, {}, { status: 'error' }, { tool: 'docs.lookup', status: 'failed' }] },
    ])('retains the generic fallback for absent or invalid nested calls %j', (metadata) => {
      const part = executePart(metadata);
      renderToolCall(part);
      toggleHeader();

      expect(container?.querySelector('.code-mode-tool-calls')).toBeNull();
      expect(container?.querySelector('.tool-call-icon')?.classList).toContain(
        'tool-status-completed'
      );
      expect(
        Array.from(container?.querySelectorAll('.structured-tool-label') ?? []).map(
          (label) => label.textContent
        )
      ).toEqual(['code', 'result']);
      expect(container?.textContent).toContain('return await tools.docs.lookup');
      expect(container?.querySelector('.structured-tool-row-result')?.textContent).toContain(
        'Result'
      );
    });

    it('keeps the outer result successful when the script handles a nested error', () => {
      const initial = executePart();
      const [part, setPart] = createSignal<ToolPart>({
        ...initial,
        state: {
          status: 'running',
          input: initial.state.input,
          time: { start: 0 },
          metadata: {},
        },
      });
      cleanup = render(
        () =>
          createComponent(ToolCall, {
            get part() {
              return part();
            },
          }),
        container!
      );
      flushSolid();
      const header = container!.querySelector<HTMLButtonElement>('.tool-invocation-header')!;
      header.click();
      flushSolid();
      expect(container?.querySelector('.code-mode-tool-calls')).toBeNull();

      setPart({
        ...part(),
        state: {
          ...part().state,
          metadata: {
            toolCalls: [{ tool: 'docs.lookup', status: 'running', input: { id: 1 } }],
          },
        },
      });
      flushSolid();
      const first = container!.querySelector('.code-mode-tool-call')!;
      expect(first.getAttribute('data-status')).toBe('running');
      expect(first.textContent).toContain('id1');
      expect(header.querySelector('.tool-call-icon')?.classList).toContain('tool-status-running');

      setPart({
        ...part(),
        state: {
          ...part().state,
          metadata: {
            toolCalls: [
              { tool: 'docs.lookup', status: 'completed', input: { id: 10 } },
              { tool: 'docs.lookup', status: 'running', input: { id: 2 } },
            ],
          },
        },
      });
      flushSolid();
      expect(container?.querySelector('.code-mode-tool-call')).toBe(first);
      expect(first.getAttribute('data-status')).toBe('completed');
      expect(first.querySelector('[role="status"]')?.textContent).toBe('Completed');
      expect(first.textContent).toContain('id10');
      const second = container!.querySelectorAll('.code-mode-tool-call')[1]!;
      expect(second.getAttribute('data-status')).toBe('running');

      const metadata = {
        toolCalls: [
          { tool: 'docs.lookup', status: 'completed', input: { id: 10 } },
          { tool: 'docs.lookup', status: 'error', input: { id: 2 } },
        ],
      };
      setPart({ ...part(), state: { ...part().state, metadata } });
      flushSolid();
      expect(container?.querySelectorAll('.code-mode-tool-call')[1]).toBe(second);
      expect(second.querySelector('[role="status"]')?.textContent).toBe('Error');
      expect(header.querySelector('.tool-call-icon')?.classList).toContain('tool-status-running');

      setPart(executePart(metadata));
      flushSolid();
      expect(container?.querySelector('.tool-invocation-header')).toBe(header);
      expect(container?.querySelector('.code-mode-tool-call')).toBe(first);
      expect(header.querySelector('.tool-call-icon')?.classList).toContain('tool-status-completed');
      expect(second.querySelector('[role="status"]')?.textContent).toBe('Error');
      expect(container?.querySelector('.structured-tool-row-error')).toBeNull();
      expect(container?.querySelector('.structured-tool-row-result')?.textContent).toContain(
        'Result'
      );
      header.click();
      flushSolid();
      expect(container?.querySelector('.code-mode-tool-calls')).toBeNull();
      expect(header.querySelector('.tool-invocation-error-label')).toBeNull();
    });

    it('makes nested-only execute metadata expandable', () => {
      const metadata = { toolCalls: [{ tool: 'docs.lookup', status: 'completed' }] };
      const part = executePart(metadata);
      part.state = { ...completedState(), metadata };
      renderToolCall(part);
      const header = container!.querySelector<HTMLButtonElement>('.tool-invocation-header')!;
      expect(header.disabled).toBe(false);
      header.click();
      flushSolid();
      expect(container?.querySelector('.code-mode-tool-call-name')?.textContent).toBe(
        'docs.lookup'
      );
    });
  });

  it('uses shared expansion state helpers', () => {
    const part = toolPart('bash', completedState({ command: 'git status' }, 'git status'));

    const key = getToolCallExpansionKey(part);
    setToolCallExpanded(key, true);
    flushSolid();

    expect(getToolCallExpanded(key)).toBe(true);

    resetToolCallExpansionState();
    flushSolid();

    expect(getToolCallExpanded(key)).toBe(false);
  });

  it('keeps command blocks collapsed by default', () => {
    const part = toolPart('bash', completedState({ command: 'git status' }, 'git status'));

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-detail')).toBeNull();
    expect(container?.textContent).toContain('git status');
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-terminal');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.classList).toContain('ui-icon');
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('12px');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(terminalIcon));
  });

  it('keeps an expanded generic tool body mounted in lightweight mode', () => {
    const part: ToolPart = {
      id: 'tool-expanded',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-expanded',
      tool: 'custom_tool',
      state: completedState({ query: 'details' }, 'expanded output'),
    };
    setToolCallExpanded(getToolCallExpansionKey(part), true);
    flushSolid();

    cleanup = render(() => ToolCall({ part, lightweight: true }), container!);
    flushSolid();

    expect(container?.querySelector('.tool-invocation-detail')).not.toBeNull();
    expect(container?.textContent).toContain('expanded output');
  });

  it('does not repeat long commands in the collapsed preview', () => {
    const command = `npm run test -- ${'src/webview/components/MessageList.test.ts '.repeat(3)}`;
    const part = toolPart('bash', completedState({ command }, command));

    renderToolCall(part);

    expect(command.length).toBeGreaterThan(100);
    expect(container?.querySelector('.tool-invocation-preview')).toBeNull();
  });

  it('does not offer expansion when a generic tool has no details', () => {
    const part = toolPart('apply_patch', {
      status: 'running',
      input: {},
      title: 'apply_patch',
      metadata: {},
      time: { start: 0 },
    });

    renderToolCall(part);

    const header = container?.querySelector<HTMLButtonElement>('.tool-invocation-header');
    expect(header?.disabled).toBe(true);
    expect(header?.hasAttribute('aria-expanded')).toBe(false);
    expect(container?.querySelector('.tool-invocation-chevron')).toBeNull();
    expect(container?.querySelector('.tool-invocation-detail')).toBeNull();
  });

  it.each(['apply_patch', 'patch'])('animates pending %s calls as in-progress tools', (tool) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    flushSolid();
    const part = toolPart(tool, {
      status: 'pending',
      input: {},
      raw: '',
    });

    renderToolCall(part);

    expect(container?.querySelector('.tool-call-icon-edit')?.classList).toContain(
      'tool-status-running'
    );
    expect(container?.querySelector('.tool-invocation-title')?.classList).toContain(
      'shimmer-progress'
    );
    expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('0ms');

    vi.advanceTimersByTime(69_000);
    flushSolid();

    expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('1m 9s');
  });

  it.each(['apply_patch', 'patch'])(
    'shows files from running %s input in the compact edit card',
    (tool) => {
      const part: ToolPart = {
        id: 'tool-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'tool',
        callID: 'call-1',
        tool,
        state: {
          status: 'running',
          input: {
            patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Update File: src/theme.css
@@
-old
+new
*** End Patch`,
          },
          title: 'apply_patch',
          metadata: {},
          time: { start: 0 },
        },
      };

      renderToolCall(part);

      expect(container?.querySelector('.file-change-card-header')?.textContent).not.toContain(
        '2 files'
      );
      expect(
        Array.from(container?.querySelectorAll('.file-edit-path-link') || []).map(
          (link) => link.textContent
        )
      ).toEqual(['src/app.ts', 'src/theme.css']);
      expect(container?.querySelector('.file-change-card-header')?.textContent).not.toContain(
        'editing…'
      );
      expect(container?.querySelector('.tool-invocation-header')).toBeNull();
    }
  );

  it.each(['apply_patch', 'patch'])('animates a pending %s file-change card', (tool) => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool,
      state: {
        status: 'pending',
        input: {
          patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** End Patch`,
        },
        raw: '',
      },
    };

    renderToolCall(part);

    expect(container?.querySelector('.file-edit-action-label')?.classList).toContain(
      'shimmer-progress'
    );
    expect(container?.querySelector('.file-edit-icon')?.classList).toContain('tool-status-running');
    expect(container?.querySelector('.file-edit-icon')?.getAttribute('aria-label')).toBe('Running');
  });

  it('shows an aligned empty output row for completed bash commands', () => {
    const part = toolPart(
      'bash',
      completedState({ command: 'pnpm -s exec prettier --check src/webview/index.css' }, 'check')
    );

    renderToolCall(part);

    toggleHeader();

    expect(container?.querySelector('.terminal-command-row-output')).not.toBeNull();
    expect(container?.querySelector('.terminal-command-output-empty')?.textContent).toBe(
      '(no output)'
    );
  });

  it('renders failed bash errors in the terminal result row', () => {
    const part = toolPart('bash', {
      status: 'error',
      input: { command: 'opencode --version' },
      error: 'The user rejected permission to use this specific tool call.',
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);
    toggleHeader();

    const errorRow = container?.querySelector('.terminal-command-row-error');
    expect(container?.querySelector('.terminal-command-row-input')).toBeNull();
    expect(
      container?.querySelector('.tool-invocation-header .tool-invocation-error-label')
    ).toBeNull();
    expect(
      container?.querySelector('.tool-invocation-header-shell > .tool-copy-button')
    ).not.toBeNull();
    expect(errorRow?.classList).toContain('terminal-command-row-output');
    expect(errorRow?.querySelector('.tool-invocation-error')?.textContent).toBe(
      'The user rejected permission to use this specific tool call.'
    );
    expect(errorRow?.querySelector('.tool-invocation-error')?.getAttribute('role')).toBe('alert');
    expect(
      Array.from(container?.querySelector('.tool-invocation-detail')?.children || []).some(
        (child) => child.classList.contains('tool-invocation-error')
      )
    ).toBe(false);
  });

  it.each([
    ['read', 'The user declined this tool call'],
    ['read', 'The user rejected permission to use this specific tool call.'],
    ['edit', 'The user declined this tool call'],
    ['edit', 'The user rejected permission to use this specific tool call.'],
  ])('labels a rejected %s permission separately from a tool failure: %s', (tool, error) => {
    const part: ToolPart = {
      id: 'tool-rejected',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-rejected',
      tool,
      state: {
        status: 'error',
        input: { filePath: 'packages/core/package.json', oldString: 'old', newString: 'new' },
        error,
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);

    const label = container?.querySelector('.file-read-error-label, .file-edit-error-label');
    expect(label?.textContent).toBe('rejected');
    if (tool === 'read') {
      expect(container?.querySelector('[aria-label="Rejected"]')).not.toBeNull();
    }
  });

  it('treats whitespace-only output as empty rather than rendering a blank box', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      // A command that succeeds silently returns a bare newline, which is
      // truthy - the old check rendered it as content.
      state: completedState({ command: 'rtk git diff --check' }, 'rtk git diff --check', '\n  \n'),
    };

    renderToolCall(part);
    toggleHeader();

    expect(container?.querySelector('.terminal-command-output-empty')?.textContent).toBe(
      '(no output)'
    );
    expect(container?.querySelector('.tool-text-clamped')).toBeNull();
  });

  it('offers no expansion when the only output is whitespace', () => {
    const part = toolPart('websearch', completedState({}, 'search', '   \n'));

    renderToolCall(part);

    const header = container?.querySelector<HTMLButtonElement>('.tool-invocation-header');
    expect(header?.disabled).toBe(true);
    expect(container?.querySelector('.tool-invocation-chevron')).toBeNull();
  });

  it('drops the $ row and copies from the expanded header when it shows the command', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const command = `rtk npx oxfmt --check ${'src/webview/components/ToolCall.tsx '.repeat(3)}`;
    const part = toolPart(
      'bash',
      completedState({ command }, command, 'All matched files use the correct format.')
    );

    renderToolCall(part);
    const header = container?.querySelector<HTMLButtonElement>('.tool-invocation-header');
    expect(
      container?.querySelector('.tool-invocation-header-shell > .tool-copy-button')
    ).toBeNull();

    header?.click();
    flushSolid();

    expect(container?.querySelector('.terminal-command-row-input')).toBeNull();
    expect(container?.querySelector('.terminal-command-row-output')).not.toBeNull();
    const copy = container?.querySelector<HTMLButtonElement>(
      '.tool-invocation-header-shell > .tool-copy-button'
    );
    expect(copy).not.toBeNull();
    expect(header?.contains(copy || null)).toBe(false);
    const copyIconElement = copy?.querySelector<HTMLElement>('.ui-icon');
    expect(copyIconElement).toBeInstanceOf(HTMLSpanElement);
    expect(copyIconElement?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    expect(copyIconElement?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(copyIcon));

    copy?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(writeText).toHaveBeenCalledWith(command);
    await vi.waitFor(() => {
      expect(copy?.classList).toContain('is-copied');
      expect(copy?.getAttribute('aria-label')).toBe('Copied');
      expect(copy?.getAttribute('title')).toBeNull();
    });
    flushSolid();
    vi.unstubAllGlobals();
  });

  it('copies the full command even though the $ row renders one ellipsized line', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const command = `npm run test -- ${'src/webview/components/MessageList.test.ts '.repeat(4)}`;
    const part = toolPart('bash', completedState({ command }, 'run tests', 'ok'));

    renderToolCall(part);
    toggleHeader();

    const copy = container?.querySelector<HTMLButtonElement>('.tool-copy-button');
    expect(copy).not.toBeNull();
    copy?.click();
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(writeText).toHaveBeenCalledWith(command);
    vi.unstubAllGlobals();
  });

  it('keeps the $ row when the header title is not the command', () => {
    const part = toolPart(
      'bash',
      completedState({ command: 'git status' }, 'Check the repo', 'M src/app.ts')
    );

    renderToolCall(part);
    toggleHeader();

    expect(container?.querySelector('.terminal-command-row-input')).not.toBeNull();
    expect(container?.querySelector('.tool-invocation-running')).toBeNull();
  });

  it.each(['git status', 'bash', 'functions.bash', ''])(
    'shows the running command and offers copy when the server title is "%s"',
    async (title) => {
      const writeText = vi.fn(() => Promise.resolve());
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const part = toolPart('bash', {
        status: 'running',
        input: { command: 'git status' },
        title,
        metadata: {},
        time: { start: 0 },
      });

      renderToolCall(part);

      const header = container?.querySelector<HTMLButtonElement>('.tool-invocation-header');
      expect(header?.querySelector('.tool-invocation-title')?.textContent).toBe('git status');
      expect(header?.disabled).toBe(true);
      expect(header?.hasAttribute('aria-expanded')).toBe(false);
      expect(container?.querySelector('.tool-invocation-chevron')).toBeNull();
      expect(container?.querySelector('.tool-invocation-detail')).toBeNull();
      const copy = container?.querySelector<HTMLButtonElement>(
        '.tool-invocation-header-shell > .tool-copy-button'
      );
      expect(copy).not.toBeNull();
      expect(container?.querySelector('.tool-invocation-header-shell')?.classList).toContain(
        'has-command-only-copy'
      );

      copy?.click();
      flushSolid();
      await Promise.resolve();
      flushSolid();

      expect(writeText).toHaveBeenCalledWith('git status');
      vi.unstubAllGlobals();
    }
  );

  it('keeps expanded running command output scrolled to its latest line', async () => {
    const part = toolPart('bash', {
      status: 'running',
      input: { command: 'npm test' },
      title: 'npm test',
      metadata: { content: [{ type: 'text', text: 'test 1' }] },
      time: { start: 0 },
    });

    renderToolCall(part);
    toggleHeader();

    cleanup?.();
    flushSolid();
    cleanup = undefined;
    const updatedPart: ToolPart = {
      ...part,
      state: {
        status: 'running',
        input: { command: 'npm test' },
        title: 'npm test',
        metadata: { content: [{ type: 'text', text: 'test 1\ntest 2\ntest 3' }] },
        time: { start: 0 },
      },
    };
    cleanup = render(() => ToolCall({ part: updatedPart }), container!);
    flushSolid();

    const output = container?.querySelector<HTMLDivElement>('.terminal-command-output-viewport');
    if (!output) throw new Error('Expected live command output');
    Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 120 });
    Object.defineProperty(output, 'clientHeight', { configurable: true, value: 40 });
    output.scrollTop = 0;
    await Promise.resolve();
    flushSolid();

    expect(output.textContent).toContain('test 3');
    expect(output.scrollTop).toBe(80);
  });

  it('hides completed generic tool durations under one second', () => {
    const part = toolPart('grep', completedState({ pattern: 'ToolCall' }, 'Search: ToolCall'));

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-duration')).toBeNull();
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-search');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(searchIcon));
  });

  it('labels the completed search result count in the header', () => {
    const part = toolPart(
      'grep',
      completedState(
        { pattern: 'ToolCall' },
        'Search: ToolCall',
        'Found 2 matches\n\n/repo/src/a.ts:\n  Line 1: ToolCall\n/repo/src/b.ts:\n  Line 2: ToolCall'
      )
    );

    renderToolCall(part);

    const count = container?.querySelector('.tool-invocation-search-count');
    expect(count?.textContent).toBe('2 results');
    expect(count?.getAttribute('aria-label')).toBe('2 search results');
  });

  it('uses search metadata and marks truncated counts as lower bounds', () => {
    const part = toolPart('functions.grep', {
      ...completedState(
        { pattern: 'ToolCall' },
        'Search: ToolCall',
        'Found 100 matches (more matches available)'
      ),
      metadata: { matches: 100, truncated: true },
    });

    renderToolCall(part);

    const count = container?.querySelector('.tool-invocation-search-count');
    expect(count?.textContent).toBe('100+ results');
    expect(count?.getAttribute('aria-label')).toBe('100 or more search results');
  });

  it('uses the canonical icon kind for namespaced file aliases', () => {
    const part = toolPart(
      'functions.file_write',
      completedState({ filePath: 'src/app.ts' }, 'Wrote src/app.ts')
    );

    cleanup = render(() => ToolCall({ part, compactFileChanges: true }), container!);
    flushSolid();

    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-edit');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(editPencilIcon));
  });

  it('renders failed search errors as a structured table row', () => {
    openRepoWorkspace();
    const part = toolPart('functions.grep', {
      status: 'error',
      input: {
        pattern: 'disablePageUnloadEvents',
        path: '/repo/node_modules/@microsoft',
        include: '*.{ts,d.ts,js,mjs}',
      },
      error: 'Ripgrep JSON record exceeded 65536 bytes',
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);
    toggleHeader();

    const detail = container?.querySelector('.tool-invocation-detail');
    const rows = Array.from(detail?.querySelectorAll('.structured-tool-row') || []);
    const labels = rows.map((row) => row.querySelector('.structured-tool-label')?.textContent);
    const errorRow = rows.at(-1);

    expect(labels).toEqual(['pattern', 'path', 'include', 'error']);
    expect(errorRow?.classList.contains('structured-tool-row-error')).toBe(true);
    expect(errorRow?.querySelector('.tool-invocation-error')?.textContent).toBe(
      'Ripgrep JSON record exceeded 65536 bytes'
    );
    expect(
      Array.from(detail?.children || []).some((child) =>
        child.classList.contains('tool-invocation-error')
      )
    ).toBe(false);
  });

  it('styles a long single-line search pattern like the include value', () => {
    const pattern =
      'normalizeToolName|SEARCH_TOOL_NAMES|FILE_CHANGE_TOOL_NAMES|FILE_READ_TOOLS|COMMAND_TOOL_NAMES';
    const part = toolPart(
      'grep',
      completedState(
        {
          pattern,
          include: '{components/ToolCall.tsx,lib/assistant-activity.ts,lib/task-activity.ts}',
        },
        `Search: ${pattern}`,
        'No files found'
      )
    );

    renderToolCall(part);
    toggleHeader();

    const rows = Array.from(container?.querySelectorAll('.structured-tool-row') || []);
    const inputRows = rows.slice(0, 2);

    expect(
      inputRows.map((row) => row.querySelector('.structured-tool-label')?.textContent)
    ).toEqual(['pattern', 'include']);
    expect(
      inputRows.every((row) => row.querySelector('.structured-tool-value-line') !== null)
    ).toBe(true);
    expect(inputRows[0]?.querySelector('.structured-tool-value-single')?.textContent).toBe(pattern);
    expect(container?.querySelector('.tool-invocation-search-count')?.textContent).toBe(
      '0 results'
    );
  });

  it('renders web fetch details and errors in the structured table', () => {
    const part = toolPart('webfetch', {
      status: 'error',
      input: {
        url: 'https://api.github.com/search/code?q=defaultViewLocation%20repo%3Amicrosoft%2Fvscode',
        format: 'text',
        timeout: 30,
      },
      error: 'StatusCode: non 2xx status code (401)',
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);
    toggleHeader();

    const rows = Array.from(container?.querySelectorAll('.structured-tool-row') || []);
    const labels = rows.map((row) => row.querySelector('.structured-tool-label')?.textContent);

    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-web');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(languageIcon));
    expect(labels).toEqual(['url', 'format', 'timeout', 'error']);
    expect(rows.at(-1)?.querySelector('.tool-invocation-error')?.textContent).toBe(
      'StatusCode: non 2xx status code (401)'
    );
  });

  it('renders generic tool inputs and text output in the shared detail panel', () => {
    const part = toolPart(
      'browser-bridge_browser_page',
      completedState(
        { action: 'console', level: 'error', limit: 20 },
        'Inspect browser console',
        'Console: 0 entries (0 total).'
      )
    );

    renderToolCall(part);
    toggleHeader();

    const panel = container?.querySelector('.structured-tool-card');
    const rows = Array.from(panel?.querySelectorAll('.structured-tool-row') || []);

    expect(rows.map((row) => row.querySelector('.structured-tool-label')?.textContent)).toEqual([
      'action',
      'level',
      'limit',
      'result',
    ]);
    expect(rows.at(-1)?.querySelector('.structured-tool-value')?.textContent).toBe(
      'Console: 0 entries (0 total).'
    );
    expect(container?.querySelector('.tool-invocation-input')).toBeNull();
    expect(container?.querySelector('.tool-invocation-output')).toBeNull();
  });

  it('shows an explicit empty result for an expandable generic tool', () => {
    const part = toolPart(
      'custom_lookup',
      completedState({ query: 'missing' }, 'Look up missing item', '   ')
    );

    renderToolCall(part);
    toggleHeader();

    const resultRow = container?.querySelector('.structured-tool-row-result');
    expect(resultRow?.textContent).toContain('result');
    expect(resultRow?.textContent).toContain('(no output)');
  });

  it('keeps generic running status below the shared detail panel', () => {
    const part = toolPart('custom_lookup', {
      status: 'running',
      input: { query: 'current item' },
      title: 'Looking up current item',
      metadata: {},
      time: { start: 0 },
    });

    renderToolCall(part);
    toggleHeader();

    expect(container?.querySelector('.structured-tool-card')).not.toBeNull();
    expect(container?.querySelector('.structured-tool-label')?.textContent).toBe('query');
    expect(container?.querySelector('.tool-invocation-running')?.textContent).toBe('Running…');
  });

  it('does not render a second line for collapsed generic tool input', () => {
    openRepoWorkspace();

    const part = toolPart(
      'inspect',
      completedState({ path: '/repo/docs/spec.md' }, 'Inspect file')
    );

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-preview')).toBeNull();
    expect(container?.textContent).not.toContain('docs/spec.md');
  });

  it('does not render a second line for collapsed subagent input', () => {
    const part = toolPart(
      'task',
      completedState(
        {
          description: 'Research test suite improvements',
          command: 'hidden subagent summary',
          subagent_type: 'explore',
          prompt: 'Thoroughly explore the test suite for this project',
        },
        'Research test suite improvements'
      )
    );

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-preview')).toBeNull();
    expect(container?.textContent).not.toContain('hidden subagent summary');
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-task');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(checkCircleIcon));
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('16px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('16px');
  });

  it('uses the cable tag icon for incomplete task tools', () => {
    const part = toolPart('task', {
      status: 'error',
      input: { prompt: 'Review the implementation' },
      error: 'Task failed',
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);

    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-task');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(cableTagIcon));
  });

  it('renders the pending task cable tag icon at its established size', () => {
    const part = toolPart('task', {
      status: 'pending',
      input: {
        description: 'Research the codebase',
        subagent_type: 'explore',
        prompt: 'Find the relevant implementation',
      },
      raw: '',
    });

    renderToolCall(part);

    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-task');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(cableTagIcon));
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('16px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('16px');
  });

  it('hides a duplicated description from expanded task details', () => {
    const part = toolPart(
      'task',
      completedState(
        {
          description: 'Research test suite improvements',
          subagent_type: 'explore',
          prompt: 'Thoroughly explore the test suite for this project',
        },
        'Research test suite improvements'
      )
    );

    renderToolCall(part);

    expect(container?.querySelector('.chat-tool-invocation-part')?.classList).toContain(
      'tool-invocation-task'
    );
    toggleHeader();

    const detailText = container?.querySelector('.tool-invocation-detail')?.textContent || '';

    expect(detailText).not.toContain('descriptionResearch test suite improvements');
    expect(detailText).toContain('subagent_typeexplore');
    expect(detailText).toContain('promptThoroughly explore the test suite for this project');
  });

  it('renders prompt immediately before the task result, on the shared label/value grid', () => {
    const part = toolPart('task', {
      status: 'completed',
      input: {
        subagent_type: 'explore',
        prompt: 'Thoroughly explore the test suite for this project',
        task_id: 'task-1',
      },
      output: '<task_result>Full report</task_result>',
      title: 'Research test suite improvements',
      metadata: {},
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);

    toggleHeader();

    const rows = Array.from(container?.querySelectorAll('.structured-tool-row') || []);
    const labels = rows.map((row) => row.querySelector('.structured-tool-label')?.textContent);

    expect(labels).toEqual(['subagent_type', 'prompt', 'task_result']);
    expect(container?.querySelector('.tool-invocation-detail')?.textContent).not.toContain(
      'task_id'
    );
    // Multi-line values used to stack under their label on a one-column row,
    // which broke alignment with the scalar rows. Every row shares one grid now.
    expect(rows.every((row) => row.classList.contains('structured-tool-row'))).toBe(true);
    expect(rows.some((row) => row.classList.contains('structured-tool-row-block'))).toBe(false);
  });

  it('opens long task prompts and results in Markdown preview', () => {
    const send = setExtensionSender();
    flushSolid();
    const prompt = ['# Review', '', 'Inspect:', '- API', '- UI', '- Tests', '- Docs'].join('\n');
    const result = [
      '# Findings',
      '',
      '## API',
      'Ready',
      '## UI',
      'Ready',
      '## Tests',
      'Ready',
    ].join('\n');
    const part: ToolPart = {
      id: 'tool-markdown-preview',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-markdown-preview',
      tool: 'task',
      state: {
        status: 'completed',
        input: {
          subagent_type: 'general',
          prompt,
        },
        output: `<task_result>${result}</task_result>`,
        title: 'Review implementation',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);
    toggleHeader();

    const rows = Array.from(container?.querySelectorAll('.structured-tool-row') || []);
    const rowFor = (label: string) =>
      rows.find((row) => row.querySelector('.structured-tool-label')?.textContent === label);
    rowFor('prompt')?.querySelector<HTMLPreElement>('.structured-tool-value')?.click();
    flushSolid();
    rowFor('task_result')?.querySelector<HTMLPreElement>('.structured-tool-value')?.click();
    flushSolid();

    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'vscode/open-text',
      payload: {
        content: prompt,
        title: 'Review implementation (prompt)',
        language: undefined,
        view: 'markdown-preview',
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'vscode/open-text',
      payload: {
        content: result,
        title: 'Review implementation (task_result)',
        language: undefined,
        view: 'markdown-preview',
      },
    });
  });

  it('shows the subagent model and reasoning in expanded task details', () => {
    applyState(
      storePath('messages', [
        {
          info: assistantMessage('subagent-assistant-1', {
            sessionID: 'subagent-session-1',
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            variant: 'high',
            time: { created: 10 },
          }),
          parts: [],
        },
      ])
    );
    const part = toolPart('task', {
      status: 'running',
      input: {
        subagent_type: 'explore',
        prompt: 'Inspect the repository',
      },
      title: 'Inspect the repository',
      metadata: { sessionId: 'subagent-session-1' },
      time: { start: 0 },
    });

    renderToolCall(part);
    toggleHeader();

    const rows = Array.from(container?.querySelectorAll('.structured-tool-row') || []);
    expect(
      rows.map((row) => [
        row.querySelector('.structured-tool-label')?.textContent,
        row.querySelector('.structured-tool-value')?.textContent,
      ])
    ).toEqual([
      ['subagent_type', 'explore'],
      ['model', 'openai/gpt-5.6-sol'],
      ['reasoning', 'high'],
      ['prompt', 'Inspect the repository'],
    ]);
  });

  it('shows configured model details after completed subagent messages are unloaded', () => {
    applyState(
      storePath('allAgents', [
        {
          name: 'explore',
          mode: 'subagent',
          permission: [],
          model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
          variant: 'medium',
        },
      ])
    );
    const part = toolPart('task', {
      ...completedState(
        {
          subagent_type: 'explore',
          prompt: 'Inspect the repository',
        },
        'Inspect the repository'
      ),
      output: '<task_result>Report</task_result>',
      metadata: { sessionId: 'subagent-session-1' },
    });

    renderToolCall(part);
    toggleHeader();

    const rows = Array.from(container?.querySelectorAll('.structured-tool-row') || []);
    expect(
      rows.map((row) => [
        row.querySelector('.structured-tool-label')?.textContent,
        row.querySelector('.structured-tool-value')?.textContent,
      ])
    ).toEqual([
      ['subagent_type', 'explore'],
      ['model', 'openai/gpt-5.6-sol'],
      ['reasoning', 'medium'],
      ['prompt', 'Inspect the repository'],
      ['task_result', 'Report'],
    ]);
  });

  it.each([false, true])(
    'shows the native continuation child model with child messages loaded=%s',
    (messagesLoaded) => {
      applyState(
        storePath('allAgents', [
          {
            name: 'opus',
            mode: 'all',
            permission: [],
            model: { providerID: 'claude-agent', modelID: 'agent-default' },
            variant: 'medium',
          },
        ])
      );
      applyState(
        storePath('sessions', [
          session('subagent-session-1', {
            parentID: 'session-1',
            title: 'Original review',
            time: { created: 500, updated: 500 },
            model: { providerID: 'claude-agent', id: 'opus', variant: 'high' },
          }),
        ])
      );
      const part = toolPart('task', {
        status: 'running',
        input: {
          agent: 'opus',
          sessionID: 'subagent-session-1',
          description: 'Investigate frame-gap root cause',
        },
        metadata: {},
        time: { start: 1_100 },
      });
      applyState(
        storePath('messages', [
          {
            info: assistantMessage('message-1', {
              providerID: 'openai',
              modelID: 'gpt-6.1-sol-fast',
              variant: 'low',
              time: { created: 1_000 },
            }),
            parts: [part],
          },
          ...(messagesLoaded
            ? [
                {
                  info: assistantMessage('child-message', {
                    sessionID: 'subagent-session-1',
                    providerID: 'claude-agent',
                    modelID: 'opus',
                    variant: 'high',
                    time: { created: 1_200 },
                  }),
                  parts: [],
                },
              ]
            : []),
        ])
      );

      renderToolCall(part);
      toggleHeader();

      const detail = container?.querySelector('.structured-tool-card')?.textContent || '';
      expect(detail).toContain('modelclaude-agent/opus');
      expect(detail).toContain('reasoninghigh');
      expect(detail).not.toContain('gpt-6.1-sol-fast');
      expect(detail).not.toContain('agent-default');
      expect(container?.querySelector('.tool-invocation-running-label')?.textContent).toBe(
        'Opus subagent is working'
      );
      expect(
        container?.querySelector<HTMLButtonElement>('.tool-invocation-subagent-running')?.disabled
      ).toBe(false);
    }
  );

  it('uses the native agent model before child session details arrive', () => {
    applyState(
      storePath('allAgents', [
        {
          name: 'opus',
          mode: 'all',
          permission: [],
          model: { providerID: 'claude-agent', modelID: 'opus', variant: 'high' },
        },
      ])
    );
    const part = toolPart('task', {
      status: 'running',
      input: { agent: 'opus', sessionID: 'subagent-session-1' },
      metadata: {},
      time: { start: 1_100 },
    });
    applyState(
      storePath('messages', [
        {
          info: assistantMessage('message-1', {
            providerID: 'openai',
            modelID: 'gpt-6.1-sol-fast',
            variant: 'low',
          }),
          parts: [part],
        },
      ])
    );

    renderToolCall(part);
    toggleHeader();

    const detail = container?.querySelector('.structured-tool-card')?.textContent || '';
    expect(detail).toContain('modelclaude-agent/opus');
    expect(detail).toContain('reasoninghigh');
    expect(detail).not.toContain('gpt-6.1-sol-fast');
  });

  it('uses the resolved task metadata model before stale agent or parent state', () => {
    applyState(
      storePath('sessions', [
        session('subagent-session-1', {
          parentID: 'session-1',
          model: { providerID: 'openai', id: 'stale-session-model', variant: 'low' },
        }),
      ])
    );
    applyState(
      storePath('allAgents', [
        {
          name: 'explore',
          mode: 'subagent',
          permission: [],
        },
      ])
    );
    const part = toolPart('task', {
      ...completedState(
        {
          subagent_type: 'explore',
          prompt: 'Inspect the repository',
        },
        'Inspect the repository'
      ),
      metadata: {
        sessionId: 'subagent-session-1',
        model: { providerID: 'openai', modelID: 'gpt-5.6-terra' },
      },
    });
    applyState(
      storePath('messages', [
        {
          info: assistantMessage('message-1', {
            mode: 'default',
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            variant: 'high',
          }),
          parts: [part],
        },
      ])
    );

    renderToolCall(part);
    toggleHeader();

    const detail = container?.querySelector('.structured-tool-card')?.textContent || '';
    expect(detail).toContain('modelopenai/gpt-5.6-terra');
    expect(detail).toContain('reasoningdefault');
  });

  it.each(['running', 'completed', 'error'] as const)(
    'shows the actual child session model for a %s task without loaded child messages',
    (status) => {
      applyState(
        storePath('allAgents', [
          {
            name: 'explore',
            mode: 'subagent',
            permission: [],
            model: { providerID: 'openai', modelID: 'agent-default' },
            variant: 'high',
          },
        ])
      );
      applyState(
        storePath('sessions', [
          session('subagent-session-1', {
            parentID: 'session-1',
            model: { providerID: 'fixture', id: 'command-override' },
          }),
        ])
      );
      const common = {
        input: { subagent_type: 'explore' },
        metadata: { sessionID: 'subagent-session-1' },
        time: { start: 0, end: 1 },
      };
      const part = toolPart(
        'task',
        status === 'error'
          ? { ...common, status, error: 'Controlled provider failure' }
          : status === 'completed'
            ? { ...common, status, title: 'Command result', output: 'Done' }
            : { ...common, status, title: 'Command running' }
      );
      applyState(
        storePath('messages', [
          {
            info: assistantMessage('message-1', {
              providerID: 'openai',
              modelID: 'parent-model',
              variant: 'medium',
            }),
            parts: [part],
          },
        ])
      );

      renderToolCall(part);
      toggleHeader();

      const detail = container?.querySelector('.structured-tool-card')?.textContent || '';
      expect(detail).toContain('modelfixture/command-override');
      expect(detail).toContain('reasoningdefault');
      expect(detail).not.toContain('agent-default');
      expect(detail).not.toContain('parent-model');
    }
  );

  it('updates task details when child session metadata arrives and survives child history unloading', () => {
    const part = toolPart('task', {
      ...completedState({ subagent_type: 'explore' }, 'Command result', 'Done'),
      metadata: { sessionID: 'subagent-session-1' },
    });
    renderToolCall(part);
    toggleHeader();

    applyState(
      storePath('sessions', [
        session('subagent-session-1', {
          parentID: 'session-1',
          model: { providerID: 'fixture', id: 'command-override', variant: 'low' },
        }),
      ])
    );
    expect(container?.textContent).toContain('modelfixture/command-override');
    expect(container?.textContent).toContain('reasoninglow');

    applyState(
      storePath('messages', [
        {
          info: assistantMessage('child-message', {
            sessionID: 'subagent-session-1',
            providerID: 'fixture',
            modelID: 'executed-model',
            variant: 'high',
          }),
          parts: [],
        },
      ])
    );
    expect(container?.textContent).toContain('modelfixture/executed-model');
    expect(container?.textContent).toContain('reasoninghigh');

    applyState(storePath('messages', []));
    expect(container?.textContent).toContain('modelfixture/command-override');
    expect(container?.textContent).toContain('reasoninglow');
  });

  it('shows inherited model details for agents without a configured model', () => {
    applyState(
      storePath('allAgents', [
        {
          name: 'explore',
          mode: 'subagent',
          permission: [],
          variant: 'low',
        },
      ])
    );
    const part = toolPart(
      'task',
      completedState(
        {
          subagent_type: 'explore',
          prompt: 'Inspect the repository',
        },
        'Inspect the repository'
      )
    );
    applyState(
      storePath('messages', [
        {
          info: assistantMessage('message-1', {
            mode: 'default',
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            variant: 'high',
          }),
          parts: [part],
        },
      ])
    );

    renderToolCall(part);
    toggleHeader();

    const detail = container?.querySelector('.structured-tool-card')?.textContent || '';
    expect(detail).toContain('modelopenai/gpt-5.6-sol');
    expect(detail).toContain('reasoninglow');
  });

  it('does not duplicate the running status dot in expanded task details', () => {
    const part = toolPart('task', {
      status: 'running',
      input: {
        subagent_type: 'explore',
        prompt: 'Review the codebase for performance issues',
      },
      title: 'Scan hotspots',
      metadata: {},
      time: { start: 0 },
    });

    renderToolCall(part);

    toggleHeader();

    expect(container?.querySelectorAll('.tool-call-icon')).toHaveLength(1);
    const taskIcon = container?.querySelector<HTMLElement>('.tool-call-icon-task');
    expect(taskIcon).toBeInstanceOf(HTMLSpanElement);
    expect(taskIcon?.classList).toContain('tool-call-spinner');
    expect(container?.querySelector('.tool-invocation-title')?.classList).not.toContain(
      'shimmer-progress'
    );
    const runningStatus = container?.querySelector('.tool-invocation-subagent-running');
    const workingIcon = runningStatus?.querySelector<HTMLElement>('.tool-invocation-working-icon');
    expect(runningStatus?.getAttribute('aria-live')).toBe('polite');
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    expect((runningStatus as HTMLButtonElement | null)?.disabled).toBe(true);
    expect(workingIcon).toBeInstanceOf(HTMLSpanElement);
    expect(workingIcon?.classList).toContain('ui-icon');
    expect(workingIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    expect(workingIcon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(hourglassIcon));
    expect(runningStatus?.querySelector('.tool-invocation-activity-ring')).toBeNull();
    expect(runningStatus?.textContent).toContain('Explore subagent is working');
    expect(runningStatus?.textContent).toContain('Results will appear here when ready.');
  });

  it.each(['running', 'completed'] as const)(
    'shows a wait icon when a %s launch has a subagent blocked on permission',
    (status) => {
      applyState(
        storePath('sessions', [
          session('session-1'),
          session('subagent-session-1', { parentID: 'session-1' }),
        ])
      );
      applyState(
        storePath('permissions', [
          {
            id: 'permission-1',
            type: 'bash',
            sessionID: 'subagent-session-1',
            messageID: 'subagent-message-1',
            callID: 'subagent-call-1',
            title: 'Run tests',
            metadata: {},
            time: { created: 1 },
          },
        ])
      );
      applyState(storePath('sessionStatus', { 'subagent-session-1': { type: 'busy' } }));
      const part = toolPart(
        'task',
        status === 'completed'
          ? {
              ...completedState({ background: true }, 'Review implementation', 'Working'),
              metadata: { sessionId: 'subagent-session-1' },
            }
          : {
              status,
              input: { prompt: 'Review the implementation' },
              title: 'Review implementation',
              metadata: { sessionId: 'subagent-session-1' },
              time: { start: 0 },
            }
      );

      renderToolCall(part);

      const icon = container?.querySelector<HTMLElement>('.tool-call-icon-task');
      expect(icon).toBeInstanceOf(HTMLSpanElement);
      expect(icon?.classList).toContain('tool-call-wait-icon');
      expect(icon?.classList).not.toContain('tool-call-spinner');
      expect(icon?.getAttribute('aria-label')).toBe('Waiting for permission');
      expect(icon?.getAttribute('role')).toBe('status');
      expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('16px');
      expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('16px');
      expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(hourglassIcon));
    }
  );

  it.each([true, false])(
    'tracks child status after a completed launch with background input %s',
    (background) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      flushSolid();
      const part = toolPart('task', {
        ...completedState(
          { background, subagent_type: 'general', description: 'Audit gap attribution evidence' },
          'Audit gap attribution evidence',
          'The subagent is working in the background.'
        ),
        metadata: { sessionID: 'subagent-session-1' },
        time: { start: background ? 1_000 : 1_001, end: 3_000 },
      });
      renderToolCall(part);
      const icon = () => container?.querySelector<HTMLElement>('.tool-call-icon-task');
      const label = () => container?.querySelector('.tool-invocation-task-status')?.textContent;
      expect(label()).toBeUndefined();
      expect(icon()?.classList).toContain('tool-call-spinner');
      expect(icon()?.classList).not.toContain('tool-status-completed');
      toggleHeader();
      container?.querySelector<HTMLButtonElement>('.tool-invocation-subagent-running')?.click();
      flushSolid();
      expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('subagent-session-1');
      selectSessionMock.mockClear();

      // The status can arrive after history, without changing the completed tool part.
      applyState(storePath('sessionStatus', { 'subagent-session-1': { type: 'busy' } }));
      expect(label()).toBeUndefined();
      expect(icon()?.getAttribute('aria-label')).toBe('Running');
      expect(icon()?.classList).toContain('tool-call-spinner');
      expect(icon()?.classList).not.toContain('tool-status-completed');
      const elapsed = container?.querySelector('.tool-invocation-duration');
      expect(elapsed?.textContent).toBe('9s');
      expect(elapsed?.getAttribute('title')).toBe('Elapsed time');

      const working = () => container?.querySelector('.tool-invocation-subagent-running');
      expect(working()?.textContent).toContain('General subagent is working');
      expect(container?.querySelector('.tool-invocation-subagent-link')).toBeNull();
      expect(container?.querySelector('.structured-tool-card')?.textContent).toContain(
        'The subagent is working in the background.'
      );
      container?.querySelector<HTMLButtonElement>('.tool-invocation-subagent-running')?.click();
      flushSolid();
      expect(selectSessionMock).toHaveBeenCalledWith('subagent-session-1');

      applyState(
        storePath('sessionStatus', 'subagent-session-1', {
          type: 'retry',
          attempt: 2,
          message: 'rate limit exceeded',
          next: 15_000,
        })
      );
      expect(label()).toBeUndefined();
      expect(icon()?.classList).toContain('tool-call-spinner');
      expect(working()?.textContent).toContain('General subagent is retrying');
      expect(working()?.textContent).toContain('Attempt 2 · rate limit exceeded');
      expect(container?.querySelector('.tool-invocation-retry-label')?.textContent).toBe(
        'retrying #2'
      );

      // A later retry keeps the status truthy; the running detail must still follow it.
      applyState(
        storePath('sessionStatus', 'subagent-session-1', {
          type: 'retry',
          attempt: 3,
          message: 'provider overloaded',
          next: 30_000,
        })
      );
      expect(working()?.textContent).toContain('Attempt 3 · provider overloaded');

      applyState(storePath('sessionStatus', 'subagent-session-1', { type: 'idle' }));
      expect(label()).toBeUndefined();
      expect(icon()?.getAttribute('aria-label')).toBe('Completed');
      expect(icon()?.classList).toContain('tool-status-completed');
      expect(icon()?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(checkCircleIcon));
      expect(icon()?.classList).not.toContain('tool-call-spinner');
      expect(container?.querySelector('.tool-invocation-subagent-link')?.textContent).toBe(
        'Open subagent session'
      );
      expect(container?.querySelector('.tool-invocation-retry-label')).toBeNull();
      expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('2s');
      expect(part.state.status).toBe('completed');
      cleanup?.();
      flushSolid();
      resetToolCallExpansionState();
      flushSolid();
      cleanup = render(() => ToolCall({ part: structuredClone(part) }), container!);
      flushSolid();
      expect(icon()?.getAttribute('aria-label')).toBe('Completed');
    }
  );

  it('keeps a native follow-up running across idle until the current result arrives', () => {
    const childID = 'subagent-session-1';
    applyState(storePath('sessionStatus', { [childID]: { type: 'idle' } }));
    const part = toolPart('task', {
      ...completedState({ sessionID: childID }, 'Continue review', '(no preview)'),
      metadata: { sessionID: childID, status: 'running' },
      time: { start: 1_000, end: 2_000 },
    });
    renderToolCall(part);
    const label = () => container?.querySelector('.tool-invocation-task-status')?.textContent;

    expect(label()).toBeUndefined();
    expect(container?.querySelector('.tool-call-spinner')).not.toBeNull();
    expect(container?.querySelector('.tool-status-completed')).toBeNull();
    applyState(storePath('sessionStatus', childID, { type: 'busy' }));
    expect(label()).toBeUndefined();
    expect(container?.querySelector('.tool-call-spinner')?.getAttribute('aria-label')).toBe(
      'Running'
    );
    applyState(storePath('sessionStatus', childID, { type: 'idle' }));
    expect(label()).toBeUndefined();
    expect(container?.querySelector('.tool-status-completed')).toBeNull();
    expect(container?.querySelector('.tool-call-spinner')?.getAttribute('aria-label')).toBe(
      'Running'
    );
  });

  it('restores completed status from verified parent history without a child status', () => {
    const childID = 'subagent-session-1';
    const part = toolPart('task', {
      ...completedState({ sessionID: childID }, 'Continue review', '(no preview)'),
      metadata: { sessionID: childID, status: 'running' },
      time: { start: 1_000, end: 2_000 },
    });
    const result = (
      id: string,
      created: number,
      backgroundPending?: boolean,
      state: 'error' | 'completed' = 'completed'
    ) => ({
      info: {
        id,
        sessionID: part.sessionID,
        role: 'user' as const,
        agent: 'build',
        model: { providerID: 'test', modelID: 'parent' },
        time: { created },
      },
      parts: [
        {
          id: `${id}:text`,
          messageID: id,
          sessionID: part.sessionID,
          type: 'text' as const,
          text: 'Review complete',
          synthetic: true,
          subagentResult: { sessionID: childID, state, backgroundPending },
        },
      ],
    });
    applyState(storePath('messages', [result('earlier-round', 900)]));
    renderToolCall(part);
    const label = () => container?.querySelector('.tool-invocation-task-status')?.textContent;
    expect(label()).toBeUndefined();
    expect(container?.querySelector('.tool-call-spinner')).not.toBeNull();
    applyState(storePath('sessionStatus', childID, { type: 'idle' }));
    expect(label()).toBeUndefined();
    expect(container?.querySelector('.tool-call-spinner')).not.toBeNull();
    const interim = result('interim-result', 2_100, true);
    applyState(storePath('messages', [result('earlier-round', 900), interim]));
    expect(container?.querySelector('.tool-call-spinner')).not.toBeNull();
    expect(container?.querySelector('.tool-status-completed')).toBeNull();
    applyState(
      storePath('sessionStatus', childID, {
        type: 'busy',
        background: true,
        backgroundCommand: 'go test -race',
      })
    );
    applyState(
      storePath('messages', [result('earlier-round', 900), interim, result('final-result', 2_200)])
    );
    expect(container?.querySelector('.tool-call-spinner')).not.toBeNull();
    expect(container?.querySelector('.tool-status-completed')).toBeNull();
    applyState(storePath('sessionStatus', childID, { type: 'idle' }));
    expect(label()).toBeUndefined();
    expect(container?.querySelector('.tool-status-completed')?.getAttribute('aria-label')).toBe(
      'Completed'
    );

    // Resume the same child in a different call. Its busy status and failure
    // belong to the follow-up, even after both cards remount from history.
    const followup: ToolPart = {
      ...part,
      id: 'tool-2',
      callID: 'call-2',
      messageID: 'message-2',
      state: {
        ...completedState({ sessionID: childID }),
        metadata: { status: 'running' },
        time: { start: 3_000, end: 3_001 },
      },
    };
    const history = [
      { info: assistantMessage(part.messageID), parts: [part] },
      result('final-result', 2_200),
      {
        info: assistantMessage(followup.messageID, { time: { created: 3_000 } }),
        parts: [followup],
      },
    ];
    applyState(storePath('messages', history));
    applyState(storePath('sessionStatus', childID, { type: 'busy' }));
    expect(container?.querySelector('.tool-call-icon-task')?.classList).toContain(
      'tool-status-completed'
    );
    applyState(
      storePath('messages', [...history, result('followup-failed', 3_100, false, 'error')])
    );
    applyState(storePath('sessionStatus', childID, { type: 'idle' }));
    cleanup?.();
    flushSolid();
    cleanup = render(() => [ToolCall({ part }), ToolCall({ part: followup })], container!);
    flushSolid();
    const icons = container!.querySelectorAll('.tool-call-icon-task');
    expect(icons[0]?.classList).toContain('tool-status-completed');
    expect(icons[1]?.classList).toContain('tool-status-error');
  });

  it.each([false, true])(
    'settles a superseded native launch without its own final result, background pending: %s',
    (backgroundPending) => {
      const childID = 'subagent-session-1';
      const part = toolPart('task', {
        ...completedState({ sessionID: childID }, 'Fix reserve'),
        metadata: { sessionID: childID, status: 'running' },
        time: { start: 1_000, end: 1_001 },
      });
      const followup: ToolPart = {
        ...part,
        id: 'tool-2',
        messageID: 'message-2',
        callID: 'call-2',
        state: {
          ...completedState({ sessionID: childID }, 'Preserve reproduction'),
          metadata: { sessionID: childID, status: 'running' },
          time: { start: 2_000, end: 2_001 },
        },
      };
      const result = (id: string, created: number, pending: boolean) => ({
        info: {
          id,
          sessionID: part.sessionID,
          role: 'user' as const,
          agent: 'build',
          model: { providerID: 'test', modelID: 'parent' },
          time: { created },
        },
        parts: [
          {
            id: `${id}:text`,
            messageID: id,
            sessionID: part.sessionID,
            type: 'text' as const,
            text: 'Reserve fixed',
            synthetic: true,
            subagentResult: {
              sessionID: childID,
              state: 'completed' as const,
              backgroundPending: pending,
            },
          },
        ],
      });
      const history = [
        { info: assistantMessage(part.messageID), parts: [part] },
        ...(backgroundPending ? [result('interim-result', 1_500, true)] : []),
      ];
      applyState(storePath('messages', history));
      cleanup = render(() => [ToolCall({ part }), ToolCall({ part: followup })], container!);
      flushSolid();
      const icons = () => container!.querySelectorAll('.tool-call-icon-task');
      expect(icons()[0]?.classList).toContain('tool-status-running');

      // The same child gets a follow-up before it delivers a final result.
      history.push({
        info: assistantMessage(followup.messageID, { time: { created: 2_000 } }),
        parts: [followup],
      });
      applyState(storePath('messages', [...history]));
      applyState(storePath('sessionStatus', childID, { type: 'busy' }));
      expect(icons()[0]?.classList).toContain('tool-status-completed');
      expect(icons()[1]?.classList).toContain('tool-status-running');

      applyState(storePath('sessionStatus', childID, { type: 'idle' }));
      expect(icons()[1]?.classList).toContain('tool-status-running');
      applyState(storePath('messages', [...history, result('final-result', 3_000, false)]));
      expect(icons()[0]?.classList).toContain('tool-status-completed');
      expect(icons()[1]?.classList).toContain('tool-status-completed');

      // A cold history render has no observed busy-to-idle transition.
      cleanup();
      flushSolid();
      resetToolCallExpansionState();
      flushSolid();
      applyState(storePath('sessionStatus', {}));
      cleanup = render(() => [ToolCall({ part }), ToolCall({ part: followup })], container!);
      flushSolid();
      expect(icons()[0]?.classList).toContain('tool-status-completed');
      expect(icons()[1]?.classList).toContain('tool-status-completed');
      expect(container?.querySelector('.tool-call-spinner')).toBeNull();
    }
  );

  it.each(['completed', 'error'] as const)(
    'does not mark a %s task running because another child is busy',
    (status) => {
      applyState(storePath('sessionStatus', { 'other-child': { type: 'busy' } }));
      const part = toolPart(
        'task',
        status === 'completed'
          ? {
              ...completedState({}, 'Audit', 'Done'),
              metadata: { sessionID: 'subagent-session-1' },
            }
          : {
              status,
              input: { background: true },
              metadata: { sessionID: 'subagent-session-1' },
              error: 'Launch failed',
              time: { start: 0, end: 1 },
            }
      );
      renderToolCall(part);
      expect(container?.querySelector('.tool-call-spinner')).toBeNull();
      expect(container?.querySelector('.tool-call-icon-task')?.classList).toContain(
        `tool-status-${status}`
      );

      if (status === 'error') {
        applyState(storePath('sessionStatus', 'subagent-session-1', { type: 'busy' }));
        expect(container?.querySelector('.tool-call-spinner')).toBeNull();
        expect(container?.querySelector('.tool-call-icon-task')?.classList).toContain(
          'tool-status-error'
        );
      }
      flushSolid();
    }
  );

  it('opens the running subagent session from its status card', () => {
    applyState(storePath('activeSessionId', 'session-1'));
    const part = toolPart('task', {
      status: 'running',
      input: {
        subagent_type: 'general',
        prompt: 'Review the implementation',
      },
      title: 'Review implementation',
      metadata: { sessionId: 'subagent-session-1' },
      time: { start: 0 },
    });

    renderToolCall(part);
    toggleHeader();

    const runningStatus = container?.querySelector<HTMLButtonElement>(
      '.tool-invocation-subagent-running'
    );
    expect(runningStatus?.disabled).toBe(false);
    expect(runningStatus?.title).toBe('Open subagent session');

    runningStatus?.click();
    flushSolid();

    expect(selectSessionMock).toHaveBeenCalledWith('subagent-session-1');
    expect(getDirectSessionReturnId('subagent-session-1')).toBe('session-1');
  });

  it.each(['completed', 'error'] as const)(
    'opens a %s child using native metadata instead of a matching title',
    (status) => {
      applyState(storePath('activeSessionId', 'session-1'));
      applyState(
        storePath('sessions', [
          session('wrong-child', { title: 'Audit auth', parentID: 'session-1' }),
        ])
      );
      const part: ToolPart = {
        id: 'native-result',
        sessionID: 'session-1',
        messageID: 'native-message',
        type: 'tool',
        tool: 'task',
        callID: 'native-result',
        state:
          status === 'completed'
            ? {
                ...completedState({ description: 'Audit auth' }, 'Audit auth', 'Result'),
                metadata: { sessionID: 'native-child' },
              }
            : {
                status: 'error',
                input: { description: 'Audit auth' },
                error: 'Child failed',
                metadata: { sessionID: 'native-child' },
                time: { start: 0, end: 1 },
              },
      };
      renderToolCall(part);
      expect(selectSessionMock).not.toHaveBeenCalled();
      expect(container?.querySelector('.tool-invocation-header-shell')?.textContent).not.toContain(
        'Open subagent session'
      );
      expect(container?.querySelector('.tool-invocation-subagent-link')).toBeNull();
      toggleHeader();
      const open = container?.querySelector<HTMLButtonElement>(
        '.tool-invocation-detail .tool-invocation-subagent-link'
      );
      expect(open?.textContent).toBe('Open subagent session');
      open?.click();
      flushSolid();
      expect(selectSessionMock).toHaveBeenCalledExactlyOnceWith('native-child');
      expect(getDirectSessionReturnId('native-child')).toBe('session-1');
      toggleHeader();
      expect(container?.querySelector('.tool-invocation-subagent-link')).toBeNull();
    }
  );

  it('opens a resumed subagent session from task_id', () => {
    applyState(storePath('activeSessionId', 'session-1'));
    applyState(
      storePath('sessions', [
        session('session-1', { time: { created: 1_000, updated: 2_000 } }),
        session('subagent-session-1', {
          parentID: 'session-1',
          time: { created: 500, updated: 2_000 },
        }),
      ])
    );
    const part = toolPart('task', {
      status: 'running',
      input: {
        task_id: 'subagent-session-1',
        subagent_type: 'general',
        prompt: 'Continue reviewing the implementation',
      },
      title: 'Continue implementation review',
      metadata: {},
      time: { start: 2_100 },
    });
    applyState(
      storePath('messages', [
        {
          info: assistantMessage('message-1', { time: { created: 2_000 } }),
          parts: [part],
        },
      ])
    );

    renderToolCall(part);
    toggleHeader();

    const runningStatus = container?.querySelector<HTMLButtonElement>(
      '.tool-invocation-subagent-running'
    );
    expect(runningStatus?.disabled).toBe(false);

    runningStatus?.click();
    flushSolid();

    expect(selectSessionMock).toHaveBeenCalledWith('subagent-session-1');
    expect(getDirectSessionReturnId('subagent-session-1')).toBe('session-1');
  });

  it('shows retry status when subagent session is retrying', () => {
    applyState(
      storePath('sessionStatus', {
        'subagent-session-1': {
          type: 'retry' as const,
          attempt: 2,
          message: 'rate limit exceeded',
          next: Date.now() + 5000,
        },
      })
    );

    const part = toolPart('task', {
      status: 'running',
      input: {
        prompt: 'Do something',
      },
      title: 'Working',
      metadata: { sessionId: 'subagent-session-1' },
      time: { start: 0 },
    });

    renderToolCall(part);

    const retryLabel = container?.querySelector('.tool-invocation-retry-label');
    expect(retryLabel?.textContent).toContain('retrying #2');

    toggleHeader();
    const runningDiv = container?.querySelector('.tool-invocation-running');
    expect(runningDiv?.textContent).toContain('Subagent is retrying');
    expect(runningDiv?.textContent).toContain('Attempt 2');
    expect(runningDiv?.textContent).toContain('rate limit exceeded');
  });

  it('shows an active subagent status when task has no retry status', () => {
    const part = toolPart('task', {
      status: 'running',
      input: {
        prompt: 'Do something',
      },
      title: 'Working',
      metadata: { sessionId: 'subagent-session-no-retry' },
      time: { start: 0 },
    });

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-retry-label')).toBeNull();

    toggleHeader();
    expect(container?.querySelector('.tool-invocation-running')?.textContent).toContain(
      'Subagent is working'
    );
  });

  it('shows only the session aggregate as the subagent session total', () => {
    // Loaded rows can be a partial window, so they never stand in for the session total.
    setState(
      storePath('messages', [
        {
          info: assistantMessage('subagent-assistant-1', {
            sessionID: 'subagent-session-1',
            cost: 9,
            tokens: { input: 9_999, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
          parts: [],
        },
      ])
    );
    applyState(
      storePath('sessions', [
        session('subagent-session-1', {
          cost: 0.009,
          tokens: { input: 3, output: 50, reasoning: 6, cache: { read: 1_000, write: 1_231 } },
        }),
      ])
    );

    const part = toolPart('task', {
      status: 'running',
      input: {
        prompt: 'Do something',
      },
      title: 'Working',
      metadata: { sessionId: 'subagent-session-1' },
      time: { start: 0 },
    });

    renderToolCall(part);

    const stats = container?.querySelector('.tool-invocation-token-stats');
    expect(stats?.textContent).toBe('↑ 1.2K ↓ 56');
    expect(container?.querySelector('.tool-invocation-token-label')?.textContent).toBe('Σ1');
    expect(stats?.querySelector('.diff-lines-added')).toBeNull();
    expect(container?.querySelector('.tool-invocation-cost')).toBeNull();
    toggleHeader();
    const costRow = () =>
      [...(container?.querySelectorAll('.structured-tool-row') ?? [])].find(
        (row) => row.querySelector('.structured-tool-label')?.textContent === 'cost'
      );
    expect(costRow()?.querySelector('.structured-tool-value')?.textContent).toBe('<$0.01');
    expect(
      costRow()?.previousElementSibling?.querySelector('.structured-tool-label')?.textContent
    ).toBe('reasoning');
    applyState(storePath('sessions', 0, 'cost', 0.07));
    expect(costRow()?.querySelector('.structured-tool-value')?.textContent).toBe('$0.07');
    expect(container?.querySelector('.tool-invocation-header')?.textContent).not.toContain('$');
  });

  it('hides usage until the subagent session total loads', () => {
    const part = toolPart('task', {
      status: 'running',
      input: {
        prompt: 'Do something',
      },
      title: 'Working',
      metadata: { sessionId: 'subagent-session-1' },
      time: { start: 0 },
    });

    renderToolCall(part);

    // Missing totals are unknown, not zero.
    expect(container?.querySelector('.tool-invocation-token-stats')).toBeNull();
    expect(container?.querySelector('.tool-invocation-token-label')).toBeNull();

    applyState(
      storePath('sessions', [
        session('subagent-session-1', {
          tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ])
    );
    expect(container?.querySelector('.tool-invocation-token-label')?.textContent).toBe('Σ1');
    expect(container?.querySelector('.tool-invocation-token-stats')?.textContent).toBe('↑ 12 ↓ 3');
  });

  it.each(['task', 'bash', 'apply_patch'])(
    'updates the elapsed duration while %s is running',
    (tool) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      flushSolid();
      const part = toolPart(tool, {
        status: 'running',
        input: { description: 'Inspect the repository', command: 'npm run test' },
        title: 'Inspect the repository',
        metadata: {},
        time: { start: 5_000 },
      });

      renderToolCall(part);

      expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('5s');

      vi.advanceTimersByTime(2_000);
      flushSolid();

      expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('7s');
      vi.advanceTimersByTime(62_000);
      flushSolid();

      expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('1m 9s');
    }
  );

  it('shows the running subagent session activity age only while Alt is held', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    flushSolid();
    applyState(
      storePath('sessions', [
        session('subagent-session-1', {
          time: { created: 1_000, updated: 7_000 },
        }),
      ])
    );
    const part = toolPart('task', {
      status: 'running',
      input: { description: 'Inspect the repository' },
      title: 'Inspect the repository',
      metadata: { sessionId: 'subagent-session-1' },
      time: { start: 1_000 },
    });

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-activity-age')).toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    flushSolid();

    const activityAge = container?.querySelector('.tool-invocation-activity-age');
    expect(activityAge?.textContent).toBe('last active 3s ago');
    expect(activityAge?.querySelector('.tool-invocation-activity-time')?.textContent).toBe('3s');
    expect(activityAge?.getAttribute('title')).toBe('Last session activity');
    expect(container?.querySelector('.tool-invocation-token-stats')).toBeNull();
    expect(container?.querySelector('.tool-invocation-duration')).toBeNull();

    vi.advanceTimersByTime(2_000);
    flushSolid();
    expect(activityAge?.textContent).toBe('last active 5s ago');

    applyState(storePath('sessions', 0, 'time', 'updated', 11_000));
    expect(activityAge?.textContent).toBe('last active 1s ago');

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    flushSolid();
    expect(container?.querySelector('.tool-invocation-activity-age')).toBeNull();
    expect(container?.querySelector('.tool-invocation-token-stats')).toBeNull();
    expect(container?.querySelector('.tool-invocation-token-label')).toBeNull();
    expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('11s');
  });

  it('clears the running subagent activity age when the window loses focus', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    flushSolid();
    applyState(
      storePath('sessions', [
        session('subagent-session-1', {
          time: { created: 1_000, updated: 7_000 },
        }),
      ])
    );
    const part = toolPart('task', {
      status: 'running',
      input: { description: 'Inspect the repository' },
      title: 'Inspect the repository',
      metadata: { sessionId: 'subagent-session-1' },
      time: { start: 1_000 },
    });

    renderToolCall(part);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    flushSolid();
    expect(container?.querySelector('.tool-invocation-activity-age')?.textContent).toBe(
      'last active 3s ago'
    );

    window.dispatchEvent(new Event('blur'));
    flushSolid();
    expect(container?.querySelector('.tool-invocation-activity-age')).toBeNull();
  });

  it('uses subagent session token snapshots when message tokens are unavailable', () => {
    applyState(
      storePath('sessions', [
        session('subagent-session-1', {
          tokens: {
            input: 3,
            output: 130,
            reasoning: 5,
            cache: { read: 2_000, write: 2_465 },
          },
        }),
      ])
    );

    const part = toolPart('task', {
      status: 'running',
      input: {
        prompt: 'Do something',
      },
      title: 'Working',
      metadata: { sessionId: 'subagent-session-1' },
      time: { start: 0 },
    });

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-token-stats')?.textContent).toBe(
      '↑ 2.5K ↓ 135'
    );
  });

  it('does not attribute session totals to a subagent session inferred from its title', () => {
    const part = toolPart('task', {
      status: 'running',
      input: {
        description: 'Research Varro SDK usage',
        prompt: 'Do something',
      },
      title: 'Research Varro SDK usage',
      metadata: {},
      time: { start: 0 },
    });
    const otherTask: ToolPart = {
      ...part,
      id: 'tool-2',
      callID: 'call-2',
      state: {
        status: 'running',
        input: { description: 'Research auth flow', prompt: 'Do something else' },
        title: 'Research auth flow',
        metadata: {},
        time: { start: 0 },
      },
    };
    applyState(
      storePath('sessions', [
        session('child-1', {
          parentID: 'session-1',
          title: 'Research Varro SDK usage (@explore subagent)',
          tokens: { input: 321, output: 45, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 11, updated: 12 },
        }),
        session('child-2', {
          parentID: 'session-1',
          title: 'Research auth flow (@explore subagent)',
          tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 12, updated: 13 },
        }),
      ])
    );
    applyState(
      storePath('messages', [
        {
          info: assistantMessage('message-1', {
            mode: 'default',
            sessionID: 'session-1',
            time: { created: 10 },
          }),
          parts: [part, otherTask],
        },
      ])
    );

    renderToolCall(part);

    // The inferred child still links the card, but its totals are not authoritative usage.
    expect(container?.querySelector('.tool-invocation-token-stats')).toBeNull();
    expect(container?.querySelector('.tool-invocation-token-label')).toBeNull();
  });

  it('shows an explicit empty task result when the tagged payload has no content', () => {
    const part = toolPart('task', {
      status: 'completed',
      input: {
        subagent_type: 'explore',
        prompt: 'Inspect the repository',
      },
      output: '<task_result>   </task_result>',
      title: 'Inspect the repository',
      metadata: {},
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);

    toggleHeader();

    const resultRow = container?.querySelector('.structured-tool-row-result');

    expect(resultRow?.textContent).toContain('task_result');
    expect(resultRow?.textContent).toContain('(no output)');
  });

  it('renders aborted tool errors with neutral aborted styling', () => {
    const part = toolPart('browser-bridge_browser_investigate', {
      status: 'error',
      input: { objective: 'Check current page' },
      error: 'Aborted',
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);

    const header = container?.querySelector('.tool-invocation-header');
    const icon = container?.querySelector('.tool-call-icon');
    const label = container?.querySelector('.tool-invocation-error-label');

    expect(icon?.classList.contains('tool-status-aborted')).toBe(true);
    expect(label?.classList.contains('is-aborted')).toBe(true);
    expect(label?.textContent).toBe('aborted');

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (header as HTMLButtonElement).click();
    flushSolid();

    const detail = container?.querySelector('.tool-invocation-error');

    expect(container?.querySelector('.structured-tool-card')).not.toBeNull();
    expect(container?.querySelector('.structured-tool-row-aborted')).not.toBeNull();
    expect(detail?.classList.contains('is-aborted')).toBe(true);
    expect(detail?.textContent).toContain('Aborted');
  });

  it('clamps generic tool errors and opens the full error in an editor tab', () => {
    const send = setExtensionSender();
    flushSolid();
    const error = Array.from({ length: 7 }, (_, index) => `browser failure ${index + 1}`).join(
      '\n'
    );
    const part: ToolPart = {
      id: 'tool-long-error',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-long-error',
      tool: 'browser-bridge_browser_investigate',
      state: {
        status: 'error',
        input: { objective: 'Check current page' },
        error,
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);
    toggleHeader();

    const detail = container?.querySelector<HTMLPreElement>('.tool-invocation-error');
    expect(container?.querySelector('.structured-tool-row-error')).not.toBeNull();
    expect(detail?.classList).toContain('is-truncated');
    expect(detail?.textContent).not.toContain('browser failure 6');

    detail?.click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-text',
      payload: {
        content: error,
        title: 'browser-bridge_browser_investigate (error)',
        language: 'plaintext',
      },
    });
  });

  it('shows a pending command card before its linked permission prompt', () => {
    const part = toolPart('bash', completedState({ command: 'git status' }, 'git status'));

    const permission: Permission = {
      id: 'perm-1',
      type: 'bash',
      sessionID: 'session-1',
      messageID: 'message-1',
      callID: 'call-1',
      title: 'bash git status',
      metadata: {},
      time: { created: 1 },
    };

    applyState(storePath('permissions', [permission]));

    renderToolCall(part);

    const toolHeader = container?.querySelector('.tool-invocation-header');
    const permissionPrompt = container?.querySelector('.permission-prompt');
    const icon = toolHeader?.querySelector('.tool-call-icon');

    expect(toolHeader).not.toBeNull();
    expect(permissionPrompt).not.toBeNull();
    expect(
      (toolHeader?.compareDocumentPosition(permissionPrompt!) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(icon?.classList).toContain('tool-status-pending');
    expect(icon?.classList).toContain('tool-call-wait-icon');
    expect(icon?.classList).not.toContain('tool-call-spinner');
    expect(icon?.getAttribute('aria-label')).toBe('Waiting for permission');
    expect(container?.querySelector('.tool-invocation-title')?.classList).not.toContain(
      'shimmer-progress'
    );
    expect(container?.textContent).toContain('Permission Required');
  });

  it('shows later permission-linked tool cards as waiting without another prompt', () => {
    const part: ToolPart = {
      id: 'tool-2',
      sessionID: 'session-1',
      messageID: 'message-2',
      type: 'tool',
      callID: 'call-2',
      tool: 'bash',
      state: completedState({ command: 'npm test' }, 'npm test'),
    };

    applyState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'bash',
          sessionID: 'session-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'bash git status',
          metadata: {},
          time: { created: 1 },
        },
        {
          id: 'perm-2',
          type: 'bash',
          sessionID: 'session-1',
          messageID: 'message-2',
          callID: 'call-2',
          title: 'bash npm test',
          metadata: {},
          time: { created: 2 },
        },
      ])
    );

    renderToolCall(part);

    expect(container?.querySelector('.permission-prompt')).toBeNull();
    expect(container?.querySelector('.tool-invocation-header')).not.toBeNull();
    const icon = container?.querySelector('.tool-call-icon');
    expect(icon?.classList).toContain('tool-status-pending');
    expect(icon?.classList).toContain('tool-call-wait-icon');
    expect(icon?.classList).not.toContain('tool-call-spinner');
    expect(container?.querySelector('.tool-invocation-title')?.classList).not.toContain(
      'shimmer-progress'
    );
  });

  it('shows one linked permission prompt for duplicate permission requests', () => {
    const part = toolPart('bash', completedState({ command: 'git status' }, 'git status'));

    applyState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'external_directory',
          sessionID: 'session-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'external_directory /tmp/*',
          metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
          time: { created: 2 },
          duplicateIDs: ['perm-1', 'perm-2'],
          groupMembers: [
            { id: 'perm-1', sessionID: 'session-1', messageID: 'message-1', callID: 'call-1' },
            { id: 'perm-2', sessionID: 'session-1', messageID: 'message-1', callID: 'call-1' },
          ],
        },
      ])
    );

    renderToolCall(part);

    expect(container?.querySelectorAll('.permission-prompt')).toHaveLength(1);
    expect(container?.querySelector('.permission-prompt-count')?.textContent).toBe('×2');
  });

  it('shows the collapsed permission prompt only on the primary linked tool call', () => {
    const part: ToolPart = {
      id: 'tool-2',
      sessionID: 'session-1',
      messageID: 'message-2',
      type: 'tool',
      callID: 'call-2',
      tool: 'bash',
      state: completedState({ command: 'git status' }, 'git status'),
    };

    applyState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'external_directory',
          sessionID: 'session-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'external_directory /tmp/*',
          metadata: { filepath: '/tmp/file-a', parentDir: '/tmp' },
          time: { created: 1 },
          duplicateIDs: ['perm-1', 'perm-2'],
          groupMembers: [
            { id: 'perm-1', sessionID: 'session-1', messageID: 'message-1', callID: 'call-1' },
            { id: 'perm-2', sessionID: 'session-1', messageID: 'message-2', callID: 'call-2' },
          ],
        },
      ])
    );

    renderToolCall(part);

    expect(container?.querySelectorAll('.permission-prompt')).toHaveLength(0);
    expect(container?.querySelector('.tool-invocation-header')).not.toBeNull();
    expect(container?.querySelector('.tool-call-wait-icon')).not.toBeNull();
  });

  it('keeps the command card visible when a linked question prompt is pending', () => {
    const part = toolPart('bash', completedState({ command: 'git status' }, 'git status'));

    const question = linkedCommandQuestion();

    applyState(storePath('questions', [question]));

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-header')?.textContent).toContain(
      'git status'
    );
    expect(container?.querySelector('.question-prompt-card')).not.toBeNull();
    expect(container?.textContent).toContain('Which command should run?');
  });

  it('hides the synthetic question tool row when a linked question prompt is pending', () => {
    const part = toolPart('question', completedState({}, 'question'));

    const question = linkedCommandQuestion();

    applyState(storePath('questions', [question]));

    renderToolCall(part);

    expect(container?.querySelector('.tool-invocation-header')).toBeNull();
    expect(container?.querySelector('.question-prompt-card')).not.toBeNull();
  });

  it.each(['pending', 'running'] as const)(
    'hides a %s question tool while its standalone survey is pending',
    (status) => {
      const part = toolPart(
        'question',
        status === 'pending'
          ? { status, input: {}, raw: '' }
          : { status, input: {}, time: { start: 1 } }
      );
      const question: QuestionRequest = {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [{ question: 'Choose one', header: 'Survey', options: [] }],
      };
      applyState(storePath('questions', [question]));

      cleanup = render(
        () => createComponent(ToolCall, { part, questionRequest: null }),
        container!
      );
      flushSolid();

      expect(container?.querySelector('.tool-invocation-header')).toBeNull();
      expect(container?.querySelector('.question-prompt-card')).toBeNull();

      applyState(storePath('questions', []));
      expect(container?.querySelector('.tool-invocation-header')).not.toBeNull();
    }
  );

  it.each(['other-session', 'other-tool', 'completed'] as const)(
    'keeps question tools visible outside the standalone survey replacement: %s',
    (scenario) => {
      const part = toolPart(
        'question',
        scenario === 'completed'
          ? completedState({}, 'question')
          : { status: 'running', input: {}, time: { start: 1 } }
      );
      const question: QuestionRequest = {
        id: 'question-1',
        sessionID: scenario === 'other-session' ? 'child-1' : 'session-1',
        questions: [{ question: 'Choose one', header: 'Survey', options: [] }],
      };
      if (scenario === 'other-tool') {
        question.tool = { messageID: 'message-2', callID: 'call-2' };
      }
      applyState(
        storePath('sessions', [session('session-1'), session('child-1', { parentID: 'session-1' })])
      );
      applyState(storePath('questions', [question]));

      cleanup = render(
        () => createComponent(ToolCall, { part, questionRequest: null }),
        container!
      );
      flushSolid();

      expect(container?.querySelector('.tool-invocation-header')).not.toBeNull();
      expect(container?.querySelector('.question-prompt-card')).toBeNull();
    }
  );

  it.each(['', 'question'])('capitalizes the completed question summary title "%s"', (title) => {
    const part = toolPart(
      'question',
      completedState({ questions: [{ question: 'Which checks should I run?' }] }, title)
    );

    renderToolCall(part);

    expect(container?.querySelector('.question-summary-title')?.textContent).toBe('Question');
  });

  it('shows completed questions and answers as a compact read-only summary', () => {
    const part = toolPart('question', {
      status: 'completed',
      input: {
        questions: [
          { question: 'Which environment should I target?' },
          { question: 'Which checks should I run?', multiple: true },
          { question: 'Anything else?' },
        ],
      },
      output: 'User has answered your questions.',
      title: 'Asked 3 questions',
      metadata: {
        answers: [['Staging'], ['Tests', 'Lint'], []],
      },
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);

    const summary = container?.querySelector('.question-summary-card');
    expect(summary?.querySelector('.question-summary-title')?.textContent).toBe(
      'Asked 3 questions'
    );
    expect(
      summary
        ?.querySelector<HTMLElement>('.question-summary-icon')
        ?.style.getPropertyValue('--ui-icon-width')
    ).toBe('16px');
    expect(
      Array.from(summary?.querySelectorAll('.question-summary-question') || []).map(
        (item) => item.textContent
      )
    ).toEqual([
      'Which environment should I target?',
      'Which checks should I run?',
      'Anything else?',
    ]);
    expect(
      Array.from(summary?.querySelectorAll('.question-summary-answer') || []).map(
        (item) => item.textContent
      )
    ).toEqual(['Staging', 'Tests, Lint', 'Unanswered']);
    expect(summary?.querySelector('button, input')).toBeNull();
    expect(container?.querySelector('.tool-invocation-header')).toBeNull();
  });

  it('shows skipped questions as a compact summary instead of raw JSON', () => {
    const part = toolPart('question', {
      status: 'error',
      input: {
        questions: [
          {
            question: 'Which machine identifier should be used?',
            header: 'Machine identity',
            options: [{ label: 'Anonymous ID', description: 'Use a generated identifier' }],
          },
        ],
      },
      error: 'QuestionRejectedError: The user dismissed this question',
      time: { start: 0, end: 1 },
    });

    renderToolCall(part);

    const summary = container?.querySelector('.question-summary-card.is-skipped');
    expect(summary?.querySelector('.question-summary-title')?.textContent).toBe('Question skipped');
    expect(summary?.querySelector('.question-summary-question')?.textContent).toBe(
      'Which machine identifier should be used?'
    );
    expect(summary?.querySelector('.question-summary-answer')?.textContent).toBe('Skipped');
    expect(summary?.querySelector('button, input')).toBeNull();
    expect(container?.querySelector('.tool-invocation-header')).toBeNull();
    expect(container?.textContent).not.toContain('Anonymous ID');
    expect(container?.textContent).not.toContain('QuestionRejectedError');
  });

  it('lets users select a survey option', () => {
    const part = toolPart('question', completedState({}, 'question'));

    const question = linkedCommandQuestion();

    applyState(storePath('questions', [question]));

    renderToolCall(part);

    expect(
      container
        ?.querySelector<HTMLElement>('.question-prompt-icon')
        ?.style.getPropertyValue('--ui-icon-mask')
    ).toBe(toCssUrl(chatBubbleQuestionIcon));
    const option = container?.querySelector<HTMLLabelElement>('.question-option');
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    expect(option?.classList.contains('selected')).toBe(true);
    expect(container?.querySelector('.question-radio.checked')).not.toBeNull();
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-primary')?.disabled).toBe(
      false
    );
  });

  it('shows the custom answer radio and enables submit when custom text is entered', () => {
    const part = toolPart('question', completedState({}, 'question'));

    const question: QuestionRequest = {
      id: 'question-1',
      sessionID: 'session-1',
      tool: { messageID: 'message-1', callID: 'call-1' },
      questions: [
        {
          question: 'Which command should run?',
          header: 'Choose command',
          options: [{ label: 'npm test', description: 'Run the test suite' }],
        },
      ],
    };

    applyState(storePath('questions', [question]));

    renderToolCall(part);

    const input = container?.querySelector<HTMLTextAreaElement>('.question-custom-input');
    if (!input) throw new Error('Expected custom answer input');
    input.value = 'npm run dev';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();

    expect(container?.querySelector('.question-option-custom.selected')).not.toBeNull();
    expect(container?.querySelector('.question-radio.checked')).not.toBeNull();
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-primary')?.disabled).toBe(
      false
    );
  });

  it('matches a linked permission prompt across the same session tree', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'child-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command: 'git status' }, 'git status'),
    };

    applyState(
      storePath('sessions', [
        {
          id: 'session-1',
          projectID: 'project-1',
          directory: '/repo',
          title: 'Session 1',
          version: '1',
          time: { created: 0, updated: 1 },
        },
        {
          id: 'child-1',
          projectID: 'project-1',
          directory: '/repo',
          parentID: 'session-1',
          title: 'Child 1',
          version: '1',
          time: { created: 0, updated: 2 },
        },
      ])
    );
    applyState(
      storePath('permissions', [
        {
          id: 'perm-1',
          type: 'bash',
          sessionID: 'session-1',
          messageID: 'message-1',
          callID: 'call-1',
          title: 'bash git status',
          metadata: {},
          time: { created: 1 },
        },
      ])
    );

    renderToolCall(part);

    expect(container?.querySelector('.permission-prompt')).not.toBeNull();
  });

  it('renders file reads with computed line ranges and file open links', () => {
    const sendSpy = setExtensionSender();
    flushSolid();
    openRepoWorkspace();

    const part = toolPart(
      'read',
      completedState({ file_path: '/repo/src/main.ts', offset: 4, limit: 3 }, 'Read main.ts')
    );

    renderToolCall(part);

    const target = container?.querySelector<HTMLAnchorElement>('.file-read-target');

    expect(container?.querySelector('.file-read-action-label')?.textContent).toBe('Read:');
    expect(target?.textContent).toBe('main.ts');
    expect(container?.querySelector('.file-read-range')?.textContent).toBe('(L5-7)');
    const fileIcon = target?.querySelector<HTMLImageElement>('.file-read-file-icon');
    expect(fileIcon).toBeInstanceOf(HTMLImageElement);
    expect(fileIcon?.getAttribute('src')).toBe(getFileTypeIcon('/repo/src/main.ts'));
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-read');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(eyeIcon));

    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/src/main.ts', kind: 'file', line: 5 },
    });
  });

  it('uses the stable read-card shell without a transient running label while reads start', () => {
    const part = toolPart('read', {
      status: 'running',
      input: {},
      title: 'read',
      metadata: {},
      time: { start: 0 },
    });

    renderToolCall(part);

    expect(container?.querySelector('.file-read-running-label')).toBeNull();
    expect(container?.querySelector('.tool-invocation-header')).toBeNull();
    expect(container?.querySelector('.file-read-action-label')?.textContent).toBe('Read');
    expect(container?.querySelector('.file-read-action-label')?.classList).toContain(
      'shimmer-progress'
    );
    expect(container?.textContent).not.toContain('reading');
    expect(container?.querySelector('.file-read-card-header')).not.toBeNull();
  });

  it('hides completed file-read durations under one second', () => {
    const part = toolPart(
      'read',
      completedState({ file_path: '/repo/src/main.ts' }, 'Read main.ts')
    );

    renderToolCall(part);

    expect(container?.querySelector('.file-read-duration')).toBeNull();
  });

  it('renders directory and current-directory read states distinctly', () => {
    const sendSpy = setExtensionSender();
    flushSolid();
    openRepoWorkspace();

    const directoryPart = toolPart('read', {
      status: 'completed',
      input: { file_path: '/repo/src' },
      output: '<type>directory</type>',
      title: 'Read src',
      metadata: {},
      time: { start: 0, end: 1 },
    });

    cleanup = render(() => ToolCall({ part: directoryPart }), container!);
    flushSolid();

    const directoryLink = container?.querySelector<HTMLAnchorElement>('.file-read-target');

    expect(directoryLink?.textContent).toBe('src');
    expect(container?.querySelector('.file-read-meta')?.textContent).toBe('directory');
    expect(directoryLink?.querySelector('.file-read-file-icon')).toBeNull();
    expect(directoryLink?.querySelector('.file-read-folder-icon')?.getAttribute('src')).toBe(
      getFolderTypeIcon('/repo/src')
    );

    directoryLink?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/src', kind: 'directory' },
    });

    cleanup?.();
    flushSolid();
    cleanup = undefined;
    container!.innerHTML = '';

    const currentDirectoryPart: ToolPart = {
      id: 'tool-2',
      sessionID: 'session-1',
      messageID: 'message-2',
      type: 'tool',
      callID: 'call-2',
      tool: 'read',
      state: completedState({ file_path: './' }, 'Read current directory'),
    };

    cleanup = render(() => ToolCall({ part: currentDirectoryPart }), container!);
    flushSolid();

    expect(container?.querySelector('.file-read-target-text')?.textContent).toBe(
      'current directory'
    );
    expect(container?.querySelector('.file-read-target[href]')).toBeNull();
    expect(container?.querySelector('.file-read-file-icon')).toBeNull();
  });

  it('recognizes a conventional folder when the read output lacks directory markers', () => {
    const sendSpy = setExtensionSender();
    flushSolid();
    const part: ToolPart = {
      id: 'tool-docs',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-docs',
      tool: 'read',
      state: completedState({ file_path: '/repo/docs' }, 'README.md\narchitecture.md'),
    };

    renderToolCall(part);

    const link = container?.querySelector<HTMLAnchorElement>('.file-read-target');
    expect(link?.querySelector('.file-read-folder-icon')?.getAttribute('src')).toBe(
      getFolderTypeIcon('/repo/docs')
    );
    expect(link?.querySelector('.file-read-file-icon')).toBeNull();
    expect(container?.querySelector('.file-read-meta')?.textContent).toBe('directory');

    link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/docs', kind: 'directory' },
    });
  });

  it('renders read paths containing edit as reads rather than file changes', () => {
    const part: ToolPart = {
      id: 'tool-edit-path-read',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-edit-path-read',
      tool: 'read',
      state: completedState(
        { filePath: 'src/webview/lib/message-edit-state.ts' },
        'src/webview/lib/message-edit-state.ts'
      ),
    };

    renderToolCall(part);

    expect(container?.querySelector('.file-read-card')).not.toBeNull();
    expect(container?.querySelector('.file-read-target')?.textContent).toBe(
      'message-edit-state.ts'
    );
    expect(container?.querySelector('.file-change-card')).toBeNull();
  });
});

describe('FileChangeCard', () => {
  it('labels an edit tool as Edited based on the tool, not workspace git status', () => {
    const fileStatusSpy = vi
      .spyOn(client.file, 'status')
      .mockResolvedValue([{ path: 'src/foo.ts', status: 'added', added: 1, removed: 0 }]);

    const part = toolPart('edit', {
      ...completedState({ file_path: 'src/foo.ts' }, 'Edit src/foo.ts'),
      metadata: { additions: 3, deletions: 1 },
    });

    renderToolCall(part);

    const header = container?.querySelector('.file-change-card-header');
    expect(header?.classList).toContain('is-standalone');
    expect(header?.children[0]?.classList).toContain('file-edit-path-link');
    expect(header?.children[1]?.classList).toContain('file-edit-action-label');
    expect(container?.querySelector('.file-edit-icon')).toBeNull();
    const action = container?.querySelector<HTMLElement>('.file-edit-action-label');
    expect(action?.textContent).toBe('(edited)');
    expect(action?.classList).toContain('has-edit-gradient');
    expect(action?.style.getPropertyValue('--file-edit-gradient-start')).toBe('67%');
    expect(action?.style.getPropertyValue('--file-edit-gradient-end')).toBe('83%');
    const icon = container?.querySelector<HTMLImageElement>('.file-edit-file-icon');
    expect(icon).toBeInstanceOf(HTMLImageElement);
    expect(icon?.getAttribute('src')).toBe(getFileTypeIcon('src/foo.ts'));
    expect(fileStatusSpy).not.toHaveBeenCalled();

    cleanup?.();
    flushSolid();
    cleanup = undefined;
    container!.innerHTML = '';
    cleanup = render(() => ToolCall({ part, compactFileChanges: true }), container!);
    flushSolid();

    const compactHeader = container?.querySelector('.file-change-card-header');
    expect(compactHeader?.classList).not.toContain('is-standalone');
    expect(compactHeader?.children[0]?.classList).toContain('tool-call-icon');
    expect(compactHeader?.children[1]?.classList).toContain('file-edit-action-label');
    expect(compactHeader?.children[2]?.classList).toContain('file-edit-path-link');
    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Edited:');
  });

  it('labels a create tool as Added without consulting workspace git status', () => {
    const fileStatusSpy = vi
      .spyOn(client.file, 'status')
      .mockResolvedValue([{ path: 'src/new.ts', status: 'modified', added: 1, removed: 0 }]);

    const part = toolPart(
      'create',
      completedState({ file_path: 'src/new.ts' }, 'Create src/new.ts')
    );

    renderToolCall(part);

    const action = container?.querySelector('.file-edit-action-label');
    expect(action?.textContent).toBe('(added)');
    expect(action?.classList).toContain('is-added');
    expect(container?.querySelector('a.file-edit-path-link')).not.toBeNull();
    expect(fileStatusSpy).not.toHaveBeenCalled();
  });

  it('labels a delete tool as Removed without consulting workspace git status', () => {
    const fileStatusSpy = vi.spyOn(client.file, 'status').mockResolvedValue([]);

    const part = toolPart(
      'delete',
      completedState({ file_path: 'src/gone.ts' }, 'Delete src/gone.ts')
    );

    renderToolCall(part);

    const action = container?.querySelector('.file-edit-action-label');
    expect(action?.textContent).toBe('(removed)');
    expect(action?.classList).toContain('is-removed');
    expect(container?.querySelector('a.file-edit-path-link')).toBeNull();
    expect(container?.querySelector('.file-edit-removed-path')?.textContent).toBe('src/gone.ts');
    expect(fileStatusSpy).not.toHaveBeenCalled();
  });

  it('labels a rename tool as Moved without consulting workspace git status', () => {
    const fileStatusSpy = vi.spyOn(client.file, 'status').mockResolvedValue([]);

    const part = toolPart(
      'rename',
      completedState(
        { from_path: 'src/old.ts', to_path: 'src/new.ts' },
        'Rename src/old.ts -> src/new.ts'
      )
    );

    renderToolCall(part);

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('(moved)');
    expect(fileStatusSpy).not.toHaveBeenCalled();
  });

  it('shows move paths, diff stats, and open-path links for completed renames', () => {
    const sendSpy = setExtensionSender();
    flushSolid();
    openRepoWorkspace();

    const part = toolPart('rename', {
      status: 'completed',
      input: { from_path: '/repo/src/old.ts', to_path: '/repo/src/new.ts' },
      output: '',
      title: 'Rename src/old.ts -> src/new.ts',
      metadata: { additions: 2, deletions: 1 },
      time: { start: 0, end: 1500 },
    });

    renderToolCall(part);

    const links = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>('.file-edit-path-link') || []
    );

    expect(links.map((link) => link.textContent)).toEqual(['src/old.ts', 'src/new.ts']);
    expect(container?.querySelector('.file-edit-diff-stats')?.textContent).toContain('+2');
    expect(container?.querySelector('.file-edit-diff-stats')?.textContent).toContain('-1');
    expect(container?.querySelector('.file-edit-duration')).toBeNull();

    links[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    links[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    expect(sendSpy).toHaveBeenNthCalledWith(1, {
      type: 'vscode/open',
      payload: { path: '/repo/src/old.ts', kind: 'file', view: 'diff' },
    });
    expect(sendSpy).toHaveBeenNthCalledWith(2, {
      type: 'vscode/open',
      payload: { path: '/repo/src/new.ts', kind: 'file', view: 'diff' },
    });
  });

  it('shows separate rows and per-file stats for multi-file apply_patch metadata', () => {
    const sendSpy = setExtensionSender();
    flushSolid();
    openRepoWorkspace();

    const part = toolPart('apply_patch', {
      status: 'completed',
      input: {},
      output: '',
      title: 'apply_patch',
      metadata: {
        files: [
          { type: 'add', relativePath: 'src/new.ts', additions: 2, deletions: 0 },
          { type: 'update', relativePath: 'src/app.ts', additions: 3, deletions: 1 },
        ],
      },
      time: { start: 0, end: 1500 },
    });

    renderToolCall(part);

    const rows = Array.from(container?.querySelectorAll<HTMLElement>('.file-change-card') || []);
    const links = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>('.file-change-card .file-edit-path-link') || []
    );

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.querySelector('.file-edit-action-label')?.textContent)).toEqual([
      '(added)',
      '(edited)',
    ]);
    expect(links.map((link) => link.textContent)).toEqual(['src/new.ts', 'src/app.ts']);
    expect(
      links.map((link) =>
        link.querySelector<HTMLImageElement>('.file-edit-file-icon')?.getAttribute('src')
      )
    ).toEqual([getFileTypeIcon('src/new.ts'), getFileTypeIcon('src/app.ts')]);
    expect(container?.querySelector('.file-change-card-header')?.textContent).not.toContain(
      '2 files'
    );
    expect(container?.querySelector('.file-edit-more-count')).toBeNull();
    expect(rows[0]?.querySelector('.file-edit-diff-stats')?.textContent).toContain('+2');
    expect(rows[0]?.querySelector('.file-edit-diff-stats')?.textContent).toContain('-0');
    expect(rows[1]?.querySelector('.file-edit-diff-stats')?.textContent).toContain('+3');
    expect(rows[1]?.querySelector('.file-edit-diff-stats')?.textContent).toContain('-1');

    links[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/app.ts', kind: 'file', view: 'diff' },
    });
  });

  it('renders every completed file change as a separate row', () => {
    const sendSpy = setExtensionSender();
    flushSolid();
    const part = toolPart('apply_patch', {
      status: 'completed',
      input: {},
      output: '',
      title: 'apply_patch',
      metadata: {
        files: [
          { type: 'update', relativePath: 'src/one.ts', additions: 1, deletions: 0 },
          { type: 'update', relativePath: 'src/two.ts', additions: 1, deletions: 0 },
          { type: 'update', relativePath: 'src/three.css', additions: 1, deletions: 0 },
          { type: 'update', relativePath: 'src/four.mjs', additions: 1, deletions: 0 },
        ],
      },
      time: { start: 0, end: 1500 },
    });

    renderToolCall(part);

    const rows = Array.from(container?.querySelectorAll<HTMLElement>('.file-change-card') || []);
    const links = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>('.file-change-card .file-edit-path-link') || []
    );

    expect(rows).toHaveLength(4);
    expect(links.map((link) => link.textContent)).toEqual([
      'src/one.ts',
      'src/two.ts',
      'src/three.css',
      'src/four.mjs',
    ]);
    expect(document.querySelector('.file-edit-more-menu')).toBeNull();
    expect(container?.querySelector('.file-edit-more-count')).toBeNull();

    expect(
      links.map((link) =>
        link.querySelector<HTMLImageElement>('.file-edit-file-icon')?.getAttribute('src')
      )
    ).toEqual([
      getFileTypeIcon('src/one.ts'),
      getFileTypeIcon('src/two.ts'),
      getFileTypeIcon('src/three.css'),
      getFileTypeIcon('src/four.mjs'),
    ]);
    links[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    flushSolid();

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/three.css', kind: 'file', view: 'diff' },
    });
  });

  it('replaces separate compact rows with inline changes unless compact rows are requested', () => {
    const part: ToolPart = {
      id: 'tool-inline-menu',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-inline-menu',
      tool: 'apply_patch',
      state: {
        status: 'completed',
        input: {
          patchText: `*** Begin Patch
*** Update File: src/one.ts
@@
-old
+one
*** Update File: src/two.ts
@@
-old
+two
*** Update File: src/three.ts
@@
-old
+three
*** Update File: src/four.ts
@@
-old
+four
*** End Patch`,
        },
        output: '',
        title: 'apply_patch',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);
    expect(container?.querySelectorAll('.file-change-card')).toHaveLength(4);
    expect(container?.querySelector('.file-edit-more-count')).toBeNull();

    setShowFileDiffs(true);
    flushSolid();
    expect(container?.querySelector('.file-change-card')).toBeNull();
    expect(container?.querySelectorAll('.file-change-inline-diffs .diff-view-file')).toHaveLength(
      4
    );

    cleanup?.();
    flushSolid();
    cleanup = undefined;
    container!.innerHTML = '';
    cleanup = render(() => ToolCall({ part, compactFileChanges: true }), container!);
    flushSolid();

    expect(container?.querySelectorAll('.file-change-card')).toHaveLength(4);
    expect(container?.querySelector('.file-change-inline-diffs')).toBeNull();
  });

  it('keeps the compact completed row when inline previews are disabled', () => {
    const part: ToolPart = {
      id: 'tool-compact-patch',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-compact-patch',
      tool: 'apply_patch',
      state: {
        status: 'completed',
        input: {
          patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-const oldValue = 1;
+const newValue = 2;
*** End Patch`,
        },
        output: '',
        title: 'apply_patch',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);

    expect(container?.querySelector('.file-change-card')).not.toBeNull();
    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('(edited)');
    expect(container?.querySelector('.file-edit-path-link')?.textContent).toBe('src/app.ts');
    expect(container?.querySelector('.file-change-inline-diffs')).toBeNull();
  });

  it('shows live apply_patch changes inline when enabled', () => {
    setShowFileDiffs(true);
    flushSolid();
    const part: ToolPart = {
      id: 'tool-inline-patch',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-inline-patch',
      tool: 'apply_patch',
      state: {
        status: 'running',
        input: {
          patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-const oldValue = 1;
+const newValue = 2;
*** Add File: src/new.ts
+export const enabled = true;
*** End Patch`,
        },
        title: 'apply_patch',
        metadata: {},
        time: { start: 0 },
      },
    };

    renderToolCall(part);

    expect(container?.querySelector('.file-change-card')).not.toBeNull();
    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('(edit)');
    expect(container?.querySelector('.file-edit-summary-label')).toBeNull();
    expect(container?.querySelector('.file-edit-icon')?.getAttribute('aria-label')).toBe('Running');
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-edit');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(editPencilIcon));
    expect(container?.querySelector('.file-change-card-header')?.textContent).not.toContain(
      'editing…'
    );
    expect(container?.querySelector('.file-edit-action-label')?.classList).toContain(
      'shimmer-progress'
    );
    expect(container?.querySelectorAll('.file-change-inline-diffs .diff-view-file')).toHaveLength(
      2
    );
    expect(container?.querySelector('.diff-view-line-deletion')?.textContent).toContain(
      'const oldValue = 1;'
    );
    expect(container?.querySelectorAll('.diff-view-line-addition')).toHaveLength(2);
  });

  it.each(['pending', 'running'] as const)(
    'expands a retained file-card header after %s becomes error',
    (status) => {
      const initial: ToolPart = {
        id: 'tool-retained-error',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'tool',
        callID: 'call-retained-error',
        tool: 'edit',
        state:
          status === 'pending'
            ? { status, input: { filePath: 'src/a.ts' }, raw: '' }
            : { status, input: { filePath: 'src/a.ts' }, time: { start: 0 } },
      };
      const [part, setPart] = createSignal(initial);
      cleanup = render(
        () =>
          createComponent(ToolCall, {
            get part() {
              return part();
            },
          }),
        container!
      );
      flushSolid();
      const header = container!.querySelector<HTMLElement>('.file-change-card-header')!;
      header.click();
      flushSolid();
      expect(container!.querySelector('.file-edit-error-detail')).toBeNull();
      expect(getToolCallExpanded(getToolCallExpansionKey(initial))).toBe(false);
      setPart({
        ...initial,
        state: {
          status: 'error',
          input: initial.state.input,
          error: 'Edit failed',
          time: { start: 0, end: 1 },
        },
      });
      flushSolid();
      expect(container!.querySelector('.file-change-card-header')).toBe(header);
      expect(header.classList).toContain('is-expandable');
      header.click();
      flushSolid();
      expect(container!.querySelector('.file-edit-error-detail')?.textContent).toBe('Edit failed');
      header.click();
      flushSolid();
      expect(container!.querySelector('.file-edit-error-detail')).toBeNull();
      setPart(initial);
      flushSolid();
      expect(container!.querySelector('.file-change-card-header')).toBe(header);
      header.click();
      flushSolid();
      expect(getToolCallExpanded(getToolCallExpansionKey(initial))).toBe(false);
    }
  );

  it.each(['edit', 'move'] as const)(
    'opens current paths from retained %s links after input replacement',
    (kind) => {
      const send = setExtensionSender();
      flushSolid();
      const input = (name: string) =>
        kind === 'edit'
          ? { filePath: `src/${name}.ts` }
          : {
              patchText: `*** Begin Patch\n*** Update File: src/${name}.ts\n*** Move to: src/${name}-moved.ts\n@@\n-old\n+new\n*** End Patch`,
            };
      const initial: ToolPart = {
        id: 'tool-retained-path',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'tool',
        callID: 'call-retained-path',
        tool: kind === 'edit' ? 'edit' : 'apply_patch',
        state: { status: 'running', input: input('a'), time: { start: 0 } },
      };
      const [part, setPart] = createSignal(initial);
      cleanup = render(
        () =>
          createComponent(ToolCall, {
            get part() {
              return part();
            },
          }),
        container!
      );
      flushSolid();
      const links = Array.from(
        container!.querySelectorAll<HTMLAnchorElement>('.file-edit-path-link')
      );
      expect(links).toHaveLength(kind === 'edit' ? 1 : 2);
      setPart({ ...initial, state: { ...initial.state, input: input('b') } });
      flushSolid();
      const currentLinks = Array.from(container!.querySelectorAll('.file-edit-path-link'));
      for (const [index, link] of links.entries()) {
        expect(currentLinks[index]).toBe(link);
        expect(link.textContent).toContain(index === 0 ? 'b.ts' : 'b-moved.ts');
        link.click();
        flushSolid();
        expect(send).toHaveBeenLastCalledWith({
          type: 'vscode/open',
          payload: {
            path: index === 0 ? 'src/b.ts' : 'src/b-moved.ts',
            kind: 'file',
            view: 'diff',
          },
        });
      }
    }
  );

  it('keeps failed apply_patch status visible beside proposed inline changes', () => {
    setShowFileDiffs(true);
    flushSolid();
    const sendSpy = setExtensionSender();
    flushSolid();
    const part: ToolPart = {
      id: 'tool-failed-patch',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-failed-patch',
      tool: 'apply_patch',
      state: {
        status: 'error',
        input: {
          patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+proposed
*** Update File: src/one.ts
@@
-old
+proposed
*** Update File: src/two.ts
@@
-old
+proposed
*** Update File: src/three.ts
@@
-old
+proposed
*** End Patch`,
        },
        error: 'Patch rejected: <script>window.bad = true</script>',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);

    expect(container?.querySelector('.file-edit-icon')).toBeNull();
    expect(container?.querySelector('.file-edit-action-label')).toBeNull();
    expect(container?.querySelector('.file-edit-error-label')?.textContent).toBe('edit failed');
    const errorToggle = container?.querySelector<HTMLButtonElement>('.file-edit-error-toggle');
    expect(errorToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('.file-edit-error-detail')).toBeNull();

    container?.querySelector<HTMLElement>('.file-edit-multi-list')?.click();
    flushSolid();

    expect(errorToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(sendSpy).not.toHaveBeenCalled();
    const errorDetail = container?.querySelector('.file-edit-error-detail');
    expect(errorDetail?.getAttribute('role')).toBe('alert');
    expect(errorDetail?.textContent).toContain(
      'Patch rejected: <script>window.bad = true</script>'
    );
    expect(errorDetail?.querySelector('script')).toBeNull();
    expect(container?.querySelector('.diff-view-line-addition')?.textContent).toContain('proposed');
    expect(container?.textContent).not.toContain('Edited');

    container?.querySelector<HTMLElement>('.file-edit-path-link')?.click();
    flushSolid();

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/app.ts', kind: 'file', view: 'diff' },
    });
    expect(errorToggle?.getAttribute('aria-expanded')).toBe('true');

    container?.querySelector<HTMLElement>('.file-change-card-header')?.click();
    flushSolid();

    expect(errorToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('.file-edit-error-detail')).toBeNull();

    cleanup?.();
    flushSolid();
    cleanup = undefined;
    container!.innerHTML = '';
    cleanup = render(() => ToolCall({ part, compactFileChanges: true }), container!);
    flushSolid();

    expect(container?.querySelector('.file-edit-error-label')?.textContent).toBe('failed');
    expect(container?.querySelector('.file-edit-error-toggle')).toBeNull();
    expect(container?.querySelector('.file-edit-error-detail')).toBeNull();
    expect(container?.querySelector('.file-change-inline-diffs')).toBeNull();
  });

  it('clamps long file edit errors and opens the full error in an editor tab', () => {
    const send = setExtensionSender();
    flushSolid();
    const error = Array.from({ length: 8 }, (_, index) => `failure line ${index + 1}`).join('\n');
    const part: ToolPart = {
      id: 'tool-long-patch-error',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-long-patch-error',
      tool: 'apply_patch',
      state: {
        status: 'error',
        input: {
          patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** End Patch`,
        },
        error,
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);

    container?.querySelector<HTMLButtonElement>('.file-edit-error-toggle')?.click();
    flushSolid();

    const errorDetail = container?.querySelector<HTMLPreElement>('.file-edit-error-detail');
    expect(errorDetail?.classList).toContain('is-truncated');
    expect(errorDetail?.textContent).toContain('failure line 5');
    expect(errorDetail?.textContent).not.toContain('failure line 6');

    errorDetail?.click();
    flushSolid();

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open-text',
      payload: {
        content: error,
        title: 'Edit error',
        language: 'plaintext',
      },
    });
  });

  it('keeps aborted apply_patch status visible beside proposed inline changes', () => {
    setShowFileDiffs(true);
    flushSolid();
    const part: ToolPart = {
      id: 'tool-aborted-patch',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-aborted-patch',
      tool: 'apply_patch',
      state: {
        status: 'error',
        input: {
          patchText: `*** Begin Patch
*** Add File: src/proposed.ts
+export const proposed = true;
*** End Patch`,
        },
        error: 'Aborted',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);

    expect(container?.querySelector('.file-edit-icon')?.classList).toContain('tool-status-aborted');
    expect(container?.querySelector('.file-edit-icon')?.getAttribute('aria-label')).toBe('Aborted');
    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('(add)');
    expect(container?.querySelector('.file-edit-error-label')?.textContent).toBe('aborted');
    expect(container?.querySelector('.diff-view-line-addition')?.textContent).toContain('proposed');
    expect(container?.textContent).not.toContain('Added');
  });

  it('replaces the compact completed row with inline file previews', () => {
    setShowFileDiffs(true);
    flushSolid();
    const part: ToolPart = {
      id: 'tool-mixed-patch',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-mixed-patch',
      tool: 'apply_patch',
      state: {
        status: 'completed',
        input: {
          patchText: `*** Begin Patch
*** Update File: src/app.ts
@@
-old
+new
*** Update File: src/old.ts
*** Move to: src/renamed.ts
*** End Patch`,
        },
        output: '',
        title: 'apply_patch',
        metadata: {
          files: [
            { type: 'update', relativePath: 'src/app.ts', additions: 1, deletions: 1 },
            {
              type: 'move',
              filePath: 'src/old.ts',
              movePath: 'src/renamed.ts',
              additions: 0,
              deletions: 0,
            },
            {
              type: 'update',
              relativePath: 'assets/logo.png',
              patch: 'Binary files a/logo.png and b/logo.png differ',
              additions: 0,
              deletions: 0,
            },
          ],
        },
        time: { start: 0, end: 1 },
      },
    };

    renderToolCall(part);

    expect(container?.querySelector('.file-change-card')).toBeNull();
    const inlineFiles = Array.from(
      container?.querySelectorAll('.file-change-inline-diffs .diff-view-file') || []
    );
    expect(inlineFiles).toHaveLength(3);
    expect(
      inlineFiles.map((file) => file.querySelector('.diff-view-filename')?.textContent)
    ).toEqual(['app.ts', 'old.ts -> renamed.ts', 'logo.png']);
    expect(inlineFiles[0]?.querySelector('.diff-view-line-addition')?.textContent).toContain('new');
    expect(inlineFiles[1]?.querySelector('.diff-view-preview-unavailable')?.textContent).toContain(
      'File moved'
    );
    expect(inlineFiles[2]?.querySelector('.diff-view-preview-unavailable')?.textContent).toContain(
      'Binary file changed'
    );
  });

  it('bounds model patch file cards and shows an overflow summary', () => {
    setShowFileDiffs(true);
    flushSolid();
    const patchText = [
      '*** Begin Patch',
      ...Array.from(
        { length: 70 },
        (_, index) => `*** Add File: src/generated-${index}.ts\n+line ${index}`
      ),
      '*** End Patch',
    ].join('\n');
    const part: ToolPart = {
      id: 'tool-bounded-patch',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-bounded-patch',
      tool: 'apply_patch',
      state: {
        status: 'running',
        input: { patchText },
        title: 'apply_patch',
        metadata: {},
        time: { start: 0 },
      },
    };

    renderToolCall(part);

    expect(container?.querySelector('.file-change-card-header')?.textContent).not.toContain(
      '64+ files'
    );
    expect(container?.querySelector('.file-edit-more-count')?.textContent).toBe('+63 more');
    expect(container?.querySelectorAll('.file-change-inline-diffs .diff-view-file')).toHaveLength(
      64
    );
    expect(container?.querySelector('.file-change-truncated-summary')?.textContent).toContain(
      'after 64 files'
    );
  });
});
