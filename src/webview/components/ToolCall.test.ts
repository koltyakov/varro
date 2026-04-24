import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { setExpandThinkingByDefaultPreference } from '../lib/state';
import type { ToolPart } from '../types';
import {
  ToolCall,
  formatToolTitle,
  getVisibleInputEntries,
  shouldShowToolPreview,
} from './ToolCall';

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
});
