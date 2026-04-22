import { describe, expect, it } from 'vitest';
import type { Part, ToolPart, ToolStateCompleted } from '../types';
import {
  getFinalAssistantTextPartId,
  isFileEditPart,
  isFileReadPart,
  isTodoToolPart,
  shouldShowAssistantPartInline,
} from './part-utils';
import { setShowThinking } from './state';

function completedState(
  input: Record<string, unknown>,
  title = '',
  metadata: Record<string, unknown> = {}
): ToolStateCompleted {
  return {
    status: 'completed',
    input,
    output: '',
    title,
    metadata,
    time: { start: 0, end: 1 },
  };
}

function toolPart(tool: string, state: ToolStateCompleted): ToolPart {
  return {
    id: `${tool}-1`,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: `${tool}-call`,
    tool,
    state,
  };
}

describe('part utils', () => {
  it('detects file edit and read parts', () => {
    expect(isFileEditPart(toolPart('edit', completedState({ path: 'src/app.ts' })))).toBe(true);
    expect(isFileReadPart(toolPart('file_read', completedState({ filePath: 'src/app.ts' })))).toBe(true);
    expect(
      isFileEditPart({
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'hello',
      })
    ).toBe(false);
  });

  it('detects todo-like tool parts from tool names and titles', () => {
    expect(isTodoToolPart(toolPart('TodoWrite', completedState({})))).toBe(true);
    expect(isTodoToolPart(toolPart('custom', completedState({}, 'Updating plan')))).toBe(true);
    expect(isTodoToolPart(toolPart('custom', completedState({}, 'Run tests')))).toBe(false);
  });

  it('shows or hides assistant parts inline based on type and thinking toggle', () => {
    const textPart: Part = {
      id: 'text-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'text',
      text: '  hello  ',
    };
    const emptyTextPart: Part = { ...textPart, id: 'text-2', text: '   ' };
    const reasoningPart: Part = {
      id: 'reason-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'reasoning',
      text: 'thinking',
      time: { start: 0 },
    };
    const emptyReasoningPart: Part = { ...reasoningPart, id: 'reason-2', text: '' };
    const retryPart: Part = {
      id: 'retry-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'retry',
      attempt: 1,
      error: { name: 'Error', data: { message: 'failed' } },
      time: { created: 0 },
    };

    setShowThinking(true);
    expect(shouldShowAssistantPartInline(textPart)).toBe(true);
    expect(shouldShowAssistantPartInline(emptyTextPart)).toBe(false);
    expect(shouldShowAssistantPartInline(reasoningPart)).toBe(true);
    expect(shouldShowAssistantPartInline(emptyReasoningPart)).toBe(false);
    expect(shouldShowAssistantPartInline(toolPart('todowrite', completedState({})))).toBe(false);
    expect(shouldShowAssistantPartInline(retryPart)).toBe(true);

    setShowThinking(false);
    expect(shouldShowAssistantPartInline(reasoningPart)).toBe(false);
    expect(shouldShowAssistantPartInline(reasoningPart, false)).toBe(true);
  });

  it('identifies the last visible text part when highlighting is enabled for the turn', () => {
    const parts: Part[] = [
      {
        id: 'reason-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'reasoning',
        text: 'thinking',
        time: { start: 0 },
      },
      toolPart('read', completedState({ filePath: 'src/app.ts' }, 'Read file')),
      {
        id: 'text-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'Progress update',
      },
      {
        id: 'text-2',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'Final answer',
      },
    ];

    expect(getFinalAssistantTextPartId(parts, false)).toBeNull();
    expect(getFinalAssistantTextPartId(parts, true)).toBe('text-2');
  });

  it('does not mark a final answer when the highlighted turn has no visible text', () => {
    const parts: Part[] = [
      {
        id: 'reason-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'reasoning',
        text: 'thinking',
        time: { start: 0 },
      },
      toolPart('edit', completedState({ path: 'src/app.ts' }, 'Update file')),
    ];

    expect(getFinalAssistantTextPartId(parts, true)).toBeNull();
  });
});
