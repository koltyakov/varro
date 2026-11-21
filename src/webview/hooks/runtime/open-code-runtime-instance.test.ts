import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPersistedSelectedAgent,
  inputText,
  resetDefaultAppState,
  setShowSessionPicker,
  setInputText,
  setSelectedAgent,
  setSelectedModel,
  setState,
  state,
  showSessionPicker,
} from '../../lib/state';
import {
  getSessionHistoryCursor,
  isSessionHistoryTruncated,
  setSessionHistoryCursor,
} from '../../lib/message-window';
import { editingMessage, startEditingMessage } from '../../lib/message-edit-state';
import { flushInputDraft } from '../../lib/input-draft-persistence';
import { sessionStore } from '../../lib/stores/session-store';
import type { Session, SessionStatus } from '../../types';
import { SessionMcpOperations } from '../session/session-mcp';
import {
  createPerSessionMessageSyncGenerations,
  createSessionStatusSnapshotCoordinator,
  resetWorkspaceDerivedState,
} from './open-code-runtime-instance';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('open code runtime synchronization', () => {
  it('retains the active transcript and pagination when transfer activation changes the workspace', () => {
    const sessionId = 'session-1';
    setState(storePath('activeSessionId', sessionId));
    flushSolid();
    setState(
      storePath('messages', [
        {
          info: {
            id: 'message-1',
            sessionID: sessionId,
            role: 'user',
            agent: 'build',
            model: { providerID: 'openai', modelID: 'test' },
            time: { created: 1 },
          },
          parts: [],
        },
      ])
    );
    flushSolid();
    setInputText('Unsent draft');
    flushSolid();
    setSessionHistoryCursor(sessionId, 'cursor-1');
    flushSolid();
    const messages = state.messages;
    resetWorkspaceDerivedState({ preserveWorkspaceCatalog: true, preserveTranscript: true });
    flushSolid();
    expect(state.activeSessionId).toBe(sessionId);
    expect(state.messages).toBe(messages);
    expect(inputText()).toBe('Unsent draft');
    expect(getSessionHistoryCursor(sessionId)).toBe('cursor-1');
  });
  beforeEach(() => {
    resetDefaultAppState();
    flushSolid();
  });

  afterEach(() => {
    flushInputDraft();
    flushSolid();
  });

  it('retains the original request timestamp for cached status snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    flushSolid();
    const pendingStatuses = deferred<Record<string, SessionStatus>>();
    const loadSessionStatuses = vi.fn(() => pendingStatuses.promise);
    const snapshots = createSessionStatusSnapshotCoordinator(loadSessionStatuses);

    try {
      const firstLoad = snapshots.load();
      await Promise.resolve();
      flushSolid();
      expect(loadSessionStatuses).toHaveBeenCalledTimes(1);

      vi.setSystemTime(2_000);
      flushSolid();
      sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
      flushSolid();
      pendingStatuses.resolve({ 'session-1': { type: 'idle' } });
      flushSolid();
      const firstSnapshot = await firstLoad;
      flushSolid();

      vi.setSystemTime(2_050);
      flushSolid();
      const cachedSnapshot = await snapshots.load();
      flushSolid();

      expect(cachedSnapshot).toBe(firstSnapshot);
      expect(cachedSnapshot.startedAt).toBe(1_000);
      expect(loadSessionStatuses).toHaveBeenCalledTimes(1);

      sessionStore.setSessionStatuses(cachedSnapshot.statuses, {
        snapshotStartedAt: cachedSnapshot.startedAt,
      });
      flushSolid();
      expect(state.sessionStatus['session-1']).toEqual({ type: 'busy' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows message responses for different sessions to apply out of order', async () => {
    const generations = createPerSessionMessageSyncGenerations();
    const sessionA = deferred<void>();
    const sessionB = deferred<void>();
    const applied: string[] = [];
    const sync = (sessionId: string, pending: Promise<void>) =>
      generations.run(sessionId, async (token) => {
        await pending;
        if (generations.isCurrent(token)) applied.push(sessionId);
      });

    const syncA = sync('session-a', sessionA.promise);
    flushSolid();
    const syncB = sync('session-b', sessionB.promise);
    flushSolid();

    sessionB.resolve();
    flushSolid();
    await expect(syncB).resolves.toBe(true);
    flushSolid();
    sessionA.resolve();
    flushSolid();
    await expect(syncA).resolves.toBe(true);
    flushSolid();

    expect(applied).toEqual(['session-b', 'session-a']);
  });

  it('ignores an older message response for the same session', async () => {
    const generations = createPerSessionMessageSyncGenerations();
    const responseA = deferred<void>();
    const responseB = deferred<void>();
    const applied: string[] = [];
    const sync = (label: string, pending: Promise<void>) =>
      generations.run('session-1', async (token) => {
        await pending;
        if (generations.isCurrent(token)) applied.push(label);
      });

    const syncA = sync('a', responseA.promise);
    flushSolid();
    const syncB = sync('b', responseB.promise);
    flushSolid();
    responseB.resolve();
    flushSolid();
    await expect(syncB).resolves.toBe(true);
    flushSolid();
    responseA.resolve();
    flushSolid();
    await expect(syncA).resolves.toBe(false);
    flushSolid();

    expect(applied).toEqual(['b']);
  });

  it('invalidates in-flight message synchronization when generations are cleared', async () => {
    const generations = createPerSessionMessageSyncGenerations();
    const response = deferred<void>();
    const applied = vi.fn();
    const sync = generations.run('session-1', async (token) => {
      await response.promise;
      if (generations.isCurrent(token)) applied();
    });
    flushSolid();

    generations.clear();
    flushSolid();
    response.resolve();
    flushSolid();

    await expect(sync).resolves.toBe(false);
    flushSolid();
    expect(applied).not.toHaveBeenCalled();
  });

  it('refreshes authoritative MCP state after a reconciliation is invalidated', async () => {
    const connection = deferred<void>();
    const loadMcps = vi.fn(async () => {});
    const operations = new SessionMcpOperations({
      getSelectedMcpsForSession: () => ['docs'],
      getMcpStatus: () => ({ docs: { status: 'disabled' } }),
      loadMcps,
      getAvailableMcpNames: () => ['docs'],
      connectMcp: () => connection.promise,
      authenticateMcp: vi.fn(async () => {}),
      disconnectMcp: vi.fn(async () => {}),
      logError: vi.fn(),
      setSelectedMcpsForSession: vi.fn(),
      setDraftSelectedMcps: vi.fn(),
    });

    const reconciliation = operations.syncSessionMcps('session-old');
    flushSolid();
    await Promise.resolve();
    flushSolid();
    operations.invalidate();
    connection.resolve();
    flushSolid();
    await reconciliation;
    flushSolid();

    expect(loadMcps).toHaveBeenCalledOnce();
  });

  it('clears workspace-derived state while preserving toolbar catalogs and session maps', () => {
    const oldSession: Session = {
      id: 'session-old',
      projectID: 'project-old',
      directory: '/repo-old',
      title: 'Old session',
      version: '1',
      time: { created: 0, updated: 0 },
    };
    const globalModel = { providerID: 'openai', modelID: 'global' };
    const sessionModel = { providerID: 'openai', modelID: 'session' };
    setState(
      storePath('editorContext', {
        workspacePath: '/repo-next',
        activeFile: null,
        selection: null,
        diagnostics: [],
      })
    );
    flushSolid();
    setSelectedAgent('global-agent');
    flushSolid();
    setSelectedModel(globalModel);
    flushSolid();
    setState(storePath('editorContext', 'workspacePath', oldSession.directory));
    flushSolid();
    setSelectedAgent('session-agent', { sessionId: oldSession.id, persistGlobal: false });
    flushSolid();
    setSelectedModel(sessionModel, { sessionId: oldSession.id, persistGlobal: false });
    flushSolid();
    setState(storePath('sessions', [oldSession]));
    flushSolid();
    setState(storePath('activeSessionId', oldSession.id));
    flushSolid();
    setState(storePath('sessionStatus', oldSession.id, { type: 'busy' }));
    flushSolid();
    setState(
      storePath('permissions', [
        {
          id: 'permission-old',
          sessionID: oldSession.id,
          messageID: 'message-old',
          type: 'edit',
          pattern: '*',
          title: 'Edit files',
          metadata: {},
          time: { created: 0 },
        },
      ])
    );
    flushSolid();
    setState(
      storePath('questions', [{ id: 'question-old', sessionID: oldSession.id, questions: [] }])
    );
    flushSolid();
    setState(storePath('sessionPermissionModes', oldSession.id, 'full'));
    flushSolid();
    setState(storePath('currentDocumentEnabledBySession', oldSession.id, false));
    flushSolid();
    setState(
      storePath('queuedMessages', [
        { id: 'queued-old', sessionId: oldSession.id, text: 'preserve me' },
      ])
    );
    flushSolid();
    setState(storePath('queuedMessageDispatchingId', 'queued-old'));
    flushSolid();
    setState(storePath('failedQueuedMessageIds', ['queued-old']));
    flushSolid();
    setState(storePath('queuedMessageEdit', { id: 'queued-old', sessionId: oldSession.id }));
    flushSolid();
    setState(storePath('lastSeenSessions', oldSession.id, 10));
    flushSolid();
    setState(storePath('hiddenProviders', ['hidden-provider']));
    flushSolid();
    setState(
      storePath('agents', [
        {
          name: 'build',
          description: 'Build agent',
          mode: 'primary',
          builtIn: true,
          permission: [],
          tools: {},
        },
      ])
    );
    flushSolid();
    setState(
      storePath('providers', [
        {
          id: 'openai',
          name: 'OpenAI',
          source: 'api',
          models: {
            'gpt-5': {
              id: 'gpt-5',
              name: 'GPT-5',
              capabilities: { toolcall: true },
              cost: { input: 0, output: 0 },
            },
          },
        },
      ])
    );
    flushSolid();
    setState(storePath('providerDefaults', { openai: 'gpt-5' }));
    flushSolid();
    setState(storePath('providersLoaded', true));
    flushSolid();
    setState(storePath('providerLimits', { 'openai:session': null }));
    flushSolid();
    setState(storePath('mcpStatus', { docs: { status: 'connected' } }));
    flushSolid();
    setInputText('old draft');
    flushSolid();
    startEditingMessage('message-old', oldSession.id, 'old message');
    flushSolid();
    setSessionHistoryCursor(oldSession.id, 'cursor-old');
    flushSolid();
    setShowSessionPicker(true);
    flushSolid();

    // The host publishes the new workspace context before resetting its catalogs.
    setState(storePath('editorContext', 'workspacePath', '/repo-next'));
    flushSolid();
    resetWorkspaceDerivedState();
    flushSolid();

    expect(state.editorContext.workspacePath).toBe('/repo-next');
    expect(state.sessions).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    expect(state.sessionStatus).toEqual({ 'session-old': { type: 'busy' } });
    expect(state.permissions).toEqual([]);
    expect(state.questions).toEqual([]);
    expect(state.providersLoaded).toBe(false);
    expect(state.workspaceCatalogReloadPending).toBe(true);
    expect(state.agentsLoaded).toBe(false);
    expect(state.commandsLoaded).toBe(false);
    expect(state.agents).toEqual([
      {
        name: 'build',
        description: 'Build agent',
        mode: 'primary',
        builtIn: true,
        permission: [],
        tools: {},
      },
    ]);
    expect(state.providers).toEqual([
      {
        id: 'openai',
        name: 'OpenAI',
        source: 'api',
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
          },
        },
      },
    ]);
    expect(state.providerDefaults).toEqual({ openai: 'gpt-5' });
    expect(state.providerLimits).toEqual({ 'openai:session': null });
    expect(state.mcpStatus).toEqual({ docs: { status: 'connected' } });
    expect(showSessionPicker()).toBe(true);
    expect(inputText()).toBe('');
    expect(editingMessage()).toBeNull();
    expect(getSessionHistoryCursor(oldSession.id)).toBeUndefined();
    expect(isSessionHistoryTruncated(oldSession.id)).toBe(false);

    // The fresh draft re-defaults to the primary agent once agents reload, without
    // overwriting the persisted toolbar choice.
    expect(state.selectedAgent).toBeNull();
    expect(getPersistedSelectedAgent()).toBe('global-agent');
    expect(state.selectedModel).toEqual(globalModel);
    expect(state.sessionSelectedAgents[oldSession.id]).toBe('session-agent');
    expect(state.sessionSelectedModels[oldSession.id]).toEqual(sessionModel);
    expect(state.sessionPermissionModes[oldSession.id]).toBe('full');
    expect(state.currentDocumentEnabledBySession[oldSession.id]).toBe(false);
    expect(state.queuedMessages).toEqual([
      { id: 'queued-old', sessionId: oldSession.id, text: 'preserve me' },
    ]);
    expect(state.queuedMessageDispatchingId).toBeNull();
    expect(state.failedQueuedMessageIds).toEqual(['queued-old']);
    expect(state.queuedMessageEdit).toBeNull();
    expect(state.lastSeenSessions[oldSession.id]).toBe(10);
    expect(state.hiddenProviders).toEqual(['hidden-provider']);
    setShowSessionPicker(false);
    setState(storePath('activeSessionId', oldSession.id));
    flushSolid();
    expect(inputText()).toBe('');
    setState(storePath('editorContext', 'workspacePath', oldSession.directory));
    flushSolid();
    expect(inputText()).toBe('old draft');
  });
});
