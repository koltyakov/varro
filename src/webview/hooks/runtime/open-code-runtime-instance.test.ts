import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
  beforeEach(() => {
    resetDefaultAppState();
  });

  it('retains the original request timestamp for cached status snapshots', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const pendingStatuses = deferred<Record<string, SessionStatus>>();
    const loadSessionStatuses = vi.fn(() => pendingStatuses.promise);
    const snapshots = createSessionStatusSnapshotCoordinator(loadSessionStatuses);

    try {
      const firstLoad = snapshots.load();
      await Promise.resolve();
      expect(loadSessionStatuses).toHaveBeenCalledTimes(1);

      vi.setSystemTime(2_000);
      sessionStore.setSessionStatusEntry('session-1', { type: 'busy' });
      pendingStatuses.resolve({ 'session-1': { type: 'idle' } });
      const firstSnapshot = await firstLoad;

      vi.setSystemTime(2_050);
      const cachedSnapshot = await snapshots.load();

      expect(cachedSnapshot).toBe(firstSnapshot);
      expect(cachedSnapshot.startedAt).toBe(1_000);
      expect(loadSessionStatuses).toHaveBeenCalledTimes(1);

      sessionStore.setSessionStatuses(cachedSnapshot.statuses, {
        snapshotStartedAt: cachedSnapshot.startedAt,
      });
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
    const syncB = sync('session-b', sessionB.promise);

    sessionB.resolve();
    await expect(syncB).resolves.toBe(true);
    sessionA.resolve();
    await expect(syncA).resolves.toBe(true);

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
    const syncB = sync('b', responseB.promise);
    responseB.resolve();
    await expect(syncB).resolves.toBe(true);
    responseA.resolve();
    await expect(syncA).resolves.toBe(false);

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

    generations.clear();
    response.resolve();

    await expect(sync).resolves.toBe(false);
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
    await Promise.resolve();
    operations.invalidate();
    connection.resolve();
    await reconciliation;

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
    setState('editorContext', {
      workspacePath: '/repo-next',
      activeFile: null,
      selection: null,
      diagnostics: [],
    });
    setSelectedAgent('global-agent');
    setSelectedModel(globalModel);
    setSelectedAgent('session-agent', { sessionId: oldSession.id, persistGlobal: false });
    setSelectedModel(sessionModel, { sessionId: oldSession.id, persistGlobal: false });
    setState('sessions', [oldSession]);
    setState('activeSessionId', oldSession.id);
    setState('sessionStatus', oldSession.id, { type: 'busy' });
    setState('permissions', [
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
    ]);
    setState('questions', [{ id: 'question-old', sessionID: oldSession.id, questions: [] }]);
    setState('sessionPermissionModes', oldSession.id, 'full');
    setState('currentDocumentEnabledBySession', oldSession.id, false);
    setState('queuedMessages', [
      { id: 'queued-old', sessionId: oldSession.id, text: 'preserve me' },
    ]);
    setState('queuedMessageDispatchingId', 'queued-old');
    setState('failedQueuedMessageIds', ['queued-old']);
    setState('queuedMessageEdit', { id: 'queued-old', sessionId: oldSession.id });
    setState('lastSeenSessions', oldSession.id, 10);
    setState('hiddenProviders', ['hidden-provider']);
    setState('agents', [
      {
        name: 'build',
        description: 'Build agent',
        mode: 'primary',
        builtIn: true,
        permission: [],
        tools: {},
      },
    ]);
    setState('providers', [
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
    setState('providerDefaults', { openai: 'gpt-5' });
    setState('providersLoaded', true);
    setState('providerLimits', { 'openai:session': null });
    setState('mcpStatus', { docs: { status: 'connected' } });
    setInputText('old draft');
    startEditingMessage('message-old', oldSession.id, 'old message');
    setSessionHistoryCursor(oldSession.id, 'cursor-old');
    setShowSessionPicker(true);

    resetWorkspaceDerivedState();

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
    expect(inputText()).toBe('old draft');
    expect(editingMessage()).toBeNull();
    expect(getSessionHistoryCursor(oldSession.id)).toBeUndefined();
    expect(isSessionHistoryTruncated(oldSession.id)).toBe(false);

    expect(state.selectedAgent).toBe('global-agent');
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
  });
});
