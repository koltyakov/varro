import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { setExpandThinkingByDefaultPreference, setState } from '../lib/state';
import type { Permission, QuestionRequest, ToolPart } from '../types';
import {
  ToolCall,
  formatToolTitle,
  getVisibleInputEntries,
  getToolCallExpansionKey,
  resetToolCallExpansionState,
  shouldShowToolPreview,
} from './ToolCall';
import { getToolCallExpanded, setToolCallExpanded } from '../lib/tool-call-expansion-state';
import { client } from '../lib/client';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function setExtensionSender() {
  const sendSpy = vi.fn();
  (window as unknown as Record<string, unknown>).__sendToExtension = sendSpy;
  return sendSpy;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setExpandThinkingByDefaultPreference(false);
  delete (window as unknown as Record<string, unknown>).__sendToExtension;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setExpandThinkingByDefaultPreference(false);
  setState('permissions', []);
  setState('questions', []);
  setState('sessionStatus', {});
  resetToolCallExpansionState();
  delete (window as unknown as Record<string, unknown>).__sendToExtension;
});

function completedState(
  input: Record<string, unknown> = {},
  title = ''
): Extract<ToolPart['state'], { status: 'completed' }> {
  return {
    status: 'completed',
    input,
    output: '',
    title,
    metadata: {},
    time: { start: 0, end: 1 },
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
});

describe('shouldShowToolPreview', () => {
  it('hides previews already included in the title', () => {
    expect(shouldShowToolPreview('Search: Thinking:', { key: 'pattern', text: 'Thinking:' })).toBe(
      false
    );
  });

  it('shows previews when they add new information', () => {
    expect(shouldShowToolPreview('bash', { key: 'command', text: 'git status' })).toBe(true);
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

  it('keeps command blocks collapsed by default even when thinking auto-expand is enabled', () => {
    setExpandThinkingByDefaultPreference(true);

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

  it('falls back to the reported bash duration when persisted timestamps are implausibly short', () => {
    const part: ToolPart = {
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'bash',
      state: {
        status: 'completed',
        input: { command: 'rtk npm run test:e2e 2>&1 | tail -30' },
        output:
          '1 failed\n  [chromium] > e2e/tests/composer.spec.ts:229:5 > upward scroll\n  148 passed (17.6s)\n',
        title: 'Run full e2e test suite',
        metadata: {},
        time: { start: 1778052631591, end: 1778052631596 },
      },
    };

    cleanup = render(() => ToolCall({ part }), container!);

    expect(container?.querySelector('.tool-invocation-duration')?.textContent).toBe('18s');
  });

  it('renders a collapsed path preview as an open-file link', () => {
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
      tool: 'inspect',
      state: completedState({ path: '/repo/docs/spec.md' }, 'Inspect file'),
    };

    cleanup = render(() => ToolCall({ part }), container!);

    const previewLink = container?.querySelector<HTMLAnchorElement>('.tool-invocation-preview a');

    expect(previewLink?.textContent).toBe('docs/spec.md');

    previewLink?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/docs/spec.md', kind: 'file' },
    });
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

    container?.querySelector<HTMLButtonElement>('.tool-invocation-header')?.click();

    const detailText = container?.querySelector('.tool-invocation-detail')?.textContent || '';

    expect(detailText).not.toContain('descriptionResearch test suite improvements');
    expect(detailText).toContain('subagent_typeexplore');
    expect(detailText).toContain('promptThoroughly explore the test suite for this project');
  });

  it('renders prompt as a block row immediately before the task result', () => {
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
    expect(rows[2]?.classList.contains('structured-tool-row-block')).toBe(true);
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

    expect(container?.querySelectorAll('.tool-status-dot')).toHaveLength(1);
    expect(container?.querySelector('.tool-invocation-running')?.textContent).toContain(
      'Running...'
    );
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
    expect(runningDiv?.textContent).toContain('Retrying (attempt #2)');
    expect(runningDiv?.textContent).toContain('rate limit exceeded');
  });

  it('shows Running when task has no retry status', () => {
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
      'Running...'
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
    const dot = container?.querySelector('.tool-status-dot');
    const label = container?.querySelector('.tool-invocation-error-label');

    expect(dot?.classList.contains('tool-status-aborted')).toBe(true);
    expect(label?.classList.contains('is-aborted')).toBe(true);
    expect(label?.textContent).toBe('aborted');

    (header as HTMLButtonElement).click();

    const detail = container?.querySelector('.tool-invocation-error');

    expect(detail?.classList.contains('is-aborted')).toBe(true);
    expect(detail?.textContent).toContain('Aborted');
  });

  it('hides the command card when a linked permission prompt is pending', () => {
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

    expect(container?.querySelector('.tool-invocation-header')).toBeNull();
    expect(container?.querySelector('.permission-prompt')).not.toBeNull();
    expect(container?.textContent).toContain('Permission Required');
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
    expect(container?.querySelector('.permission-prompt-count')?.textContent).toBe('2');
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
    expect(container?.querySelector('.tool-invocation-header')).toBeNull();
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

    expect(target?.textContent).toBe('main.ts');
    expect(container?.querySelector('.file-read-range')?.textContent).toBe('(L5-7)');

    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: '/repo/src/main.ts', kind: 'file' },
    });
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

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Edited');
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

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Added');
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

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Removed');
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

    expect(container?.querySelector('.file-edit-action-label')?.textContent).toBe('Moved');
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
      payload: { path: '/repo/src/old.ts', kind: 'file' },
    });
    expect(sendSpy).toHaveBeenNthCalledWith(2, {
      type: 'vscode/open',
      payload: { path: '/repo/src/new.ts', kind: 'file' },
    });
  });
});
