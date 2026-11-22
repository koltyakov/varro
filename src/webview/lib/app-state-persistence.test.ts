import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppState } from './app-state';
import { flushInputDraft, inputDraftKey, readInputDraft } from './input-draft-persistence';
import { STORAGE_KEYS } from './state-storage';
import type { UnknownRecord } from '../../shared/type-utils';

beforeEach(() => {
  flushInputDraft();
  window.localStorage.clear();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete (window as { __vscodeWebviewState?: unknown }).__vscodeWebviewState;
  // SAFETY: The fixture provides the unknown fields read by this statement.
  delete (window as { __initialWebviewState?: unknown }).__initialWebviewState;
});

afterEach(() => {
  flushInputDraft();
  vi.useRealTimers();
});

describe('empty-state histogram configuration', () => {
  it('defaults to disabled', () => {
    expect(createAppState().showEmptyStateHistogram()).toBe(false);
  });

  it.each([true, false])('restores the host opt-in value %s', (showEmptyStateHistogram) => {
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      showEmptyStateHistogram,
    };

    expect(createAppState().showEmptyStateHistogram()).toBe(showEmptyStateHistogram);
  });
});

describe('composer draft persistence', () => {
  it('keeps a migrated legacy draft visible when opening history and the session picker', () => {
    window.localStorage.setItem(STORAGE_KEYS.inputDraft, JSON.stringify('unassigned draft'));
    const app = createAppState();
    expect(app.inputText()).toBe('unassigned draft');
    app.setState((d) => {
      d.activeSessionId = 'root';
    });
    expect(app.inputText()).toBe('unassigned draft');
    app.setShowSessionPicker(true);
    expect(app.inputText()).toBe('unassigned draft');
  });

  it('adopts an existing session draft into the shared input on selection', () => {
    const legacyKey = inputDraftKey(null, 'root');
    window.localStorage.setItem(legacyKey, JSON.stringify('Previously parked text'));
    const app = createAppState();
    app.setState((draft) => {
      draft.activeSessionId = 'root';
    });
    expect(app.inputText()).toBe('Previously parked text');
    expect(readInputDraft(legacyKey)).toBeNull();
    expect(createAppState().inputText()).toBe('Previously parked text');
  });

  it('recovers an interrupted legacy migration into an empty shared draft', () => {
    const legacyKey = `${inputDraftKey(null, null)}:legacy`;
    window.localStorage.setItem(legacyKey, JSON.stringify('Interrupted migration text'));
    expect(createAppState().inputText()).toBe('Interrupted migration text');
    expect(readInputDraft(legacyKey)).toBeNull();
  });

  it.each(['Current unsent text', 'Previously parked text'])(
    'preserves shared input %j when opening a session with an old draft',
    (currentText) => {
      const legacyKey = inputDraftKey(null, 'root');
      window.localStorage.setItem(legacyKey, JSON.stringify('Previously parked text'));
      const app = createAppState();
      app.setInputText(currentText);
      app.setState((draft) => {
        draft.activeSessionId = 'root';
      });
      expect(app.inputText()).toBe(currentText);
      expect(readInputDraft(legacyKey)).toBe(
        currentText === 'Previously parked text' ? null : 'Previously parked text'
      );
      if (currentText !== 'Previously parked text') {
        app.setInputText('');
        app.setShowSessionPicker(true);
        app.setShowSessionPicker(false);
        expect(app.inputText()).toBe('Previously parked text');
        expect(readInputDraft(legacyKey)).toBeNull();
      }
    }
  );

  it('restores the native initial route before selection and isolates editor view IDs', () => {
    let saved: UnknownRecord = { [STORAGE_KEYS.inputDraft]: 'old editor text' };
    Object.assign(window, {
      __vscodeWebviewState: {
        getState: () => saved,
        setState: (v: UnknownRecord) => {
          saved = v;
        },
      },
    });
    const view = (id: string) =>
      Object.assign(window, {
        __initialWebviewState: {
          webviewContext: {
            viewId: id,
            surface: 'editor',
            initialRoute: { type: 'session', sessionId: 'root' },
          },
        },
      });
    view('editor-1');
    const app = createAppState();
    expect(app.state.activeSessionId).toBeNull();
    expect(app.inputText()).toBe('old editor text');
    app.setState((d) => {
      d.activeSessionId = 'root';
    });
    app.setInputText('root checkpoint');
    app.setState((d) => {
      d.activeSessionId = 'child';
    });
    app.setInputText('child checkpoint');
    view('editor-2');
    expect(createAppState().inputText()).toBe('');
    view('editor-1');
    const reload = createAppState();
    expect(reload.inputText()).toBe('child checkpoint');
    reload.setState((d) => {
      d.activeSessionId = 'child';
    });
    expect(reload.inputText()).toBe('child checkpoint');
  });

  it('does not bind a parked workspace marker to a namesake file or image in the shared tray', () => {
    const app = createAppState();
    app.setState((d) => {
      d.activeSessionId = 'root';
      d.editorContext.workspacePath = '/a';
      d.droppedFiles = [{ path: '/a/main.ts', type: 'file', relativePath: 'main.ts' }];
      d.clipboardImages = [
        { id: 'first', url: 'blob:first', filename: 'Image 1', size: 1, mime: 'image/png' },
      ];
    });
    app.setInputText('Look at @main.ts and [Image 1]');
    app.setState((d) => {
      d.activeSessionId = 'child';
      d.editorContext.workspacePath = '/b';
    });
    app.setState((d) => {
      d.droppedFiles = [{ path: '/b/main.ts', type: 'file', relativePath: 'main.ts' }];
      d.clipboardImages = [
        { id: 'second', url: 'blob:second', filename: 'Image 1', size: 1, mime: 'image/png' },
      ];
    });
    app.setInputText('child text');
    app.setState((d) => {
      d.activeSessionId = 'root';
      d.editorContext.workspacePath = '/a';
    });
    expect(app.inputText()).toBe('Look at /a/main.ts and _____');
  });
  it('shares unsent text across root, child and picker routes while isolating workspaces', () => {
    const app = createAppState();
    const select = (id: string) =>
      app.setState((draft) => {
        draft.activeSessionId = id;
      });
    const folder = (path: string) =>
      app.setState((draft) => {
        draft.editorContext.workspacePath = path;
      });
    folder('/repo-a');
    select('root');
    app.setInputText('unfinished root');
    select('child');
    expect(app.inputText()).toBe('unfinished root');
    app.setInputText('unfinished child');
    app.setShowSessionPicker(true);
    expect(app.inputText()).toBe('unfinished child');
    app.setInputText('new chat');
    app.setShowSessionPicker(false);
    expect(app.inputText()).toBe('new chat');
    select('root');
    expect(app.inputText()).toBe('new chat');
    folder('/repo-b');
    expect(app.inputText()).toBe('');
    folder('/repo-a');
    expect(app.inputText()).toBe('new chat');
    app.setShowSessionPicker(true);
    expect(app.inputText()).toBe('new chat');
  });

  it('does not resurrect a sent or cleared draft when returning to another session', () => {
    const app = createAppState();
    app.setState((draft) => {
      draft.activeSessionId = 'root';
    });
    app.setInputText('Send from the child instead');
    app.setState((draft) => {
      draft.activeSessionId = 'child';
    });
    expect(app.inputText()).toBe('Send from the child instead');
    app.setInputText('');
    app.setState((draft) => {
      draft.activeSessionId = 'root';
    });
    expect(app.inputText()).toBe('');
    expect(app.readLatestDraftText()).toBe('');
    app.setShowSessionPicker(true);
    expect(app.inputText()).toBe('');
  });

  it('ends route-owned edits before carrying the unsent input to another session', () => {
    const app = createAppState();
    app.setState((draft) => {
      draft.activeSessionId = 'root';
    });
    const source = app.currentDraftKey();
    app.setInputText('Temporary edit text');
    const stop = app.onBeforeDraftSwitch(() =>
      app.writeOwnedDraft(source, 'Original unsent input')
    );
    app.setState((draft) => {
      draft.activeSessionId = 'child';
    });
    stop();
    expect(app.currentDraftKey()).toBe(source);
    expect(app.draftSessionId()).toBe('child');
    expect(app.inputText()).toBe('Original unsent input');
    expect(app.readLatestDraftText()).toBe('Original unsent input');

    app.setState((draft) => {
      draft.editorContext.workspacePath = '/another-workspace';
    });
    app.setInputText('Other workspace input');
    app.writeOwnedDraft(source, 'Late failed send');
    expect(app.readLatestDraftText()).toBe('Other workspace input');
  });
  it('uses host session models instead of stale editor-local variants', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.sessionSelectedModels,
      JSON.stringify({
        'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'medium' },
      })
    );
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'session', sessionId: 'session-1' },
      },
      sessionSelectedModels: {
        'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
      },
    };

    const appState = createAppState();

    expect(appState.state.sessionSelectedModels['session-1']).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });
  });

  it('uses host model preferences instead of stale editor-local settings', () => {
    window.localStorage.setItem(STORAGE_KEYS.pinnedModels, JSON.stringify(['openai:stale']));
    window.localStorage.setItem(STORAGE_KEYS.hiddenProviders, JSON.stringify(['openai']));
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
      modelPreferences: {
        modelVariantSelections: {},
        providerOrder: ['openai'],
        modelOrder: ['openai:gpt-5.6-sol'],
        hiddenProviders: [],
        hiddenModels: [],
        addedModels: [],
        pinnedModels: ['openai:gpt-5.6-sol'],
        modelDisplayNames: {},
      },
    };

    const appState = createAppState();

    expect(appState.state.hiddenProviders).toEqual([]);
    expect(appState.state.providerOrder).toEqual(['openai']);
    expect(appState.state.modelOrder).toEqual(['openai:gpt-5.6-sol']);
    expect(appState.state.pinnedModels).toEqual(['openai:gpt-5.6-sol']);
  });

  it('does not restore a selected model from another project', () => {
    window.localStorage.setItem(
      `${STORAGE_KEYS.selectedModel}:/repo-a`,
      JSON.stringify({ providerID: 'openai', modelID: 'repo-a-model' })
    );
    window.localStorage.setItem(
      STORAGE_KEYS.selectedModel,
      JSON.stringify({ providerID: 'openai', modelID: 'legacy-global-model' })
    );
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo-b',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    expect(createAppState().state.selectedModel).toBeNull();
  });

  it('loads the shared last model separately from the project and session choices', () => {
    const lastSelectedModel = { providerID: 'openai', modelID: 'sol', variant: 'high' };
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/new-project',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      modelPreferences: { lastSelectedModel },
    };
    const appState = createAppState();
    expect(appState.state.lastSelectedModel).toEqual(lastSelectedModel);
    expect(appState.state.selectedModel).toBeNull();
  });

  it('restores draft text when app state is recreated', () => {
    const first = createAppState();
    first.setInputText('Keep this draft');

    const restored = createAppState();

    expect(restored.inputText()).toBe('Keep this draft');
    flushInputDraft();
    expect(window.localStorage.getItem(inputDraftKey(null, null))).toBe(
      JSON.stringify('Keep this draft')
    );
  });

  it('restores the queued edit identity with its draft', () => {
    window.localStorage.setItem(STORAGE_KEYS.inputDraft, JSON.stringify('Edit this follow-up'));
    window.localStorage.setItem(
      STORAGE_KEYS.queuedMessages,
      JSON.stringify([{ id: 'queue-1', sessionId: 'session-1', text: 'Edit this follow-up' }])
    );
    window.localStorage.setItem(
      STORAGE_KEYS.queuedMessageEdit,
      JSON.stringify({ id: 'queue-1', sessionId: 'session-1' })
    );

    const restored = createAppState();

    expect(restored.inputText()).toBe('Edit this follow-up');
    expect(restored.state.queuedMessageEdit).toEqual({ id: 'queue-1', sessionId: 'session-1' });
  });

  it('keeps a sidebar queued edit when only the host default New Chat route is available', () => {
    const queued = { id: 'queue-1', sessionId: 'session-1', text: 'Unfinished queued edit' };
    let saved: UnknownRecord = {
      [STORAGE_KEYS.inputDraft]: queued.text,
      [STORAGE_KEYS.queuedMessageEdit]: { id: queued.id, sessionId: queued.sessionId },
    };
    Object.assign(window, {
      __vscodeWebviewState: {
        getState: () => saved,
        setState: (value: UnknownRecord) => {
          saved = value;
        },
      },
      __initialWebviewState: {
        webviewContext: {
          viewId: 'sidebar',
          surface: 'sidebar',
          initialRoute: { type: 'new-session' },
        },
        queuedMessages: [queued],
      },
    });
    const restored = createAppState();
    expect(restored.inputText()).toBe(queued.text);
    expect(restored.draftSessionId()).toBe(queued.sessionId);
    expect(restored.state.queuedMessageEdit).toEqual({
      id: queued.id,
      sessionId: queued.sessionId,
    });
  });

  it('discards a queued edit draft missing from the authoritative host queue', () => {
    window.localStorage.setItem(STORAGE_KEYS.inputDraft, JSON.stringify('Stale queued draft'));
    window.localStorage.setItem(
      STORAGE_KEYS.queuedMessageEdit,
      JSON.stringify({ id: 'queue-1', sessionId: 'session-1' })
    );
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      queuedMessages: [],
    };

    const restored = createAppState();

    expect(restored.inputText()).toBe('');
    expect(restored.state.queuedMessages).toEqual([]);
    expect(restored.state.queuedMessageEdit).toBeNull();
    expect(window.localStorage.getItem(inputDraftKey(null, null))).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.queuedMessageEdit)).toBeNull();
  });

  it('discards a restored queued edit when the native route opens a different session', () => {
    const queued = { id: 'queue-1', sessionId: 'session-1', text: 'Queued edit text' };
    let saved: UnknownRecord = {
      [STORAGE_KEYS.inputDraft]: queued.text,
      [STORAGE_KEYS.queuedMessageEdit]: { id: queued.id, sessionId: queued.sessionId },
    };
    Object.assign(window, {
      __vscodeWebviewState: {
        getState: () => saved,
        setState: (value: UnknownRecord) => {
          saved = value;
        },
      },
      __initialWebviewState: {
        webviewContext: {
          viewId: 'editor',
          surface: 'editor',
          initialRoute: { type: 'session', sessionId: 'session-2' },
        },
        queuedMessages: [queued],
      },
    });
    saved[inputDraftKey(null, null)] = queued.text;
    saved[inputDraftKey(null, queued.sessionId)] = queued.text;

    const restored = createAppState();

    expect(restored.inputText()).toBe('');
    expect(restored.state.queuedMessageEdit).toBeNull();
    expect(restored.state.queuedMessages).toMatchObject([queued]);
    expect(saved[STORAGE_KEYS.queuedMessageEdit]).toBeUndefined();
    expect(readInputDraft(inputDraftKey(null, queued.sessionId))).toBeNull();
  });

  it('restores draft text from VS Code webview state', () => {
    let vscodeState: UnknownRecord = {};
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'sidebar',
        surface: 'sidebar',
        initialRoute: { type: 'new-session' },
      },
    };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (
      window as {
        __vscodeWebviewState: {
          getState(): UnknownRecord;
          setState(state: UnknownRecord): void;
        };
      }
    ).__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    const first = createAppState();
    first.setInputText('Keep this VS Code draft');
    flushInputDraft();
    window.localStorage.clear();

    const restored = createAppState();

    expect(restored.inputText()).toBe('Keep this VS Code draft');
    expect(vscodeState[inputDraftKey(null, null)]).toBe('Keep this VS Code draft');
  });

  it.each(['sidebar', 'editor'] as const)(
    'checkpoints the latest %s draft before a reload can snapshot the old value',
    (surface) => {
      vi.useFakeTimers();
      let vscodeState: UnknownRecord = {
        [STORAGE_KEYS.inputDraft]: 'Older persisted draft',
        unrelated: 'Preserve other webview state',
      };
      // SAFETY: These fixtures provide the native host context and state API.
      (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
        webviewContext: { viewId: surface, surface, initialRoute: { type: 'new-session' } },
      };
      const setState = vi.fn((state: UnknownRecord) => {
        vscodeState = state;
      });
      // SAFETY: These fixtures provide the native host context and state API.
      (window as { __vscodeWebviewState?: unknown }).__vscodeWebviewState = {
        getState: () => vscodeState,
        setState,
      };
      const appState = createAppState();
      setState.mockClear();

      appState.setInputText('Newest visible draft');

      // VS Code can snapshot state before pagehide or the draft debounce fires.
      expect(vscodeState[inputDraftKey(null, null)]).toBe('Newest visible draft');
      expect(vscodeState.unrelated).toBe('Preserve other webview state');
      expect(setState).toHaveBeenCalledOnce();
      expect(window.localStorage.getItem(inputDraftKey(null, null))).toBeNull();

      appState.setInputText('Newest visible draft');
      vi.runAllTimers();
      window.dispatchEvent(new Event('pagehide'));
      expect(setState).toHaveBeenCalledOnce();
      expect(readInputDraft(inputDraftKey(null, null))).toBe('Newest visible draft');

      appState.setInputText('');
      expect(vscodeState[inputDraftKey(null, null)]).toBeUndefined();
      expect(createAppState().inputText()).toBe('');
      vi.runAllTimers();
      expect(readInputDraft(inputDraftKey(null, null))).toBeNull();
    }
  );

  it('coalesces browser draft writes, keeps pending reads coherent, and flushes on pagehide', () => {
    vi.useFakeTimers();
    const appState = createAppState();
    const setState = vi.spyOn(Storage.prototype, 'setItem');
    setState.mockClear();

    appState.setInputText('a');
    appState.setInputText('ab');
    appState.setInputText('abc');

    expect(readInputDraft(inputDraftKey(null, null))).toBe('abc');
    expect(setState).not.toHaveBeenCalled();
    expect(createAppState().inputText()).toBe('abc');
    expect(setState).not.toHaveBeenCalled();
    setState.mockClear();

    vi.advanceTimersByTime(99);
    expect(setState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setState).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(inputDraftKey(null, null))).toBe(JSON.stringify('abc'));

    appState.setInputText('flush before unload');
    window.dispatchEvent(new Event('pagehide'));

    expect(setState).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem(inputDraftKey(null, null))).toBe(
      JSON.stringify('flush before unload')
    );
    setState.mockRestore();
  });

  it('cancels a pending draft write when the draft is cleared', () => {
    vi.useFakeTimers();
    const appState = createAppState();
    const setState = vi.spyOn(Storage.prototype, 'setItem');
    setState.mockClear();

    appState.setInputText('do not restore this');
    appState.setInputText('');
    vi.runAllTimers();

    expect(readInputDraft(inputDraftKey(null, null))).toBeNull();
    expect(window.localStorage.getItem(inputDraftKey(null, null))).toBeNull();
    expect(setState).not.toHaveBeenCalled();
    setState.mockRestore();
  });

  it('restores a manual editor workspace selection across path spelling changes', () => {
    let vscodeState: UnknownRecord = {
      [STORAGE_KEYS.workspacePath]: 'C:\\Users\\Andrew\\Repo',
      [STORAGE_KEYS.manualWorkspaceSelection]: true,
    };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (
      window as {
        __vscodeWebviewState: {
          getState(): UnknownRecord;
          setState(state: UnknownRecord): void;
        };
      }
    ).__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
      editorContext: {
        workspacePath: 'c:/users/andrew/repo',
        workspaceFolders: [],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    const restored = createAppState();

    expect(restored.manualWorkspaceSelection()).toBe(true);
    restored.setManualWorkspaceSelection(false);
    expect(vscodeState[STORAGE_KEYS.manualWorkspaceSelection]).toBeUndefined();
  });

  it('does not restore a manual selection for a different workspace', () => {
    let vscodeState: UnknownRecord = {
      [STORAGE_KEYS.workspacePath]: '/repo-a',
      [STORAGE_KEYS.manualWorkspaceSelection]: true,
    };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (
      window as {
        __vscodeWebviewState: {
          getState(): UnknownRecord;
          setState(state: UnknownRecord): void;
        };
      }
    ).__vscodeWebviewState = {
      getState: () => vscodeState,
      setState: (state) => {
        vscodeState = state;
      },
    };
    // SAFETY: The fixture provides the host-owned initial webview state.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      webviewContext: {
        viewId: 'editor-1',
        surface: 'editor',
        initialRoute: { type: 'new-session' },
      },
      editorContext: {
        workspacePath: '/repo-b',
        workspaceFolders: [],
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    expect(createAppState().manualWorkspaceSelection()).toBe(false);
  });

  it('persists functional updates and removes an empty draft', () => {
    const appState = createAppState();
    appState.setInputText('Keep');
    appState.setInputText((value) => `${value} this`);

    expect(createAppState().inputText()).toBe('Keep this');

    appState.setInputText('');

    expect(window.localStorage.getItem(inputDraftKey(null, null))).toBeNull();
    expect(createAppState().inputText()).toBe('');
  });

  it('restores attached files when app state is recreated', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.inputDraftFiles,
      JSON.stringify([
        {
          path: '/repo/src/file.ts',
          relativePath: 'src/file.ts',
          type: 'file',
          lineRanges: [{ startLine: 2, endLine: 4 }],
          attachmentSequence: 3,
        },
        { path: '', relativePath: 'invalid.ts', type: 'file' },
      ])
    );

    const restored = createAppState();

    expect(restored.state.droppedFiles).toEqual([
      {
        path: '/repo/src/file.ts',
        relativePath: 'src/file.ts',
        type: 'file',
        lineRanges: [{ startLine: 2, endLine: 4 }],
        attachmentSequence: 3,
      },
    ]);
  });

  it('restores pasted images from host state without stale temporary files', () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      clipboardImages: [
        {
          id: 'image-1',
          url: 'data:image/png;base64,AA==',
          mime: 'image/png',
          filename: 'pasted-image-1.png',
          size: 1,
          attachmentSequence: 4,
          contextFile: {
            path: '/tmp/old-host/image.png',
            relativePath: 'image.png',
            type: 'file',
          },
        },
      ],
    };

    const restored = createAppState();

    expect(restored.state.clipboardImages).toEqual([
      {
        id: 'image-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'pasted-image-1.png',
        size: 1,
        attachmentSequence: 4,
      },
    ]);
  });
});
