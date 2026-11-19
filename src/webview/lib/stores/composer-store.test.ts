import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EditorContext } from '../../../shared/protocol';
import type { NormalizedTodo } from '../../types';
import { composerStore } from './composer-store';
import { resetDefaultAppState, setState, state } from '../state';

function createEditorContext(): EditorContext {
  return {
    workspacePath: '/workspace',
    activeFile: {
      path: '/workspace/src/index.ts',
      relativePath: 'src/index.ts',
      language: 'typescript',
    },
    selection: {
      startLine: 2,
      endLine: 5,
    },
    diagnostics: [
      {
        path: '/workspace/src/index.ts',
        severity: 'warning',
        message: 'Unused variable',
        line: 3,
      },
    ],
  };
}

describe('composerStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    flushSolid();
    resetDefaultAppState();
    flushSolid();
  });

  it('updates editor and terminal context', () => {
    const context = createEditorContext();
    const selection = { text: 'npm test', terminalName: 'zsh' };

    composerStore.setEditorContext(context);
    flushSolid();
    composerStore.setTerminalSelection(selection);
    flushSolid();

    expect(state.editorContext).toEqual(context);
    expect(state.terminalSelection).toEqual(selection);

    composerStore.clearTerminalSelection();
    flushSolid();

    expect(state.terminalSelection).toBeNull();
  });

  it('clears dropped files and todos', () => {
    const todo: NormalizedTodo = {
      id: 'todo-1',
      content: 'Ship tests',
      status: 'pending',
      priority: 'high',
    };

    setState(
      storePath('droppedFiles', [
        {
          path: '/workspace/src/file.ts',
          relativePath: 'src/file.ts',
          type: 'file',
        },
      ])
    );
    flushSolid();
    setState(storePath('todos', [todo]));
    flushSolid();

    composerStore.clearDroppedFiles();
    flushSolid();
    composerStore.clearTodos();
    flushSolid();

    expect(state.droppedFiles).toEqual([]);
    expect(state.todos).toEqual([]);
  });
});
