import { flush as flushSolid, createSignal } from 'solid-js';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { render } from '@solidjs/web';
import { resetDefaultAppState, setShowFileDiffs } from '../../lib/state';
import type { AssistantMessage, Part, ToolPart } from '../../types';
import { fixture } from '../../test-fixtures';
import { AssistantMessageContent } from './AssistantMessageContent';

let dispose: (() => void) | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  resetDefaultAppState();
  flushSolid();
  setShowFileDiffs(false);
  flushSolid();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  dispose?.();
  flushSolid();
  dispose = undefined;
  container.remove();
  flushSolid();
  resetDefaultAppState();
  flushSolid();
});

function edit(id: string, completed: boolean): ToolPart {
  const input = { filePath: 'src/app.ts', oldString: 'old', newString: id };
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    tool: 'edit',
    callID: id,
    state: completed
      ? {
          status: 'completed',
          input,
          output: 'ok',
          title: 'Edited',
          metadata: {},
          time: { start: 1, end: 2 },
        }
      : { status: 'running', input, time: { start: 1 } },
  };
}

it.each([false, true])(
  'keeps the transcript usable through file-edit replacement and removal (inline diffs: %s)',
  (inlineDiffs) => {
    setShowFileDiffs(inlineDiffs);
    flushSolid();
    const [parts, setParts] = createSignal<Part[]>([edit('first', true)]);
    dispose = render(
      () => (
        <AssistantMessageContent
          info={fixture<AssistantMessage>({
            id: 'assistant-1',
            sessionID: 'session-1',
            role: 'assistant',
            time: { created: 0 },
          })}
          parts={parts()}
          errorMessage={null}
          highlightFinalAnswer={false}
          highlightPlanningAnswer={false}
          suppressHighlightedCardMetaParts={false}
          textForPart={() => null}
        />
      ),
      container
    );
    flushSolid();
    expect(container.textContent).toContain('app.ts');
    function replaceParts(next: Part[]) {
      setParts(next);
      flushSolid();
    }
    expect(
      () => replaceParts([edit('first', true), edit('second', false)]),
      'append running edit'
    ).not.toThrow();
    expect(
      () => replaceParts([edit('first', true), edit('second', true)]),
      'complete second edit'
    ).not.toThrow();
    expect(container.textContent).toContain('app.ts');
    expect(container.querySelectorAll('.assistant-file-edit-stack > *')).toHaveLength(1);
    expect(() => replaceParts([edit('replacement', true)]), 'replace edit snapshot').not.toThrow();
    expect(() => replaceParts([]), 'clear transcript').not.toThrow();
    expect(container.querySelector('.assistant-file-edit-stack')).toBeNull();
    setParts([edit('third', true)]);
    flushSolid();
    expect(container.textContent).toContain('app.ts');
  }
);
