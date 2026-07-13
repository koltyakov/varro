import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { ChangedFilesList } from './ChangedFilesList';
import { resetDefaultAppState, setState } from '../lib/state';
import type { Message, Part, Session } from '../types';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

function session(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    projectID: 'project-1',
    directory: '/workspace',
    title: 'Session',
    version: '1',
    time: { created: 1, updated: 2 },
    ...overrides,
  };
}

function assistantMessage(id = 'assistant-1', sessionID = 'session-1'): Message {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'user-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'default',
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function fileEditPart(path: string, sessionID = 'session-1', messageID = 'assistant-1'): Part {
  return {
    id: 'tool-1',
    sessionID,
    messageID,
    type: 'tool',
    callID: 'call-1',
    tool: 'edit',
    state: {
      status: 'completed',
      input: { path, additions: 3, deletions: 1 },
      output: '',
      title: 'Edited file',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function largeFileEditPart(path: string): Part {
  const part = fileEditPart(path);
  if (part.type === 'tool' && part.state.status === 'completed') {
    part.state.input = { path, additions: 3_392, deletions: 30_098 };
  }
  return part;
}

describe('ChangedFilesList', () => {
  beforeEach(() => {
    resetDefaultAppState();
    delete window.__sendToExtension;
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    container?.remove();
    container = null;
    delete window.__sendToExtension;
    resetDefaultAppState();
  });

  it('keeps authoritative session summary files visible while the session is busy', () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session({
        summary: {
          additions: 4,
          deletions: 1,
          files: 1,
          diffs: [{ file: 'src/app.ts', before: '', after: 'updated', additions: 4, deletions: 1 }],
        },
      }),
    ]);
    setState('sessionStatus', 'session-1', { type: 'busy' });

    cleanup = render(() => <ChangedFilesList />, container!);

    expect(container?.textContent).toContain('Files');
    expect(container?.textContent).toContain('1');
    expect(container?.textContent).toContain('+4');
    expect(container?.textContent).toContain('-1');
  });

  it('keeps message-derived files visible while the same session is busy', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session()]);
    setState('messages', [{ info: assistantMessage(), parts: [fileEditPart('src/app.ts')] }]);

    cleanup = render(() => <ChangedFilesList />, container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Files');
    expect(container?.textContent).toContain('1');
    expect(container?.textContent).toContain('+3');
    expect(container?.textContent).toContain('-1');

    setState('sessionStatus', 'session-1', { type: 'busy' });
    await Promise.resolve();

    expect(container?.textContent).toContain('Files');
    expect(container?.textContent).toContain('1');
    expect(container?.textContent).toContain('+3');
    expect(container?.textContent).toContain('-1');
  });

  it('compacts large line counts in the header', () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session()]);
    setState('messages', [{ info: assistantMessage(), parts: [largeFileEditPart('src/app.ts')] }]);

    cleanup = render(() => <ChangedFilesList />, container!);

    expect(container?.querySelector('.changed-files-lines')?.textContent).toContain('+3392');
    expect(container?.querySelector('.changed-files-lines')?.textContent).toContain('-30K');
  });

  it('opens file rows in VS Code diff view', () => {
    const send = vi.fn();
    window.__sendToExtension = send;
    setState('activeSessionId', 'session-1');
    setState('sessions', [session()]);
    setState('messages', [{ info: assistantMessage(), parts: [fileEditPart('src/app.ts')] }]);

    cleanup = render(() => <ChangedFilesList />, container!);
    container?.querySelector<HTMLButtonElement>('.todo-block-header')?.click();
    container?.querySelector<HTMLButtonElement>('.changed-files-row-button')?.click();

    expect(send).toHaveBeenCalledWith({
      type: 'vscode/open',
      payload: { path: 'src/app.ts', kind: 'file', view: 'diff' },
    });
  });

  it('hides backend summary files for an idle session that made no edits', () => {
    // The backend session summary can carry workspace-wide git changes (manual
    // edits, sibling-session writes). A read-only session must not surface them.
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session({
        summary: {
          additions: 9,
          deletions: 4,
          files: 2,
          diffs: [
            { file: 'src/manual.ts', before: '', after: 'x', additions: 5, deletions: 1 },
            { file: 'src/sibling.ts', before: '', after: 'y', additions: 4, deletions: 3 },
          ],
        },
      }),
    ]);

    cleanup = render(() => <ChangedFilesList />, container!);

    expect(container?.textContent).not.toContain('Files');
  });

  it('restricts the files board to files the session actually edited', async () => {
    // A writing session: the agent edited src/app.ts, but the backend summary
    // also includes a manually-edited file. Only the session's own edit shows.
    setState('activeSessionId', 'session-1');
    setState('sessions', [
      session({
        summary: {
          additions: 9,
          deletions: 4,
          files: 2,
          diffs: [
            { file: 'src/app.ts', before: '', after: 'x', additions: 4, deletions: 1 },
            { file: 'src/manual.ts', before: '', after: 'y', additions: 5, deletions: 3 },
          ],
        },
      }),
    ]);
    setState('messages', [{ info: assistantMessage(), parts: [fileEditPart('src/app.ts')] }]);

    cleanup = render(() => <ChangedFilesList />, container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('Files');
    expect(container?.textContent).toContain('1');
    expect(container?.textContent).toContain('+3');
    expect(container?.textContent).toContain('-1');
    expect(container?.textContent).not.toContain('+9');
  });

  it('only aggregates active-session messages and drops stale messages during a switch', async () => {
    setState('activeSessionId', 'session-1');
    setState('sessions', [session(), session({ id: 'session-2', title: 'Other session' })]);
    setState('messages', [
      { info: assistantMessage(), parts: [fileEditPart('src/active.ts')] },
      {
        info: assistantMessage('assistant-2', 'session-2'),
        parts: [fileEditPart('src/other.ts', 'session-2', 'assistant-2')],
      },
    ]);

    cleanup = render(() => <ChangedFilesList />, container!);
    container?.querySelector<HTMLButtonElement>('.todo-block-header')?.click();

    expect(container?.textContent).toContain('active.ts');
    expect(container?.textContent).not.toContain('other.ts');
    expect(container?.querySelector('.todo-block-count')?.textContent).toBe('1');

    setState('messages', (messages) =>
      messages.filter(({ info }) => info.sessionID === 'session-1')
    );
    setState('activeSessionId', 'session-2');
    await Promise.resolve();

    expect(container?.textContent).not.toContain('Files');
  });
});
