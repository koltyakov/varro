import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { setExpandThinkingByDefaultPreference, setState } from '../lib/state';
import type { AssistantMessage, Permission, QuestionRequest, Session, ToolPart } from '../types';
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
  setState('messages', []);
  setState('sessions', []);
  setState('allAgents', []);
  resetToolCallExpansionState();
  delete (window as unknown as Record<string, unknown>).__sendToExtension;
  vi.useRealTimers();
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
      formatToolTitle(
        'task',
        completedState({ description: 'Trace Varro diff logic' }, 'Working')
      )
    ).toBe('Trace Varro diff logic');
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

    expect(container?.querySelector('.chat-tool-invocation-part')?.classList).toContain(
      'tool-invocation-task'
    );
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

    expect(container?.querySelectorAll('.tool-status-dot')).toHaveLength(1);
    const runningStatus = container?.querySelector('.tool-invocation-subagent-running');
    expect(runningStatus?.getAttribute('role')).toBe('status');
    expect(runningStatus?.textContent).toContain('Explore subagent is working');
    expect(runningStatus?.textContent).toContain('Results will appear here when ready.');
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
    expect(stats?.textContent).toBe('↑ 1,234 · ↓ 56');
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

    expect(container?.querySelector('.tool-invocation-token-stats')?.textContent).toBe('↑ 0 · ↓ 0');
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
      '↑ 2,468 · ↓ 135'
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
        ...part.state,
        input: { description: 'Research auth flow', prompt: 'Do something else' },
        title: 'Research auth flow',
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
      '↑ 321 · ↓ 45'
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
});
