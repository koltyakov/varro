import { describe, expect, it } from 'vitest';
import type { ToolPart } from '../types';
import { formatToolTitle, getVisibleInputEntries, shouldShowToolPreview } from './ToolCall';

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
