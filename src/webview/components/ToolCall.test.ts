import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type * as UseOpenCodeModule from '../hooks/useOpenCode';
import { setShowInlineFileChanges, setState } from '../lib/state';
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
  setShowInlineFileChanges(false);
  selectSessionMock.mockClear();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete fixture<UnknownRecord>(window).__sendToExtension;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setShowInlineFileChanges(false);
  setState('permissions', []);
  setState('questions', []);
  setState('sessionStatus', {});
  setState('messages', []);
  setState('sessions', []);
  setState('allAgents', []);
  setState('activeSessionId', null);
  clearDirectSessionReturn();
  resetToolCallExpansionState();
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

  it('uses the description as the task title', () => {
    expect(
      formatToolTitle('task', completedState({ description: 'Trace Varro diff logic' }, 'Working'))
    ).toBe('Trace Varro diff logic');
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
  it('uses shared expansion state helpers', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command: 'git status' }, 'git status'),
    };

    const key = getToolCallExpansionKey(part);
    setToolCallExpanded(key, true);

    expect(getToolCallExpanded(key)).toBe(true);

    resetToolCallExpansionState();

    expect(getToolCallExpanded(key)).toBe(false);
  });

  it('keeps command blocks collapsed by default', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command: 'git status' }, 'git status'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-detail')).toBeNull();
    expect(container?.textContent).toContain('git status');
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-terminal');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.classList).toContain('ui-icon');
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('12px');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(terminalIcon));
  });

  it('does not repeat long commands in the collapsed preview', () => {
    const command = `npm run test -- ${'src/webview/components/MessageList.test.ts '.repeat(3)}`;
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command }, command),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(command.length).toBeGreaterThan(100);
    expect(container?.querySelector('.tool-invocation-preview')).toBeNull();
  });

  it('does not offer expansion when a generic tool has no details', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'apply_patch',
      state: {
        status: 'running',
        input: {},
        title: 'apply_patch',
        metadata: {},
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const header = container?.querySelector<HTMLButtonElement>('.tool-invocation-header');
    expect(header?.disabled).toBe(true);
    expect(header?.hasAttribute('aria-expanded')).toBe(false);
    expect(container?.querySelector('.tool-invocation-chevron')).toBeNull();
    expect(container?.querySelector('.tool-invocation-detail')).toBeNull();
  });

  it('animates pending apply_patch calls as in-progress tools', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'apply_patch',
      state: {
        status: 'pending',
        input: {},
        raw: '',
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-call-icon-edit')?.classList).toContain(
      'tool-status-running'
    );
    expect(container?.querySelector('.tool-invocation-title')?.classList).toContain(
      'shimmer-progress'
    );
  });

  it('shows files from running apply_patch input in the compact edit card', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'apply_patch',
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

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-summary-label')?.textContent).toBe('2 files');
    expect(
      Array.from(container?.querySelectorAll('.file-edit-path-link') || []).map(
        (link) => link.textContent
      )
    ).toEqual(['src/app.ts', 'src/theme.css']);
    expect(container?.querySelector('.file-edit-running-label')?.textContent).toBe('editing…');
    expect(container?.querySelector('.tool-invocation-header')).toBeNull();
  });

  it('animates a pending apply_patch file-change card', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'apply_patch',
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

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-action-label')?.classList).toContain(
      'shimmer-progress'
    );
    expect(container?.querySelector('.file-edit-icon')?.classList).toContain('tool-status-running');
    expect(container?.querySelector('.file-edit-icon')?.getAttribute('aria-label')).toBe('Running');
  });

  it('shows an aligned empty output row for completed bash commands', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState(
        { command: 'pnpm -s exec prettier --check src/webview/index.css' },
        'check'
      ),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    expect(container?.querySelector('.terminal-command-row-output')).not.toBeNull();
    expect(container?.querySelector('.terminal-command-output-empty')?.textContent).toBe(
      '(no output)'
    );
  });

  it('renders failed bash errors in the terminal result row', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'error',
        input: { command: 'opencode --version' },
        error: 'The user rejected permission to use this specific tool call.',
        time: { start: 0, end: 1 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

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

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    expect(container?.querySelector('.terminal-command-output-empty')?.textContent).toBe(
      '(no output)'
    );
    expect(container?.querySelector('.tool-text-clamped')).toBeNull();
  });

  it('offers no expansion when the only output is whitespace', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'websearch',
      state: completedState({}, 'search', '   \n'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const header = container?.querySelector<HTMLButtonElement>('.tool-invocation-header');
    expect(header?.disabled).toBe(true);
    expect(container?.querySelector('.tool-invocation-chevron')).toBeNull();
  });

  it('drops the $ row and copies from the expanded header when it shows the command', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const command = `rtk npx oxfmt --check ${'src/webview/components/ToolCall.tsx '.repeat(3)}`;
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command }, command, 'All matched files use the correct format.'),
    };

    cleanup = render(() => ToolCall({ part }), container!);
    const header = container?.querySelector<HTMLButtonElement>('.tool-invocation-header');
    expect(
      container?.querySelector('.tool-invocation-header-shell > .tool-copy-button')
    ).toBeNull();

    header?.click();

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
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(command);
    await vi.waitFor(() => {
      expect(copy?.classList).toContain('is-copied');
      expect(copy?.getAttribute('aria-label')).toBe('Copied');
      expect(copy?.getAttribute('title')).toBeNull();
    });
    vi.unstubAllGlobals();
  });

  it('copies the full command even though the $ row renders one ellipsized line', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const command = `npm run test -- ${'src/webview/components/MessageList.test.ts '.repeat(4)}`;
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command }, 'run tests', 'ok'),
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const copy = container?.querySelector<HTMLButtonElement>('.tool-copy-button');
    expect(copy).not.toBeNull();
    copy?.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(command);
    vi.unstubAllGlobals();
  });

  it('keeps the $ row when the header title is not the command', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command: 'git status' }, 'Check the repo', 'M src/app.ts'),
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    expect(container?.querySelector('.terminal-command-row-input')).not.toBeNull();
    expect(container?.querySelector('.tool-invocation-running')).toBeNull();
  });

  it('offers copy without expansion when a running command only repeats the header', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'git status' },
        title: 'git status',
        metadata: {},
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const header = container?.querySelector<HTMLButtonElement>('.tool-invocation-header');
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
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('git status');
    vi.unstubAllGlobals();
  });

  it('keeps expanded running command output scrolled to its latest line', async () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'running',
        input: { command: 'npm test' },
        title: 'npm test',
        metadata: { content: [{ type: 'text', text: 'test 1' }] },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    cleanup();
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

    const output = container?.querySelector<HTMLDivElement>('.terminal-command-output-viewport');
    if (!output) throw new Error('Expected live command output');
    Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 120 });
    Object.defineProperty(output, 'clientHeight', { configurable: true, value: 40 });
    output.scrollTop = 0;
    await Promise.resolve();

    expect(output.textContent).toContain('test 3');
    expect(output.scrollTop).toBe(80);
  });

  it('hides completed generic tool durations under one second', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'grep',
      state: completedState({ pattern: 'ToolCall' }, 'Search: ToolCall'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-duration')).toBeNull();
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-search');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(searchIcon));
  });

  it('extracts the completed search result count into a header pill', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'grep',
      state: completedState(
        { pattern: 'ToolCall' },
        'Search: ToolCall',
        'Found 2 matches\n\n/repo/src/a.ts:\n  Line 1: ToolCall\n/repo/src/b.ts:\n  Line 2: ToolCall'
      ),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const count = container?.querySelector('.tool-invocation-search-count');
    expect(count?.textContent).toBe('2');
    expect(count?.getAttribute('aria-label')).toBe('2 search results');
  });

  it('uses search metadata and marks truncated counts as lower bounds', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'functions.grep',
      state: {
        ...completedState(
          { pattern: 'ToolCall' },
          'Search: ToolCall',
          'Found 100 matches (more matches available)'
        ),
        metadata: { matches: 100, truncated: true },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const count = container?.querySelector('.tool-invocation-search-count');
    expect(count?.textContent).toBe('100+');
    expect(count?.getAttribute('aria-label')).toBe('100 or more search results');
  });

  it('uses the canonical icon kind for namespaced file aliases', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'functions.file_write',
      state: completedState({ filePath: 'src/app.ts' }, 'Wrote src/app.ts'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-edit');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(editPencilIcon));
  });

  it('renders failed search errors as a structured table row', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'functions.grep',
      state: {
        status: 'error',
        input: {
          pattern: 'disablePageUnloadEvents',
          path: '/repo/node_modules/@microsoft',
          include: '*.{ts,d.ts,js,mjs}',
        },
        error: 'Ripgrep JSON record exceeded 65536 bytes',
        time: { start: 0, end: 1 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

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
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'grep',
      state: completedState(
        {
          pattern,
          include: '{components/ToolCall.tsx,lib/assistant-activity.ts,lib/task-activity.ts}',
        },
        `Search: ${pattern}`,
        'No files found'
      ),
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const rows = Array.from(container?.querySelectorAll('.structured-tool-row') || []);
    const inputRows = rows.slice(0, 2);

    expect(
      inputRows.map((row) => row.querySelector('.structured-tool-label')?.textContent)
    ).toEqual(['pattern', 'include']);
    expect(
      inputRows.every((row) => row.querySelector('.structured-tool-value-line') !== null)
    ).toBe(true);
    expect(inputRows[0]?.querySelector('.structured-tool-value-single')?.textContent).toBe(pattern);
    expect(container?.querySelector('.tool-invocation-search-count')?.textContent).toBe('0');
  });

  it('renders web fetch details and errors in the structured table', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'webfetch',
      state: {
        status: 'error',
        input: {
          url: 'https://api.github.com/search/code?q=defaultViewLocation%20repo%3Amicrosoft%2Fvscode',
          format: 'text',
          timeout: 30,
        },
        error: 'StatusCode: non 2xx status code (401)',
        time: { start: 0, end: 1 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

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

  it('does not render a second line for collapsed generic tool input', () => {
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'inspect',
      state: completedState({ path: '/repo/docs/spec.md' }, 'Inspect file'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-preview')).toBeNull();
    expect(container?.textContent).not.toContain('docs/spec.md');
  });

  it('does not render a second line for collapsed subagent input', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: completedState(
        {
          description: 'Research test suite improvements',
          command: 'hidden subagent summary',
          subagent_type: 'explore',
          prompt: 'Thoroughly explore the test suite for this project',
        },
        'Research test suite improvements'
      ),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-preview')).toBeNull();
    expect(container?.textContent).not.toContain('hidden subagent summary');
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-task');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(checkCircleIcon));
  });

  it('uses the cable tag icon for incomplete task tools', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'error',
        input: { prompt: 'Review the implementation' },
        error: 'Task failed',
        time: { start: 0, end: 1 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-task');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(cableTagIcon));
  });

  it('hides a duplicated description from expanded task details', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: completedState(
        {
          description: 'Research test suite improvements',
          subagent_type: 'explore',
          prompt: 'Thoroughly explore the test suite for this project',
        },
        'Research test suite improvements'
      ),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.chat-tool-invocation-part')?.classList).toContain(
      'tool-invocation-task'
    );
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const detailText = container?.querySelector('.tool-invocation-detail')?.textContent || '';

    expect(detailText).not.toContain('descriptionResearch test suite improvements');
    expect(detailText).toContain('subagent_typeexplore');
    expect(detailText).toContain('promptThoroughly explore the test suite for this project');
  });

  it('renders prompt immediately before the task result, on the shared label/value grid', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
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
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const rows = Array.from(container?.querySelectorAll('.structured-tool-row') || []);
    const labels = rows.map((row) => row.querySelector('.structured-tool-label')?.textContent);

    expect(labels).toEqual(['subagent_type', 'task_id', 'prompt', 'task_result']);
    // Multi-line values used to stack under their label on a one-column row,
    // which broke alignment with the scalar rows. Every row shares one grid now.
    expect(rows.every((row) => row.classList.contains('structured-tool-row'))).toBe(true);
    expect(rows.some((row) => row.classList.contains('structured-tool-row-block'))).toBe(false);
  });

  it('shows the subagent model and reasoning in expanded task details', () => {
    setState('messages', [
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
    ]);
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          subagent_type: 'explore',
          prompt: 'Inspect the repository',
        },
        title: 'Inspect the repository',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

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
    setState('allAgents', [
      {
        name: 'explore',
        mode: 'subagent',
        permission: [],
        model: { providerID: 'openai', modelID: 'gpt-5.6-sol' },
        variant: 'medium',
      },
    ]);
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        ...completedState(
          {
            subagent_type: 'explore',
            prompt: 'Inspect the repository',
          },
          'Inspect the repository'
        ),
        output: '<task_result>Report</task_result>',
        metadata: { sessionId: 'subagent-session-1' },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

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

  it('uses the resolved task metadata model before stale agent or parent state', () => {
    setState('allAgents', [
      {
        name: 'explore',
        mode: 'subagent',
        permission: [],
      },
    ]);
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
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
      },
    };
    setState('messages', [
      {
        info: assistantMessage('message-1', {
          mode: 'default',
          providerID: 'openai',
          modelID: 'gpt-5.6-sol',
          variant: 'high',
        }),
        parts: [part],
      },
    ]);

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const detail = container?.querySelector('.structured-tool-card')?.textContent || '';
    expect(detail).toContain('modelopenai/gpt-5.6-terra');
    expect(detail).toContain('reasoningdefault');
  });

  it('shows inherited model details for agents without a configured model', () => {
    setState('allAgents', [
      {
        name: 'explore',
        mode: 'subagent',
        permission: [],
        variant: 'low',
      },
    ]);
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: completedState(
        {
          subagent_type: 'explore',
          prompt: 'Inspect the repository',
        },
        'Inspect the repository'
      ),
    };
    setState('messages', [
      {
        info: assistantMessage('message-1', {
          mode: 'default',
          providerID: 'openai',
          modelID: 'gpt-5.6-sol',
          variant: 'high',
        }),
        parts: [part],
      },
    ]);

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const detail = container?.querySelector('.structured-tool-card')?.textContent || '';
    expect(detail).toContain('modelopenai/gpt-5.6-sol');
    expect(detail).toContain('reasoninglow');
  });

  it('does not duplicate the running status dot in expanded task details', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          subagent_type: 'explore',
          prompt: 'Review the codebase for performance issues',
        },
        title: 'Scan hotspots',
        metadata: {},
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

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

  it('shows a wait icon when the subagent is blocked on permission', () => {
    setState('sessions', [
      session('session-1'),
      session('subagent-session-1', { parentID: 'session-1' }),
    ]);
    setState('permissions', [
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
    ]);
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: { prompt: 'Review the implementation' },
        title: 'Review implementation',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-task');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.classList).toContain('tool-call-wait-icon');
    expect(icon?.classList).not.toContain('tool-call-spinner');
    expect(icon?.getAttribute('aria-label')).toBe('Waiting for permission');
    expect(icon?.getAttribute('role')).toBe('status');
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('16px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('16px');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(hourglassIcon));
  });

  it('opens the running subagent session from its status card', () => {
    setState('activeSessionId', 'session-1');
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          subagent_type: 'general',
          prompt: 'Review the implementation',
        },
        title: 'Review implementation',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const runningStatus = container?.querySelector<HTMLButtonElement>(
      '.tool-invocation-subagent-running'
    );
    expect(runningStatus?.disabled).toBe(false);
    expect(runningStatus?.title).toBe('Open subagent session');

    runningStatus?.click();

    expect(selectSessionMock).toHaveBeenCalledWith('subagent-session-1');
    expect(getDirectSessionReturnId('subagent-session-1')).toBe('session-1');
  });

  it('shows retry status when subagent session is retrying', () => {
    setState('sessionStatus', {
      'subagent-session-1': {
        type: 'retry' as const,
        attempt: 2,
        message: 'rate limit exceeded',
        next: Date.now() + 5000,
      },
    });

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          prompt: 'Do something',
        },
        title: 'Working',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const retryLabel = container?.querySelector('.tool-invocation-retry-label');
    expect(retryLabel?.textContent).toContain('retrying #2');

    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();
    const runningDiv = container?.querySelector('.tool-invocation-running');
    expect(runningDiv?.textContent).toContain('Subagent is retrying');
    expect(runningDiv?.textContent).toContain('Attempt 2');
    expect(runningDiv?.textContent).toContain('rate limit exceeded');
  });

  it('shows an active subagent status when task has no retry status', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          prompt: 'Do something',
        },
        title: 'Working',
        metadata: { sessionId: 'subagent-session-no-retry' },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-retry-label')).toBeNull();

    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();
    expect(container?.querySelector('.tool-invocation-running')?.textContent).toContain(
      'Subagent is working'
    );
  });

  it('shows live subagent token counts for running tasks', () => {
    setState('messages', [
      {
        info: assistantMessage('subagent-assistant-1', {
          sessionID: 'subagent-session-1',
          tokens: { input: 1_234, output: 56, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
      {
        info: assistantMessage('other-assistant', {
          sessionID: 'other-session',
          tokens: { input: 9_999, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
        parts: [],
      },
    ]);

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          prompt: 'Do something',
        },
        title: 'Working',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const stats = container?.querySelector('.tool-invocation-token-stats');
    expect(stats?.textContent).toBe('↑ 1,234 ↓ 56');
    expect(stats?.querySelector('.diff-lines-added')).toBeNull();
    expect(stats?.querySelector('.diff-lines-removed')).toBeNull();
  });

  it('keeps subagent token counts visible while waiting for token data', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          prompt: 'Do something',
        },
        title: 'Working',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-token-stats')?.textContent).toBe('↑ 0 ↓ 0');
  });

  it('updates the elapsed duration while a subagent task is running', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: { description: 'Inspect the repository' },
        title: 'Inspect the repository',
        metadata: {},
        time: { start: 5_000 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('5s');

    vi.advanceTimersByTime(2_000);

    expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('7s');
  });

  it('shows the running subagent session activity age only while Alt is held', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    setState('sessions', [
      session('subagent-session-1', {
        time: { created: 1_000, updated: 7_000 },
      }),
    ]);
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: { description: 'Inspect the repository' },
        title: 'Inspect the repository',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 1_000 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-activity-age')).toBeNull();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));

    const activityAge = container?.querySelector('.tool-invocation-activity-age');
    expect(activityAge?.textContent).toBe('last active 3s ago');
    expect(activityAge?.querySelector('.tool-invocation-activity-time')?.textContent).toBe('3s');
    expect(activityAge?.getAttribute('title')).toBe('Last session activity');
    expect(container?.querySelector('.tool-invocation-token-stats')).toBeNull();
    expect(container?.querySelector('.tool-invocation-duration')).toBeNull();

    vi.advanceTimersByTime(2_000);
    expect(activityAge?.textContent).toBe('last active 5s ago');

    setState('sessions', 0, 'time', 'updated', 11_000);
    expect(activityAge?.textContent).toBe('last active 1s ago');

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt' }));
    expect(container?.querySelector('.tool-invocation-activity-age')).toBeNull();
    expect(container?.querySelector('.tool-invocation-token-stats')?.textContent).toBe('↑ 0 ↓ 0');
    expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('11s');
  });

  it('clears the running subagent activity age when the window loses focus', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    setState('sessions', [
      session('subagent-session-1', {
        time: { created: 1_000, updated: 7_000 },
      }),
    ]);
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: { description: 'Inspect the repository' },
        title: 'Inspect the repository',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 1_000 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Alt' }));
    expect(container?.querySelector('.tool-invocation-activity-age')?.textContent).toBe(
      'last active 3s ago'
    );

    window.dispatchEvent(new Event('blur'));
    expect(container?.querySelector('.tool-invocation-activity-age')).toBeNull();
  });

  it('uses subagent session token snapshots when message tokens are unavailable', () => {
    setState('sessions', [
      session('subagent-session-1', {
        tokens: { input: 2_468, output: 135, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]);

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          prompt: 'Do something',
        },
        title: 'Working',
        metadata: { sessionId: 'subagent-session-1' },
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-token-stats')?.textContent).toBe(
      '↑ 2,468 ↓ 135'
    );
  });

  it('infers the subagent session when task metadata loses the session id', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'running',
        input: {
          description: 'Research Varro SDK usage',
          prompt: 'Do something',
        },
        title: 'Research Varro SDK usage',
        metadata: {},
        time: { start: 0 },
      },
    };
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
    setState('sessions', [
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
    ]);
    setState('messages', [
      {
        info: assistantMessage('message-1', {
          mode: 'default',
          sessionID: 'session-1',
          time: { created: 10 },
        }),
        parts: [part, otherTask],
      },
    ]);

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-token-stats')?.textContent).toBe(
      '↑ 321 ↓ 45'
    );
  });

  it('shows an explicit empty task result when the tagged payload has no content', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'task',
      state: {
        status: 'completed',
        input: {
          subagent_type: 'explore',
          prompt: 'Inspect the repository',
        },
        output: '<task_result>   </task_result>',
        title: 'Inspect the repository',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const resultRow = container?.querySelector('.structured-tool-row-result');

    expect(resultRow?.textContent).toContain('task_result');
    expect(resultRow?.textContent).toContain('(no output)');
  });

  it('renders aborted tool errors with neutral aborted styling', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'browser-bridge_browser_investigate',
      state: {
        status: 'error',
        input: { objective: 'Check current page' },
        error: 'Aborted',
        time: { start: 0, end: 1 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const header = container?.querySelector('.tool-invocation-header');
    const icon = container?.querySelector('.tool-call-icon');
    const label = container?.querySelector('.tool-invocation-error-label');

    expect(icon?.classList.contains('tool-status-aborted')).toBe(true);
    expect(label?.classList.contains('is-aborted')).toBe(true);
    expect(label?.textContent).toBe('aborted');

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (header as HTMLButtonElement).click();

    const detail = container?.querySelector('.tool-invocation-error');

    expect(detail?.classList.contains('is-aborted')).toBe(true);
    expect(detail?.textContent).toContain('Aborted');
  });

  it('clamps generic tool errors and opens the full error in an editor tab', () => {
    const send = setExtensionSender();
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

    cleanup = render(() => ToolCall({ part }), container!);
    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const detail = container?.querySelector<HTMLPreElement>('.tool-invocation-error');
    expect(detail?.classList).toContain('is-truncated');
    expect(detail?.textContent).not.toContain('browser failure 6');

    detail?.click();

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
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command: 'git status' }, 'git status'),
    };

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

    setState('permissions', [permission]);

    cleanup = render(() => ToolCall({ part }), container!);

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

    setState('permissions', [
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
    ]);

    cleanup = render(() => ToolCall({ part }), container!);

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
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command: 'git status' }, 'git status'),
    };

    setState('permissions', [
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
    ]);

    cleanup = render(() => ToolCall({ part }), container!);

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

    setState('permissions', [
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
    ]);

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelectorAll('.permission-prompt')).toHaveLength(0);
    expect(container?.querySelector('.tool-invocation-header')).not.toBeNull();
    expect(container?.querySelector('.tool-call-wait-icon')).not.toBeNull();
  });

  it('keeps the command card visible when a linked question prompt is pending', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: completedState({ command: 'git status' }, 'git status'),
    };

    const question: QuestionRequest = {
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

    setState('questions', [question]);

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-header')?.textContent).toContain(
      'git status'
    );
    expect(container?.querySelector('.question-prompt-card')).not.toBeNull();
    expect(container?.textContent).toContain('Which command should run?');
  });

  it('hides the synthetic question tool row when a linked question prompt is pending', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'question',
      state: completedState({}, 'question'),
    };

    const question: QuestionRequest = {
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

    setState('questions', [question]);

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-header')).toBeNull();
    expect(container?.querySelector('.question-prompt-card')).not.toBeNull();
  });

  it('shows completed questions and answers as a compact read-only summary', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'question',
      state: {
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
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const summary = container?.querySelector('.question-summary-card');
    expect(summary?.querySelector('.question-summary-title')?.textContent).toBe(
      'Asked 3 questions'
    );
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
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'question',
      state: {
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
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

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
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'question',
      state: completedState({}, 'question'),
    };

    const question: QuestionRequest = {
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

    setState('questions', [question]);

    cleanup = render(() => ToolCall({ part }), container!);

    const option = container?.querySelector<HTMLLabelElement>('.question-option');
    option?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(option?.classList.contains('selected')).toBe(true);
    expect(container?.querySelector('.question-radio.checked')).not.toBeNull();
    expect(container?.querySelector<HTMLButtonElement>('.question-btn-primary')?.disabled).toBe(
      false
    );
  });

  it('shows the custom answer radio and enables submit when custom text is entered', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'question',
      state: completedState({}, 'question'),
    };

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

    setState('questions', [question]);

    cleanup = render(() => ToolCall({ part }), container!);

    const input = container?.querySelector<HTMLInputElement>('.question-custom-input');
    if (!input) throw new Error('Expected custom answer input');
    input.value = 'npm run dev';
    input.dispatchEvent(new Event('input', { bubbles: true }));

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

    setState('sessions', [
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
    ]);
    setState('permissions', [
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
    ]);

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.permission-prompt')).not.toBeNull();
  });

  it('renders file reads with computed line ranges and file open links', () => {
    const sendSpy = setExtensionSender();
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state: completedState(
        { file_path: '/repo/src/main.ts', offset: 4, limit: 3 },
        'Read main.ts'
      ),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const target = container?.querySelector<HTMLAnchorElement>('.file-read-target');

    expect(container?.querySelector('.file-read-action-label')?.textContent).toBe('Read:');
    expect(target?.textContent).toBe('main.ts');
    expect(container?.querySelector('.file-read-range')?.textContent).toBe('(L5-7)');
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-read');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(eyeIcon));

    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/src/main.ts', kind: 'file', line: 5 },
    });
  });

  it('uses the stable read-card shell without a transient running label while reads start', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state: {
        status: 'running',
        input: {},
        title: 'read',
        metadata: {},
        time: { start: 0 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

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
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state: completedState({ file_path: '/repo/src/main.ts' }, 'Read main.ts'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-read-duration')).toBeNull();
  });

  it('renders directory and current-directory read states distinctly', () => {
    const sendSpy = setExtensionSender();
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    const directoryPart: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'read',
      state: {
        status: 'completed',
        input: { file_path: '/repo/src' },
        output: '<type>directory</type>',
        title: 'Read src',
        metadata: {},
        time: { start: 0, end: 1 },
      },
    };

    cleanup = render(() => ToolCall({ part: directoryPart }), container!);

    const directoryLink = container?.querySelector<HTMLAnchorElement>('.file-read-target');

    expect(directoryLink?.textContent).toBe('src');
    expect(container?.querySelector('.file-read-meta')?.textContent).toBe('directory');

    directoryLink?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/src', kind: 'directory' },
    });

    cleanup?.();
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

    expect(container?.querySelector('.file-read-target-text')?.textContent).toBe(
      'current directory'
    );
    expect(container?.querySelector('.file-read-target[href]')).toBeNull();
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

    cleanup = render(() => ToolCall({ part }), container!);

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

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'edit',
      state: completedState({ file_path: 'src/foo.ts' }, 'Edit src/foo.ts'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Edited:');
    expect(fileStatusSpy).not.toHaveBeenCalled();
  });

  it('labels a create tool as Added without consulting workspace git status', () => {
    const fileStatusSpy = vi
      .spyOn(client.file, 'status')
      .mockResolvedValue([{ path: 'src/new.ts', status: 'modified', added: 1, removed: 0 }]);

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'create',
      state: completedState({ file_path: 'src/new.ts' }, 'Create src/new.ts'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Added:');
    expect(fileStatusSpy).not.toHaveBeenCalled();
  });

  it('labels a delete tool as Removed without consulting workspace git status', () => {
    const fileStatusSpy = vi.spyOn(client.file, 'status').mockResolvedValue([]);

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'delete',
      state: completedState({ file_path: 'src/gone.ts' }, 'Delete src/gone.ts'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Removed:');
    expect(fileStatusSpy).not.toHaveBeenCalled();
  });

  it('labels a rename tool as Moved without consulting workspace git status', () => {
    const fileStatusSpy = vi.spyOn(client.file, 'status').mockResolvedValue([]);

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'rename',
      state: completedState(
        { from_path: 'src/old.ts', to_path: 'src/new.ts' },
        'Rename src/old.ts -> src/new.ts'
      ),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Moved:');
    expect(fileStatusSpy).not.toHaveBeenCalled();
  });

  it('shows move paths, diff stats, and open-path links for completed renames', () => {
    const sendSpy = setExtensionSender();
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'rename',
      state: {
        status: 'completed',
        input: { from_path: '/repo/src/old.ts', to_path: '/repo/src/new.ts' },
        output: '',
        title: 'Rename src/old.ts -> src/new.ts',
        metadata: { additions: 2, deletions: 1 },
        time: { start: 0, end: 1500 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const links = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>('.file-edit-path-link') || []
    );

    expect(links.map((link) => link.textContent)).toEqual(['src/old.ts', 'src/new.ts']);
    expect(container?.querySelector('.file-edit-diff-stats')?.textContent).toContain('+2');
    expect(container?.querySelector('.file-edit-diff-stats')?.textContent).toContain('-1');
    expect(container?.querySelector('.file-edit-duration')?.textContent).toBe('2s');

    links[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    links[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(sendSpy).toHaveBeenNthCalledWith(1, {
      type: 'vscode/open',
      payload: { path: '/repo/src/old.ts', kind: 'file', view: 'diff' },
    });
    expect(sendSpy).toHaveBeenNthCalledWith(2, {
      type: 'vscode/open',
      payload: { path: '/repo/src/new.ts', kind: 'file', view: 'diff' },
    });
  });

  it('shows grouped paths and per-file stats for multi-file apply_patch metadata', () => {
    const sendSpy = setExtensionSender();
    setState('editorContext', {
      workspacePath: '/repo',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });

    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'apply_patch',
      state: {
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
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const links = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>(
        '.file-edit-multi-list .file-edit-path-link'
      ) || []
    );

    expect(container?.querySelector('.file-edit-summary-label')?.textContent).toBe('2 files');
    expect(links.map((link) => link.textContent)).toEqual(['src/new.ts', 'src/app.ts']);
    expect(container?.querySelector('.file-edit-more-count')).toBeNull();
    expect(container?.querySelector('.file-edit-diff-stats')?.textContent).toContain('+5');
    expect(container?.querySelector('.file-edit-diff-stats')?.textContent).toContain('-1');

    links[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/app.ts', kind: 'file', view: 'diff' },
    });
  });

  it('limits crowded multi-file rows to a fixed summary, first path, and more count', () => {
    const sendSpy = setExtensionSender();
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'apply_patch',
      state: {
        status: 'completed',
        input: {},
        output: '',
        title: 'apply_patch',
        metadata: {
          files: [
            { type: 'update', relativePath: 'src/one.ts', additions: 1, deletions: 0 },
            { type: 'update', relativePath: 'src/two.ts', additions: 1, deletions: 0 },
            { type: 'update', relativePath: 'src/three.ts', additions: 1, deletions: 0 },
            { type: 'update', relativePath: 'src/four.ts', additions: 1, deletions: 0 },
          ],
        },
        time: { start: 0, end: 1500 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const links = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>(
        '.file-edit-multi-list .file-edit-path-link'
      ) || []
    );

    expect(container?.querySelector('.file-edit-summary-label')?.textContent).toBe('4 files');
    expect(links.map((link) => link.textContent)).toEqual(['src/one.ts']);
    expect(links[0]?.getAttribute('title')).toBe('src/one.ts');
    expect(container?.querySelector('.file-edit-more-menu')).toBeNull();

    const moreButton = container?.querySelector<HTMLButtonElement>('.file-edit-more-count');
    expect(moreButton?.textContent).toBe('+3 more');
    expect(moreButton?.getAttribute('aria-expanded')).toBe('false');

    moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(moreButton?.getAttribute('aria-expanded')).toBe('true');
    const hiddenLinks = Array.from(
      container?.querySelectorAll<HTMLAnchorElement>('.file-edit-more-menu-item') || []
    );

    expect(hiddenLinks.map((link) => link.textContent)).toEqual([
      'src/two.ts',
      'src/three.ts',
      'src/four.ts',
    ]);
    expect(hiddenLinks[1]?.getAttribute('title')).toBe('src/three.ts');

    hiddenLinks[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/three.ts', kind: 'file', view: 'diff' },
    });
    expect(container?.querySelector('.file-edit-more-menu')).toBeNull();
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

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-change-card')).not.toBeNull();
    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Edited:');
    expect(container?.querySelector('.file-edit-path-link')?.textContent).toBe('src/app.ts');
    expect(container?.querySelector('.file-change-inline-diffs')).toBeNull();
  });

  it('shows live apply_patch changes inline when enabled', () => {
    setShowInlineFileChanges(true);
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

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-change-card')).not.toBeNull();
    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Edit:');
    expect(container?.querySelector('.file-edit-summary-label')?.textContent).toBe('2 files');
    expect(container?.querySelector('.file-edit-icon')?.getAttribute('aria-label')).toBe('Running');
    const icon = container?.querySelector<HTMLElement>('.tool-call-icon-edit');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(editPencilIcon));
    expect(container?.querySelector('.file-edit-running-label')?.textContent).toBe('editing…');
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

  it('keeps failed apply_patch status visible beside proposed inline changes', () => {
    setShowInlineFileChanges(true);
    const sendSpy = setExtensionSender();
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

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-icon')?.classList).toContain('tool-status-error');
    expect(container?.querySelector('.file-edit-icon')?.getAttribute('aria-label')).toBe('Failed');
    expect(container?.querySelector('.file-edit-icon')?.getAttribute('role')).toBe('status');
    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Edit:');
    expect(container?.querySelector('.file-edit-error-label')?.textContent).toBe('failed');
    const errorToggle = container?.querySelector<HTMLButtonElement>('.file-edit-error-toggle');
    expect(errorToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('.file-edit-error-detail')).toBeNull();

    container?.querySelector<HTMLElement>('.file-edit-multi-list')?.click();

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

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/app.ts', kind: 'file', view: 'diff' },
    });
    expect(errorToggle?.getAttribute('aria-expanded')).toBe('true');

    container?.querySelector<HTMLElement>('.file-change-card-header')?.click();

    expect(errorToggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('.file-edit-error-detail')).toBeNull();
  });

  it('clamps long file edit errors and opens the full error in an editor tab', () => {
    const send = setExtensionSender();
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

    cleanup = render(() => ToolCall({ part }), container!);

    container?.querySelector<HTMLButtonElement>('.file-edit-error-toggle')?.click();

    const errorDetail = container?.querySelector<HTMLPreElement>('.file-edit-error-detail');
    expect(errorDetail?.classList).toContain('is-truncated');
    expect(errorDetail?.textContent).toContain('failure line 5');
    expect(errorDetail?.textContent).not.toContain('failure line 6');

    errorDetail?.click();

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
    setShowInlineFileChanges(true);
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

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-icon')?.classList).toContain('tool-status-aborted');
    expect(container?.querySelector('.file-edit-icon')?.getAttribute('aria-label')).toBe('Aborted');
    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Add:');
    expect(container?.querySelector('.file-edit-error-label')?.textContent).toBe('aborted');
    expect(container?.querySelector('.diff-view-line-addition')?.textContent).toContain('proposed');
    expect(container?.textContent).not.toContain('Added');
  });

  it('replaces the compact completed row with inline file previews', () => {
    setShowInlineFileChanges(true);
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

    cleanup = render(() => ToolCall({ part }), container!);

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
    setShowInlineFileChanges(true);
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

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.file-edit-summary-label')?.textContent).toBe('64+ files');
    expect(container?.querySelectorAll('.file-change-inline-diffs .diff-view-file')).toHaveLength(
      64
    );
    expect(container?.querySelector('.file-change-truncated-summary')?.textContent).toContain(
      'after 64 files'
    );
  });
});
