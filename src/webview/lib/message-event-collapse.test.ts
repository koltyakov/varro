import { describe, expect, it } from 'vitest';
import type { Part, ToolPart, ToolStateCompleted } from '../types';
import {
  collapseLeadingDuplicateFileEvents,
  getFileEditVisualSignature,
  getTrailingFileEventSignature,
} from './message-event-collapse';

function completedState(
  title: string,
  input: Record<string, unknown>,
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

function toolPart(id: string, state: ToolStateCompleted): ToolPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: `call-${id}`,
    tool: 'edit',
    state,
  };
}

describe('message event collapse helpers', () => {
  it('builds visual signatures including diff stats', () => {
    const part = toolPart(
      'p1',
      completedState('Edited src/app.ts', { path: 'src/app.ts' }, { additions: 3, deletions: 1 })
    );
    expect(getFileEditVisualSignature(part)).toBe('edited:src/app.ts:3,1');
  });

  it('returns null for non-file-change parts', () => {
    const part: Part = {
      id: 'text-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'text',
      text: 'hello',
    };
    expect(getFileEditVisualSignature(part)).toBeNull();
  });

  it('collapses duplicate leading file events only while signatures match', () => {
    const duplicate = toolPart('p1', completedState('Edited src/app.ts', { path: 'src/app.ts' }));
    const kept = toolPart('p2', completedState('Edited src/other.ts', { path: 'src/other.ts' }));
    const result = collapseLeadingDuplicateFileEvents(
      [duplicate, duplicate, kept],
      'edited:src/app.ts'
    );
    expect(result).toEqual([kept]);
  });

  it('treats matching file edits as duplicates across tool statuses', () => {
    const running: ToolPart = {
      id: 'p1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-p1',
      tool: 'edit',
      state: {
        status: 'running',
        input: { path: 'src/app.ts' },
        title: 'Edited src/app.ts',
        time: { start: 0 },
      },
    };
    const completed = toolPart('p2', completedState('Edited src/app.ts', { path: 'src/app.ts' }));

    expect(getFileEditVisualSignature(running)).toBe('edited:src/app.ts');
    expect(getFileEditVisualSignature(completed)).toBe('edited:src/app.ts');
  });

  it('finds the trailing file event signature through step finish parts', () => {
    const edit = toolPart('p1', completedState('Edited src/app.ts', { path: 'src/app.ts' }));
    const stepFinish: Part = {
      id: 'finish-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'step-finish',
      reason: 'done',
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    expect(getTrailingFileEventSignature([edit, stepFinish])).toBe('edited:src/app.ts');
    expect(getTrailingFileEventSignature([stepFinish])).toBeNull();
  });
});
