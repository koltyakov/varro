import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  setExpandThinkingByDefaultPreference(false);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setExpandThinkingByDefaultPreference(false);
  setState('permissions', []);
  setState('questions', []);
  resetToolCallExpansionState();
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

  it('keeps the command card visible when a linked permission prompt is pending', () => {
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

    expect(container?.querySelector('.tool-invocation-header')?.textContent).toContain(
      'git status'
    );
    expect(container?.querySelector('.permission-prompt')).not.toBeNull();
    expect(container?.textContent).toContain('Permission Required');
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
});
