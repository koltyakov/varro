import { afterEach, beforeEach, expect, it } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { resetDefaultAppState, setShowFileDiffs } from '../../lib/state';
import type { AssistantMessage, Part, ToolPart } from '../../types';
import { fixture } from '../../test-fixtures';
import { AssistantMessageContent } from './AssistantMessageContent';

let dispose: (() => void) | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  resetDefaultAppState();
  setShowFileDiffs(false);
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  resetDefaultAppState();
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
    expect(container.textContent).toContain('app.ts');
    expect(
      () => setParts([edit('first', true), edit('second', false)]),
      'append running edit'
    ).not.toThrow();
    expect(
      () => setParts([edit('first', true), edit('second', true)]),
      'complete second edit'
    ).not.toThrow();
    expect(container.textContent).toContain('app.ts');
    expect(container.querySelectorAll('.assistant-file-edit-stack > *')).toHaveLength(1);
    expect(() => setParts([edit('replacement', true)]), 'replace edit snapshot').not.toThrow();
    expect(() => setParts([]), 'clear transcript').not.toThrow();
    expect(container.querySelector('.assistant-file-edit-stack')).toBeNull();
    setParts([edit('third', true)]);
    expect(container.textContent).toContain('app.ts');
  }
);
