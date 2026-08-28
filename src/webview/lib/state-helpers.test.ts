import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebviewMessage } from '../../shared/protocol';
import type { AssistantMessage, Part, Provider, UserMessage } from '../types';

type TestBridgeWindow = Window & {
  __sendToExtension?: (message: WebviewMessage) => void;
};

function getTestBridgeWindow() {
  // SAFETY: The test installs only the optional bridge callback declared by TestBridgeWindow.
  return window as TestBridgeWindow;
}

function assistantMessage(
  id: string,
  sessionID = 'session-1',
  created = 0,
  mode = 'default',
  parentID = 'user-1'
): AssistantMessage {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created },
    parentID,
    modelID: 'model-1',
    providerID: 'provider-1',
    mode,
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function userMessage(id: string, sessionID = 'session-1', created = 0): UserMessage {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created },
    agent: 'build',
    model: { providerID: 'provider-1', modelID: 'model-1' },
  };
}

function provider(id: string, modelIds: string[]): Provider {
  return {
    id,
    name: id,
    source: 'api',
    models: Object.fromEntries(
      modelIds.map((modelID) => [
        modelID,
        {
          id: modelID,
          name: modelID,
          capabilities: { toolcall: true },
          cost: { input: 0, output: 0 },
          variants: modelID === 'gpt-4.1' ? { high: { effort: 'high' } } : undefined,
        },
      ])
    ),
  };
}

async function loadState() {
  return import('./state');
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

beforeEach(() => {
  vi.resetModules();
});

describe('state helpers', () => {
  it('manages queued messages and loading timestamps', async () => {
    const stateModule = await loadState();

    stateModule.enqueueMessage({ id: 'q1', sessionId: 'session-1', text: 'first' });
    stateModule.enqueueMessage({ id: 'q2', sessionId: 'session-2', text: 'second' });
    stateModule.removeQueuedMessage('missing');

    expect(stateModule.state.queuedMessages.map((item) => item.id)).toEqual(['q1', 'q2']);

    stateModule.removeQueuedMessage('q1');
    expect(stateModule.state.queuedMessages.map((item) => item.id)).toEqual(['q2']);

    stateModule.clearQueuedMessagesForSession('session-2');
    expect(stateModule.state.queuedMessages).toEqual([]);

    stateModule.startLoading(100);
    stateModule.markLoadingActivity(150);
    stateModule.startLoading(200);

    expect(stateModule.isLoading()).toBe(true);
    expect(stateModule.loadingStartedAt()).toBe(100);
    expect(stateModule.loadingLastActivityAt()).toBe(200);

    stateModule.stopLoading();

    expect(stateModule.isLoading()).toBe(false);
    expect(stateModule.loadingStartedAt()).toBeNull();
    expect(stateModule.loadingLastActivityAt()).toBeNull();
  });

  it('replaces queued messages without changing their position', async () => {
    const stateModule = await loadState();

    stateModule.enqueueMessage({ id: 'q1', sessionId: 'session-1', text: 'first' });
    stateModule.enqueueMessage({ id: 'other', sessionId: 'session-2', text: 'other' });
    stateModule.enqueueMessage({ id: 'q2', sessionId: 'session-1', text: 'second' });

    expect(
      stateModule.replaceQueuedMessage('q2', {
        id: 'q2-edited',
        sessionId: 'session-1',
        text: 'second edited',
      })
    ).toBe(true);

    expect(stateModule.state.queuedMessages.map((item) => item.id)).toEqual([
      'q1',
      'other',
      'q2-edited',
    ]);
    expect(stateModule.replaceQueuedMessage('missing', stateModule.state.queuedMessages[0]!)).toBe(
      false
    );
  });

  it('pauses queued messages individually or across one session', async () => {
    const stateModule = await loadState();

    stateModule.enqueueMessage({ id: 'q1', sessionId: 'session-1', text: 'first' });
    stateModule.enqueueMessage({ id: 'other', sessionId: 'session-2', text: 'other' });
    stateModule.enqueueMessage({ id: 'q2', sessionId: 'session-1', text: 'second' });

    stateModule.setQueuedMessagePaused('q1', true);
    expect(stateModule.state.queuedMessages.map((item) => item.paused)).toEqual([
      true,
      undefined,
      undefined,
    ]);

    stateModule.setQueuedMessagePaused('q2', true, true);
    expect(stateModule.state.queuedMessages.map((item) => item.paused)).toEqual([
      true,
      undefined,
      true,
    ]);
    expect(JSON.parse(window.localStorage.getItem('varro.queuedMessages') || '[]')).toMatchObject([
      { id: 'q1', paused: true },
      { id: 'other' },
      { id: 'q2', paused: true },
    ]);

    stateModule.setQueuedMessagePaused('q1', false, true);
    expect(stateModule.state.queuedMessages.map((item) => item.paused)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('persists queued messages and restores their session-aware order', async () => {
    let stateModule = await loadState();

    stateModule.enqueueMessage({
      id: 'q1',
      sessionId: 'session-1',
      text: 'first',
      droppedFiles: [
        {
          path: '/repo/src/a.ts',
          relativePath: 'src/a.ts',
          type: 'file',
          attachmentSequence: 2,
          lineRanges: [{ startLine: 2, endLine: 4 }],
        },
      ],
      clipboardImages: [
        {
          id: 'img-1',
          url: 'data:image/png;base64,AA==',
          mime: 'image/png',
          filename: 'img.png',
          size: 1,
          contentKey: 'image-content',
          attachmentSequence: 3,
        },
      ],
      terminalSelection: { text: 'npm test', terminalName: 'zsh' },
    });
    stateModule.enqueueMessage({ id: 'other', sessionId: 'session-2', text: 'other' });
    stateModule.enqueueMessage({
      id: 'q2',
      sessionId: 'session-1',
      text: 'second',
      agent: 'build',
    });

    stateModule.reorderQueuedMessage('q2', 'q1');
    stateModule.reorderQueuedMessage('q2', 'other');

    expect(stateModule.state.queuedMessages.map((item) => item.id)).toEqual(['q2', 'other', 'q1']);
    expect(
      JSON.parse(window.localStorage.getItem('varro.queuedMessages') || '[]').map(
        (item: { id: string }) => item.id
      )
    ).toEqual(['q2', 'other']);

    vi.resetModules();
    stateModule = await loadState();

    expect(stateModule.state.queuedMessages.map((item) => item.id)).toEqual(['q2', 'other']);
    expect(stateModule.state.queuedMessages[0]?.agent).toBe('build');

    stateModule.removeQueuedMessage('q2');
    stateModule.clearQueuedMessagesForSession('session-1');
    expect(stateModule.state.queuedMessages.map((item) => item.id)).toEqual(['other']);
    expect(JSON.parse(window.localStorage.getItem('varro.queuedMessages') || '[]')).toEqual([
      {
        id: 'other',
        sessionId: 'session-2',
        text: 'other',
        droppedFiles: [],
        clipboardImages: [],
        terminalSelection: null,
      },
    ]);
  });

  it('restores the host queue ahead of the legacy browser mirror', async () => {
    window.localStorage.setItem(
      'varro.queuedMessages',
      JSON.stringify([{ id: 'legacy', sessionId: 'session-1', text: 'legacy' }])
    );
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      queuedMessages: [
        {
          id: 'host',
          messageId: 'msg_host',
          sessionId: 'session-1',
          text: 'host snapshot',
          agent: 'plan',
          paused: true,
          droppedFiles: [],
          clipboardImages: [
            {
              id: 'image-1',
              url: 'data:image/png;base64,AA==',
              mime: 'image/png',
              filename: 'image.png',
              size: 1,
            },
          ],
          terminalSelection: null,
          queuedContext: {
            currentDocumentEnabled: true,
            editorContext: {
              workspacePath: '/repo',
              workspaceFolders: [{ name: 'repo', path: '/repo' }],
              activeFile: {
                path: '/repo/src/app.ts',
                relativePath: 'src/app.ts',
                language: 'typescript',
              },
              selection: { startLine: 2, endLine: 3 },
              editorText: {
                kind: 'selection',
                path: '/repo/src/app.ts',
                relativePath: 'src/app.ts',
                language: 'typescript',
                range: { startLine: 2, endLine: 3 },
                text: 'const value = 1;',
                truncated: false,
              },
              diagnostics: [
                {
                  path: '/repo/src/app.ts',
                  severity: 'warning',
                  message: 'Review value',
                  line: 2,
                },
              ],
              diagnosticsTotal: 1,
            },
          },
        },
      ],
    };

    try {
      const stateModule = await loadState();

      expect(stateModule.state.queuedMessages.map((message) => message.id)).toEqual(['host']);
      expect(stateModule.state.queuedMessages[0]?.messageId).toBe('msg_host');
      expect(stateModule.state.queuedMessages[0]?.paused).toBe(true);
      expect(stateModule.state.queuedMessages[0]?.agent).toBe('plan');
      expect(stateModule.state.queuedMessages[0]?.clipboardImages).toEqual([
        {
          id: 'image-1',
          url: 'data:image/png;base64,AA==',
          mime: 'image/png',
          filename: 'image.png',
          size: 1,
        },
      ]);
      expect(stateModule.state.queuedMessages[0]?.queuedContext).toEqual({
        currentDocumentEnabled: true,
        editorContext: {
          workspacePath: '/repo',
          workspaceFolders: [{ name: 'repo', path: '/repo' }],
          activeFile: {
            path: '/repo/src/app.ts',
            relativePath: 'src/app.ts',
            language: 'typescript',
          },
          selection: { startLine: 2, endLine: 3 },
          editorText: {
            kind: 'selection',
            path: '/repo/src/app.ts',
            relativePath: 'src/app.ts',
            language: 'typescript',
            range: { startLine: 2, endLine: 3 },
            text: 'const value = 1;',
            truncated: false,
          },
          diagnostics: [
            {
              path: '/repo/src/app.ts',
              severity: 'warning',
              message: 'Review value',
              line: 2,
            },
          ],
          diagnosticsTotal: 1,
        },
      });
      expect(JSON.parse(window.localStorage.getItem('varro.queuedMessages') || '[]')).toEqual([]);
    } finally {
      // SAFETY: The fixture provides the unknown fields read by this statement.
      delete (window as { __initialWebviewState?: unknown }).__initialWebviewState;
    }
  });

  it('keeps queued images live without serializing them', async () => {
    const stateModule = await loadState();
    const imageMessage = {
      id: 'image-message',
      sessionId: 'session-1',
      text: 'inspect image',
      clipboardImages: [
        {
          id: 'img-1',
          url: 'data:image/png;base64,AA==',
          mime: 'image/png',
          filename: 'img.png',
          size: 1,
          contentKey: 'data:image/png;base64,AA==',
        },
      ],
    };

    stateModule.enqueueMessage(imageMessage);

    expect(stateModule.state.queuedMessages).toEqual([imageMessage]);
    expect(window.localStorage.getItem('varro.queuedMessages')).not.toContain('base64');

    expect(
      stateModule.replaceQueuedMessage('image-message', {
        id: 'image-message',
        sessionId: 'session-1',
        text: 'inspect image later',
      })
    ).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('varro.queuedMessages') || '[]')).toEqual([
      { id: 'image-message', sessionId: 'session-1', text: 'inspect image later' },
    ]);

    expect(stateModule.replaceQueuedMessage('image-message', imageMessage)).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('varro.queuedMessages') || '[]')).toEqual([]);
  });

  it('discards malformed persisted queued messages', async () => {
    window.localStorage.setItem(
      'varro.queuedMessages',
      JSON.stringify([
        {
          id: 'legacy-image',
          sessionId: 'session-1',
          text: 'drop atomically',
          clipboardImages: [
            {
              id: 'img-1',
              url: 'data:image/png;base64,AA==',
              mime: 'image/png',
              filename: 'img.png',
              size: 1,
            },
          ],
        },
        {
          id: 'valid',
          sessionId: 'session-1',
          text: 'keep',
          droppedFiles: [
            { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
            { path: '/repo/b.ts', relativePath: 'b.ts', type: 'other' },
          ],
          queuedContext: { currentDocumentEnabled: 'yes', editorContext: {} },
        },
        { id: 'valid', sessionId: 'session-1', text: 'duplicate' },
        { id: '', sessionId: 'session-1', text: 'missing id' },
        { id: 'empty', sessionId: 'session-1', text: '' },
      ])
    );

    const stateModule = await loadState();

    expect(stateModule.state.queuedMessages).toEqual([
      {
        id: 'legacy-image',
        sessionId: 'session-1',
        text: 'drop atomically',
        droppedFiles: [],
        clipboardImages: [
          {
            id: 'img-1',
            url: 'data:image/png;base64,AA==',
            mime: 'image/png',
            filename: 'img.png',
            size: 1,
          },
        ],
        terminalSelection: null,
      },
      {
        id: 'valid',
        sessionId: 'session-1',
        text: 'keep',
        droppedFiles: [{ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' }],
        clipboardImages: [],
        terminalSelection: null,
      },
    ]);
    expect(window.localStorage.getItem('varro.queuedMessages')).not.toContain('base64');
  });

  it('persists active session state and unread markers', async () => {
    const stateModule = await loadState();
    const sent: unknown[] = [];
    const bridgeWindow = getTestBridgeWindow();
    bridgeWindow.__sendToExtension = (message) => sent.push(message);
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    stateModule.persistActiveSessionId('session-1');
    expect(stateModule.getPersistedActiveSessionId()).toBe('session-1');

    stateModule.persistLastOpenedView({ type: 'session', sessionId: 'session-1' });
    expect(stateModule.getPersistedLastOpenedView()).toEqual({
      type: 'session',
      sessionId: 'session-1',
      timestamp: 1_000,
    });

    stateModule.markSessionSeen('session-1');
    stateModule.markSessionSeen('session-2');
    stateModule.setState('activeSessionId', 'session-1');

    expect(stateModule.state.lastSeenSessions).toEqual({ 'session-1': 1_000, 'session-2': 1_000 });
    expect(sent).toEqual([
      { type: 'session/seen', payload: { sessionId: 'session-1' } },
      { type: 'session/seen', payload: { sessionId: 'session-2' } },
    ]);
    expect(stateModule.isSessionUnread('session-1', 1_000)).toBe(false);
    expect(stateModule.isSessionUnread('session-1', 1_001)).toBe(true);
    expect(stateModule.isSessionUnread('session-2', 999)).toBe(false);
    expect(stateModule.isSessionUnread('session-2', 1_001)).toBe(true);

    stateModule.markSessionSeen('session-1', 1_500);
    expect(stateModule.state.lastSeenSessions['session-1']).toBe(1_500);
    expect(stateModule.isSessionUnread('session-1', 1_500)).toBe(false);
    expect(window.localStorage.getItem('varro.lastSeenSessions')).toBe(
      JSON.stringify({
        '__varro.no-workspace__': { 'session-1': 1_500, 'session-2': 1_000 },
      })
    );
    delete bridgeWindow.__sendToExtension;

    stateModule.setSessionCompacting('session-4', true);
    expect(stateModule.state.compactingSessionIds).toEqual(['session-4']);

    stateModule.setSessionCompacting('session-4', false);
    expect(stateModule.state.compactingSessionIds).toEqual([]);
  });

  it('persists skipped plan sessions by session update time', async () => {
    const stateModule = await loadState();
    const sent: unknown[] = [];
    const bridgeWindow = getTestBridgeWindow();
    bridgeWindow.__sendToExtension = (message) => sent.push(message);

    stateModule.setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'session-1',
        version: '1',
        time: { created: 100, updated: 200 },
      },
    ]);

    stateModule.skipPlanSession('session-1');

    expect(stateModule.state.skippedPlanSessions).toEqual({ 'session-1': 200 });
    expect(stateModule.isSkippedPlanSession('session-1', 200)).toBe(true);
    expect(stateModule.isSkippedPlanSession('session-1', 201)).toBe(false);
    expect(window.localStorage.getItem('varro.skippedPlanSessions')).toBe(
      JSON.stringify({ '/repo': { 'session-1': 200 } })
    );
    expect(sent).toContainEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', skippedAt: 200 },
    });

    stateModule.clearSkippedPlanSession('session-1');

    expect(stateModule.state.skippedPlanSessions).toEqual({});
    expect(window.localStorage.getItem('varro.skippedPlanSessions')).toBe(JSON.stringify({}));
    expect(sent).toContainEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', skippedAt: null },
    });
    delete bridgeWindow.__sendToExtension;

    stateModule.setState('lastSeenSessions', { 'session-1': 100, 'session-2': 200 });
    stateModule.clearSessionSeen('session-1');
    expect(stateModule.state.lastSeenSessions).toEqual({ 'session-2': 200 });
    expect(window.localStorage.getItem('varro.lastSeenSessions')).toBe(JSON.stringify({}));
  });

  it('prunes stale skipped session markers when sessions refresh', async () => {
    const stateModule = await loadState();

    stateModule.setState('skippedPlanSessions', { stale: 3, 'session-1': 4 });

    stateModule.setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'session-1',
        version: '1',
        time: { created: 100, updated: 200 },
      },
    ]);

    expect(stateModule.state.skippedPlanSessions).toEqual({ 'session-1': 4 });
  });

  it('keeps session markers scoped per workspace', async () => {
    const stateModule = await loadState();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    stateModule.syncSessionMarkersForWorkspace('/repo-a');
    stateModule.setSessions([
      {
        id: 'session-a',
        projectID: 'project-a',
        directory: '/repo-a',
        title: 'session-a',
        version: '1',
        time: { created: 100, updated: 200 },
      },
    ]);
    stateModule.markSessionSeen('session-a');
    stateModule.skipPlanSession('session-a');

    expect(stateModule.state.lastSeenSessions).toEqual({ 'session-a': 1_000 });
    expect(stateModule.state.skippedPlanSessions).toEqual({ 'session-a': 200 });

    stateModule.syncSessionMarkersForWorkspace('/repo-b');
    stateModule.setSessions([
      {
        id: 'session-b',
        projectID: 'project-b',
        directory: '/repo-b',
        title: 'session-b',
        version: '1',
        time: { created: 300, updated: 400 },
      },
    ]);

    expect(stateModule.state.lastSeenSessions).toEqual({});
    expect(stateModule.state.skippedPlanSessions).toEqual({});

    stateModule.markSessionSeen('session-b', 2_000);
    stateModule.skipPlanSession('session-b');

    expect(JSON.parse(window.localStorage.getItem('varro.lastSeenSessions') || '{}')).toEqual({
      '/repo-a': { 'session-a': 1_000 },
      '/repo-b': { 'session-b': 2_000 },
    });
    expect(JSON.parse(window.localStorage.getItem('varro.skippedPlanSessions') || '{}')).toEqual({
      '/repo-a': { 'session-a': 200 },
      '/repo-b': { 'session-b': 400 },
    });

    stateModule.syncSessionMarkersForWorkspace('/repo-a');
    expect(stateModule.state.lastSeenSessions).toEqual({ 'session-a': 1_000 });
    expect(stateModule.state.skippedPlanSessions).toEqual({ 'session-a': 200 });
  });

  it('migrates legacy flat session marker storage into the current workspace scope', async () => {
    window.localStorage.setItem('varro.lastSeenSessions', JSON.stringify({ legacy: 123 }));
    window.localStorage.setItem('varro.skippedPlanSessions', JSON.stringify({ legacy: 456 }));
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };

    const stateModule = await loadState();

    expect(stateModule.state.lastSeenSessions).toEqual({ legacy: 123 });
    expect(stateModule.state.skippedPlanSessions).toEqual({ legacy: 456 });
    expect(JSON.parse(window.localStorage.getItem('varro.lastSeenSessions') || '{}')).toEqual({
      '/repo': { legacy: 123 },
    });
    expect(JSON.parse(window.localStorage.getItem('varro.skippedPlanSessions') || '{}')).toEqual({
      '/repo': { legacy: 456 },
    });
  });

  it('tracks draft and per-session permission modes by workspace', async () => {
    const stateModule = await loadState();

    stateModule.syncDraftPermissionForWorkspace('/repo');
    expect(stateModule.draftPermissionMode()).toBe('default');

    stateModule.setPermissionModeForSession(null, 'full');
    expect(stateModule.getPermissionModeForSession(null)).toBe('full');
    expect(window.localStorage.getItem('varro.draftPermissionMode')).toBe(JSON.stringify('full'));
    expect(JSON.parse(window.localStorage.getItem('varro.projectPermissionModes') || '{}')).toEqual(
      {
        '/repo': 'full',
      }
    );

    stateModule.setPermissionModeForSession('session-1', 'full');
    expect(stateModule.getPermissionModeForSession('session-1')).toBe('full');

    stateModule.removePermissionModeForSession('session-1');
    expect(stateModule.state.sessionPermissionModes).toEqual({});
    expect(window.localStorage.getItem('varro.sessionPermissionModes')).toBe(JSON.stringify({}));

    stateModule.syncDraftPermissionForWorkspace('/other');
    expect(stateModule.draftPermissionMode()).toBe('default');

    stateModule.syncDraftPermissionForWorkspace('/repo');
    stateModule.resetDraftPermissionMode();
    expect(stateModule.draftPermissionMode()).toBe('full');
    expect(window.localStorage.getItem('varro.draftPermissionMode')).toBeNull();
  });

  it('uses configured default permission mode only without a persisted selection', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      defaultPermissionMode: 'full',
    };

    const stateModule = await loadState();

    expect(stateModule.draftPermissionMode()).toBe('full');

    stateModule.setPermissionModeForSession(null, 'default');
    expect(stateModule.draftPermissionMode()).toBe('default');
    expect(window.localStorage.getItem('varro.draftPermissionMode')).toBe(
      JSON.stringify('default')
    );

    stateModule.setDefaultPermissionModePreference('full');

    expect(stateModule.draftPermissionMode()).toBe('default');
  });

  it('preserves a pending permission mode over an older host snapshot', async () => {
    const stateModule = await loadState();

    stateModule.setPermissionModeForSession('session-1', 'full');
    stateModule.setPendingSessionPermissionMode('session-1', 'full');
    stateModule.applySessionPermissionModesSnapshot({ 'session-1': 'auto' });

    expect(stateModule.getPermissionModeForSession('session-1')).toBe('full');

    stateModule.setPendingSessionPermissionMode('session-1', null);
    stateModule.applySessionPermissionModesSnapshot({ 'session-1': 'auto' });

    expect(stateModule.getPermissionModeForSession('session-1')).toBe('auto');
  });

  it('treats a pending ancestor permission mode as pending for descendants', async () => {
    const stateModule = await loadState();
    stateModule.setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Parent',
        version: '1',
        time: { created: 0, updated: 0 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/repo',
        parentID: 'session-1',
        title: 'Child',
        version: '1',
        time: { created: 0, updated: 0 },
      },
    ]);

    stateModule.setPendingSessionPermissionMode('session-1', 'full');

    expect(stateModule.isSessionPermissionModePending('session-1')).toBe(true);
    expect(stateModule.isSessionPermissionModePending('child-1')).toBe(true);
    expect(stateModule.isSessionPermissionModePending('session-2')).toBe(false);
  });

  it('inherits a parent session permission mode for child sessions', async () => {
    const stateModule = await loadState();

    stateModule.setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Parent',
        version: '1',
        time: { created: 0, updated: 0 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/repo',
        parentID: 'session-1',
        title: 'Child',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);

    stateModule.setPermissionModeForSession('session-1', 'full');

    expect(stateModule.getPermissionModeForSession('child-1')).toBe('full');
  });

  it('prefers an explicit child permission mode over the parent mode', async () => {
    const stateModule = await loadState();

    stateModule.setSessions([
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/repo',
        title: 'Parent',
        version: '1',
        time: { created: 0, updated: 0 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/repo',
        parentID: 'session-1',
        title: 'Child',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);

    stateModule.setPermissionModeForSession('session-1', 'full');
    stateModule.setPermissionModeForSession('child-1', 'default');

    expect(stateModule.getPermissionModeForSession('child-1')).toBe('default');
  });

  it('falls back to default when session ancestry is cyclic', async () => {
    const stateModule = await loadState();

    stateModule.setSessions([
      {
        id: 'session-a',
        projectID: 'project-1',
        directory: '/repo',
        parentID: 'session-b',
        title: 'Session A',
        version: '1',
        time: { created: 0, updated: 0 },
      },
      {
        id: 'session-b',
        projectID: 'project-1',
        directory: '/repo',
        parentID: 'session-a',
        title: 'Session B',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);

    expect(stateModule.getPermissionModeForSession('session-a')).toBe('default');
    expect(stateModule.getPermissionModeForSession('session-b')).toBe('default');
  });

  it('persists current document auto-context by project', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      editorContext: {
        workspacePath: '/repo/',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
    };
    let stateModule = await loadState();

    stateModule.setState('activeSessionId', null);
    stateModule.rememberCurrentDocumentNavigation(null, '/repo/a.ts');
    expect(stateModule.getCurrentDocumentEnabled()).toBe(true);

    stateModule.toggleCurrentDocumentEnabled();
    expect(stateModule.getCurrentDocumentEnabled()).toBe(false);
    expect(
      JSON.parse(window.localStorage.getItem('varro.projectCurrentDocumentEnabled') || '{}')
    ).toEqual({ '/repo': false });

    stateModule.rememberCurrentDocumentNavigation('/repo/a.ts', '/repo/b.ts');
    expect(stateModule.getCurrentDocumentEnabled()).toBe(false);

    stateModule.adoptDraftCurrentDocumentState('session-1');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(false);
    expect(stateModule.getCurrentDocumentEnabled()).toBe(false);

    stateModule.setCurrentDocumentEnabled(true, 'session-1');
    stateModule.rememberCurrentDocumentNavigation('/repo/a.ts', '/repo/b.ts', 'session-1');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(true);
    expect(stateModule.getCurrentDocumentEnabled()).toBe(true);

    stateModule.setCurrentDocumentEnabled(false, 'session-1');
    stateModule.rememberCurrentDocumentNavigation('/repo/b.ts', '/repo/c.ts', 'session-1');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(false);

    stateModule.clearCurrentDocumentStateForSession('session-1');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(false);

    stateModule.syncCurrentDocumentForWorkspace('/other');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(true);

    stateModule.syncCurrentDocumentForWorkspace('/repo');
    expect(stateModule.getCurrentDocumentEnabled()).toBe(false);

    vi.resetModules();
    stateModule = await loadState();
    expect(stateModule.getCurrentDocumentEnabled()).toBe(false);

    stateModule.toggleCurrentDocumentEnabled();
    vi.resetModules();
    stateModule = await loadState();
    expect(stateModule.getCurrentDocumentEnabled()).toBe(true);
  });

  it('deduplicates context files and manages clipboard image placeholders', async () => {
    window.localStorage.clear();
    let stateModule = await loadState();

    stateModule.addContextFile({ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' });
    stateModule.addContextFile({ path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' });
    stateModule.addContextFile({
      path: '/repo/a.ts',
      relativePath: 'a.ts',
      type: 'file',
      lineRanges: [{ startLine: 2, endLine: 4 }],
    });
    stateModule.addContextFile({
      path: '/repo/a.ts',
      relativePath: 'a.ts',
      type: 'file',
      lineRanges: [{ startLine: 8, endLine: 9 }],
    });
    stateModule.addContextFile({ path: '/repo/b.ts', relativePath: 'b.ts', type: 'file' });
    expect(stateModule.state.droppedFiles.map((file) => file.relativePath)).toEqual([
      'a.ts',
      'b.ts',
    ]);
    expect(stateModule.state.droppedFiles[0]?.lineRanges).toBeUndefined();

    stateModule.clearContextFiles();
    stateModule.addContextFile({
      path: '/repo/a.ts',
      relativePath: 'a.ts',
      type: 'file',
      lineRanges: [{ startLine: 2, endLine: 4 }],
    });
    stateModule.addContextFile({
      path: '/repo/a.ts',
      relativePath: 'a.ts',
      type: 'file',
      lineRanges: [{ startLine: 8, endLine: 9 }],
    });
    expect(stateModule.state.droppedFiles).toEqual([
      expect.objectContaining({
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        attachmentSequence: expect.any(Number),
        lineRanges: [
          { startLine: 2, endLine: 4 },
          { startLine: 8, endLine: 9 },
        ],
      }),
    ]);

    stateModule.removeContextFile('/repo/a.ts');
    expect(stateModule.state.droppedFiles).toEqual([]);

    stateModule.addContextFile({ path: '/repo/b.ts', relativePath: 'b.ts', type: 'file' });
    expect(stateModule.state.droppedFiles.map((file) => file.relativePath)).toEqual(['b.ts']);

    stateModule.clearContextFiles();
    stateModule.addContextFiles([
      { path: 'C:\\Repo\\File.ts', relativePath: 'File.ts', type: 'file' },
      {
        path: 'c:/repo/file.ts',
        relativePath: 'File.ts',
        type: 'file',
        lineRanges: [{ startLine: 2, endLine: 4 }],
      },
    ]);
    expect(stateModule.state.droppedFiles).toEqual([
      expect.objectContaining({
        path: 'c:/repo/file.ts',
        lineRanges: undefined,
      }),
    ]);
    stateModule.removeContextFile('C:/REPO/FILE.ts');
    expect(stateModule.state.droppedFiles).toEqual([]);

    stateModule.clearContextFiles();
    stateModule.addContextFiles([
      { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
      {
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [{ startLine: 2, endLine: 4 }],
      },
    ]);
    expect(stateModule.state.droppedFiles).toEqual([
      expect.objectContaining({
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        attachmentSequence: expect.any(Number),
      }),
    ]);

    vi.resetModules();
    stateModule = await loadState();
    expect(stateModule.state.droppedFiles).toEqual([
      expect.objectContaining({
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        attachmentSequence: expect.any(Number),
      }),
    ]);

    stateModule.clearContextFiles();
    expect(stateModule.state.droppedFiles).toEqual([]);
    expect(window.localStorage.getItem('varro.inputDraftFiles')).toBeNull();

    stateModule.setInputText('See [img-2.png] later');
    for (let i = 1; i <= stateModule.MAX_CLIPBOARD_IMAGES + 1; i++) {
      stateModule.addClipboardImage({
        id: `img-${i}`,
        url: `blob:${i}`,
        mime: 'image/png',
        filename: `img-${i}.png`,
        size: 10,
      });
    }
    stateModule.addClipboardImage({
      id: 'too-big',
      url: 'blob:big',
      mime: 'image/png',
      filename: 'too-big.png',
      size: 6 * 1024 * 1024,
    });

    expect(stateModule.state.clipboardImages.map((image) => image.id)).toEqual(
      Array.from({ length: stateModule.MAX_CLIPBOARD_IMAGES }, (_, index) => `img-${index + 2}`)
    );

    stateModule.removeClipboardImage('img-2');
    expect(stateModule.inputText()).toBe('See _____ later');

    stateModule.setInputText('   ');
    stateModule.setNextPastedImageIndex(4);
    stateModule.clearClipboardImages();

    expect(stateModule.state.clipboardImages).toEqual([]);
    expect(stateModule.nextPastedImageIndex()).toBe(1);
  });

  it('caps clipboard images when a draft is restored over the limit', async () => {
    const stateModule = await loadState();

    const restored = Array.from({ length: stateModule.MAX_CLIPBOARD_IMAGES + 3 }, (_, index) => ({
      id: `restored-${index + 1}`,
      url: `blob:restored-${index + 1}`,
      mime: 'image/png',
      filename: `restored-${index + 1}.png`,
      size: 10,
    }));

    const dropped = stateModule.replaceClipboardImages(restored);

    expect(dropped.map((image) => image.id)).toEqual(['restored-1', 'restored-2', 'restored-3']);
    expect(stateModule.state.clipboardImages).toHaveLength(stateModule.MAX_CLIPBOARD_IMAGES);
    // Keeps the most recent entries rather than truncating to the oldest.
    expect(stateModule.state.clipboardImages.at(-1)?.id).toBe(
      `restored-${stateModule.MAX_CLIPBOARD_IMAGES + 3}`
    );

    // Markers for the images the cap discarded are blanked, not left dangling.
    const restoredText = restored.map((image) => `[${image.filename}]`).join(' ');
    const reconciled = stateModule.stripClipboardImagePlaceholders(
      restoredText,
      restored.slice(0, 3)
    );
    expect(reconciled).not.toContain('[restored-1.png]');
    expect(reconciled).not.toContain('[restored-3.png]');
    expect(reconciled).toContain('[restored-4.png]');

    // A restored-at-cap list still accepts a new image by evicting the oldest.
    const added = stateModule.addClipboardImage({
      id: 'fresh',
      url: 'blob:fresh',
      mime: 'image/png',
      filename: 'fresh.png',
      size: 10,
    });

    expect(added).toBe(true);
    expect(stateModule.state.clipboardImages).toHaveLength(stateModule.MAX_CLIPBOARD_IMAGES);
    expect(stateModule.state.clipboardImages.at(-1)?.id).toBe('fresh');

    stateModule.clearClipboardImages();
  });

  it('tracks global and per-session selected models independently', async () => {
    const stateModule = await loadState();

    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-5' });
    stateModule.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-4o' },
      { sessionId: 'session-1', persistGlobal: false }
    );

    expect(stateModule.state.selectedModel).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
    expect(stateModule.getSelectedModelForSession('session-1')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
    expect(stateModule.getPersistedSelectedModel()).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    });

    stateModule.clearSelectedModelForSession('session-1');
    expect(stateModule.getSelectedModelForSession('session-1')).toBeNull();
  });

  it('does not promote a temporary session model or reasoning to global defaults', async () => {
    const stateModule = await loadState();
    const defaultModel = {
      providerID: 'openai',
      modelID: 'gpt-5',
      variant: 'medium',
    };
    const sessionModel = {
      providerID: 'openai',
      modelID: 'gpt-4o',
      variant: 'high',
    };

    stateModule.setSelectedModel({ ...defaultModel });
    stateModule.setSelectedModel(
      { ...sessionModel },
      {
        sessionId: 'session-1',
        persistGlobal: false,
      }
    );

    expect(stateModule.state.selectedModel).toEqual(sessionModel);
    expect(stateModule.getSelectedModelForSession('session-1')).toEqual(sessionModel);
    expect(stateModule.getPersistedSelectedModel()).toEqual(defaultModel);
    expect(stateModule.getStoredVariantForModel('openai', 'gpt-5')).toBe('medium');
    expect(stateModule.getStoredVariantForModel('openai', 'gpt-4o')).toBeUndefined();
  });

  it('switches between global defaults and active-session routing with the session picker', async () => {
    const stateModule = await loadState();
    const defaultModel = {
      providerID: 'openai',
      modelID: 'gpt-5',
      variant: 'medium',
    };
    const sessionModel = {
      providerID: 'openai',
      modelID: 'gpt-4o',
      variant: 'high',
    };

    stateModule.setSelectedModel({ ...defaultModel });
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setSelectedModel(
      { ...sessionModel },
      {
        sessionId: 'session-1',
        persistGlobal: false,
      }
    );

    stateModule.setPersistentShowSessionPicker(true);
    expect(stateModule.state.selectedModel).toEqual(defaultModel);
    expect(stateModule.getSelectedModelForSession('session-1')).toEqual(sessionModel);

    stateModule.setPersistentShowSessionPicker(false);
    expect(stateModule.state.selectedModel).toEqual(sessionModel);
    expect(stateModule.getPersistedSelectedModel()).toEqual(defaultModel);
    expect(stateModule.getStoredVariantForModel('openai', 'gpt-4o')).toBeUndefined();
  });

  it('normalizes persisted routing state while preserving valid entries', async () => {
    window.localStorage.setItem('varro.hiddenProviders', JSON.stringify(['openai', 42, '', null]));
    window.localStorage.setItem('varro.hiddenModels', JSON.stringify(['openai:gpt-4o', false, '']));
    window.localStorage.setItem('varro.pinnedModels', JSON.stringify(['openai:gpt-5', false, '']));
    window.localStorage.setItem('varro.selectedAgent', JSON.stringify({ name: 'build' }));
    window.localStorage.setItem(
      'varro.selectedModel',
      JSON.stringify({ providerID: 'openai', modelID: 'gpt-5', variant: 42 })
    );
    window.localStorage.setItem(
      'varro.sessionSelectedAgents',
      JSON.stringify({ 'session-1': 'build', 'session-2': 42, '': 'plan' })
    );
    window.localStorage.setItem(
      'varro.sessionSelectedModels',
      JSON.stringify({
        'session-1': { providerID: 'openai', modelID: 'gpt-4o', variant: 'high' },
        'session-2': { providerID: 'openai' },
      })
    );
    window.localStorage.setItem(
      'varro.modelVariantSelections',
      JSON.stringify({ 'openai:gpt-5': 'medium', 'openai:gpt-5.5': null, invalid: false })
    );
    window.localStorage.setItem(
      'varro.sessionSelectedMcps',
      JSON.stringify({ 'session-1': ['docs', 42, '', 'browser-bridge'], 'session-2': 'docs' })
    );
    window.localStorage.setItem(
      'varro.sessionPermissionModes',
      JSON.stringify({ 'session-1': 'full', 'session-2': 'invalid' })
    );
    window.localStorage.setItem('varro.lastActiveSessionId', JSON.stringify(42));

    const stateModule = await loadState();

    expect(stateModule.state.hiddenProviders).toEqual(['openai']);
    expect(stateModule.state.hiddenModels).toEqual(['openai:gpt-4o']);
    expect(stateModule.state.pinnedModels).toEqual(['openai:gpt-5']);
    expect(stateModule.isProviderVisible('openai')).toBe(false);
    expect(stateModule.state.selectedAgent).toBeNull();
    expect(stateModule.state.selectedModel).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(stateModule.state.sessionSelectedAgents).toEqual({ 'session-1': 'build' });
    expect(stateModule.state.sessionSelectedModels).toEqual({
      'session-1': { providerID: 'openai', modelID: 'gpt-4o', variant: 'high' },
    });
    expect(stateModule.state.modelVariantSelections).toEqual({
      'openai:gpt-5': 'medium',
      'openai:gpt-5.5': null,
    });
    expect(stateModule.state.sessionSelectedMcps).toEqual({
      'session-1': ['docs', 'browser-bridge'],
    });
    expect(stateModule.state.sessionPermissionModes).toEqual({ 'session-1': 'full' });
    expect(stateModule.getPersistedSelectedAgent()).toBeNull();
    expect(stateModule.getPersistedSelectedModel()).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    });
    expect(stateModule.getPersistedActiveSessionId()).toBeNull();
  });

  it('rejects malformed routing values from VS Code webview state', async () => {
    const persisted = {
      'varro.hiddenProviders': { openai: true },
      'varro.hiddenModels': ['openai:gpt-4o', null],
      'varro.pinnedModels': ['openai:gpt-5', null],
      'varro.selectedAgent': ['build'],
      'varro.selectedModel': 'openai/gpt-5',
      'varro.sessionSelectedAgents': ['build'],
      'varro.sessionSelectedModels': null,
      'varro.modelVariantSelections': 42,
      'varro.sessionSelectedMcps': { 'session-1': null },
    };
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __vscodeWebviewState?: unknown }).__vscodeWebviewState = {
      getState: () => persisted,
      setState: vi.fn(),
    };

    try {
      const stateModule = await loadState();

      expect(stateModule.state.hiddenProviders).toEqual([]);
      expect(stateModule.state.hiddenModels).toEqual(['openai:gpt-4o']);
      expect(stateModule.state.pinnedModels).toEqual(['openai:gpt-5']);
      expect(stateModule.state.selectedAgent).toBeNull();
      expect(stateModule.state.selectedModel).toBeNull();
      expect(stateModule.state.sessionSelectedAgents).toEqual({});
      expect(stateModule.state.sessionSelectedModels).toEqual({});
      expect(stateModule.state.modelVariantSelections).toEqual({});
      expect(stateModule.state.sessionSelectedMcps).toEqual({});
      expect(stateModule.isModelVisible('openai', 'gpt-4o')).toBe(false);
    } finally {
      // SAFETY: The fixture provides the unknown fields read by this statement.
      delete (window as { __vscodeWebviewState?: unknown }).__vscodeWebviewState;
    }
  });

  it('remembers reasoning variants independently per model', async () => {
    const stateModule = await loadState();

    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-5.4', variant: 'medium' });
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'low' });

    expect(stateModule.getStoredVariantForModel('openai', 'gpt-5.4')).toBe('medium');
    expect(stateModule.getStoredVariantForModel('openai', 'gpt-5.5')).toBe('low');
  });

  it('applies a host model snapshot to the active session composer', async () => {
    const stateModule = await loadState();
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'medium' },
      { sessionId: 'session-1', persistGlobal: false }
    );

    stateModule.applySessionSelectedModelsSnapshot({
      'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
    });

    expect(stateModule.state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });
    expect(stateModule.getSelectedModelForSession('session-1')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });
  });

  it('does not apply a session model snapshot to the new-chat composer', async () => {
    const stateModule = await loadState();
    const draftModel = { providerID: 'openai', modelID: 'gpt-5.6-sol' };
    stateModule.setSelectedModel(draftModel);
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setShowSessionPicker(true);

    stateModule.applySessionSelectedModelsSnapshot({
      'session-1': { providerID: 'openai', modelID: 'gpt-5.6-sol', variant: 'xhigh' },
    });

    expect(stateModule.state.selectedModel).toEqual(draftModel);
    expect(stateModule.getSelectedModelForSession('session-1')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'xhigh',
    });
  });

  it('remembers an explicit default reasoning selection', async () => {
    const stateModule = await loadState();

    stateModule.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-5', variant: 'max' },
      { sessionId: 'session-1' }
    );
    stateModule.setSelectedModel(
      { providerID: 'openai', modelID: 'gpt-5' },
      { sessionId: 'session-1', rememberVariant: null }
    );

    expect(stateModule.state.selectedModel).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(stateModule.getSelectedModelForSession('session-1')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    });
    expect(stateModule.getStoredVariantForModel('openai', 'gpt-5')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('varro.modelVariantSelections')!)).toEqual({
      'openai:gpt-5': null,
    });
    expect(JSON.parse(window.localStorage.getItem('varro.sessionSelectedModels')!)).toEqual({
      'session-1': { providerID: 'openai', modelID: 'gpt-5' },
    });
  });

  it('tracks global and per-session selected agents independently', async () => {
    const stateModule = await loadState();
    const sent: unknown[] = [];
    const bridgeWindow = getTestBridgeWindow();
    bridgeWindow.__sendToExtension = (message) => sent.push(message);

    stateModule.setSelectedAgent('build');
    stateModule.setSelectedAgent('plan', { sessionId: 'session-1', persistGlobal: false });

    expect(stateModule.state.selectedAgent).toBe('plan');
    expect(stateModule.getSelectedAgentForSession('session-1')).toBe('plan');
    expect(stateModule.getPersistedSelectedAgent()).toBe('build');
    expect(sent).toContainEqual({
      type: 'session-plan-state/update',
      payload: { sessionId: 'session-1', agent: 'plan' },
    });

    stateModule.clearSelectedAgentForSession('session-1');
    expect(stateModule.getSelectedAgentForSession('session-1')).toBeNull();
    delete bridgeWindow.__sendToExtension;
  });

  it('updates session agent metadata without changing the visible selection', async () => {
    const stateModule = await loadState();

    stateModule.setSelectedAgent('build');
    stateModule.setSelectedAgent('explore', {
      sessionId: 'child-session',
      persistGlobal: false,
      updateSelection: false,
    });

    expect(stateModule.state.selectedAgent).toBe('build');
    expect(stateModule.getSelectedAgentForSession('child-session')).toBe('explore');
    expect(stateModule.getPersistedSelectedAgent()).toBe('build');
  });

  it('applies host agent updates to the active session selection', async () => {
    const stateModule = await loadState();
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setSelectedAgent('plan');

    stateModule.applySessionSelectedAgentUpdate('session-1', 'build');

    expect(stateModule.state.selectedAgent).toBe('build');
    expect(stateModule.getSelectedAgentForSession('session-1')).toBe('build');
    expect(JSON.parse(window.localStorage.getItem('varro.sessionSelectedAgents')!)).toEqual({
      'session-1': 'build',
    });
  });

  it('keeps the visible agent when a host update targets another session', async () => {
    const stateModule = await loadState();
    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setSelectedAgent('plan');

    stateModule.applySessionSelectedAgentUpdate('session-2', 'build');

    expect(stateModule.state.selectedAgent).toBe('plan');
    expect(stateModule.getSelectedAgentForSession('session-2')).toBe('build');
  });

  it('tracks per-session selected mcps independently', async () => {
    const stateModule = await loadState();

    stateModule.setSelectedMcpsForSession('session-1', ['browser-bridge', 'docs']);
    expect(stateModule.getSelectedMcpsForSession('session-1')).toEqual(['browser-bridge', 'docs']);

    stateModule.clearSelectedMcpsForSession('session-1');
    expect(stateModule.getSelectedMcpsForSession('session-1')).toBeNull();
  });

  it('updates questions and model visibility state', async () => {
    const stateModule = await loadState();
    const providers = [
      provider('openai', ['gpt-4.1', 'gpt-4o']),
      provider('anthropic', ['claude']),
    ];

    stateModule.setQuestions([{ id: 'q1', sessionID: 'session-1', questions: [] }]);
    const question = stateModule.state.questions[0];

    stateModule.setQuestions([{ id: 'q1', sessionID: 'session-1', questions: [] }]);

    expect(stateModule.state.questions[0]).toBe(question);

    stateModule.upsertQuestion({
      id: 'q1',
      sessionID: 'session-1',
      questions: [{ question: 'Q', header: 'H', options: [] }],
    });
    stateModule.upsertQuestion({ id: 'q2', sessionID: 'session-2', questions: [] });
    stateModule.removeQuestion('q2');

    expect(stateModule.state.questions).toHaveLength(1);
    expect(stateModule.state.questions[0]?.questions).toHaveLength(1);

    stateModule.setState('providers', providers);
    stateModule.setModelPinned('openai', 'gpt-4.1', true);
    expect(stateModule.isModelPinned('openai', 'gpt-4.1')).toBe(true);
    expect(JSON.parse(window.localStorage.getItem('varro.pinnedModels')!)).toEqual([
      'openai:gpt-4.1',
    ]);
    stateModule.setModelPinned('openai', 'gpt-4.1', false);
    expect(stateModule.isModelPinned('openai', 'gpt-4.1')).toBe(false);
    stateModule.setSelectedModel({ providerID: 'openai', modelID: 'gpt-4.1' });
    stateModule.setProviderVisible('openai', false);
    expect(stateModule.state.hiddenProviders).toEqual(['openai']);
    expect(stateModule.state.selectedModel).toBeNull();

    stateModule.setModelVisible('openai', 'gpt-4.1', true);
    expect(stateModule.state.hiddenProviders).toEqual([]);
    expect(stateModule.state.hiddenModels).toEqual(['openai:gpt-4o']);

    stateModule.setSelectedModel({ providerID: 'anthropic', modelID: 'claude' });
    stateModule.setModelVisible('anthropic', 'claude', false);
    expect(stateModule.state.hiddenModels).toContain('anthropic:claude');
    expect(stateModule.state.selectedModel).toBeNull();
    expect(
      stateModule.resolveSelectedModel(
        { providerID: 'anthropic', modelID: 'claude' },
        providers,
        {},
        { allowHidden: true }
      )
    ).toEqual({ providerID: 'anthropic', modelID: 'claude' });

    expect(stateModule.getVisibleProviders(providers).map((item) => item.id)).toEqual(['openai']);
    expect(
      stateModule.resolveSelectedModel(
        { providerID: 'openai', modelID: 'gpt-4.1', variant: 'missing' },
        providers,
        {}
      )
    ).toEqual({ providerID: 'openai', modelID: 'gpt-4.1' });

    stateModule.resetModelVisibility();
    expect(stateModule.isModelVisible('anthropic', 'claude')).toBe(true);
  });

  it('lists only explicitly added models from large provider catalogs', async () => {
    const stateModule = await loadState();
    const openRouter = provider(
      'openrouter',
      Array.from({ length: 101 }, (_, index) => `model-${index}`)
    );
    stateModule.setState('providers', [openRouter]);

    expect(stateModule.isLargeModelCatalog(openRouter)).toBe(true);
    expect(stateModule.getVisibleProviders([openRouter])).toEqual([]);

    stateModule.setModelAdded('openrouter', 'model-42', true);

    expect(Object.keys(stateModule.getVisibleProviders([openRouter])[0]?.models ?? {})).toEqual([
      'model-42',
    ]);
    expect(JSON.parse(window.localStorage.getItem('varro.addedModels')!)).toEqual([
      'openrouter:model-42',
    ]);

    const refreshed = provider(
      'openrouter',
      Array.from({ length: 102 }, (_, index) => `model-${index}`)
    );
    stateModule.setState('providers', [refreshed]);
    expect(Object.keys(stateModule.getVisibleProviders([refreshed])[0]?.models ?? {})).toEqual([
      'model-42',
    ]);

    stateModule.setModelAdded('openrouter', 'model-42', false);
    expect(stateModule.getVisibleProviders([refreshed])).toEqual([]);
  });

  it('tracks provider limits independently per provider and model', async () => {
    const stateModule = await loadState();

    const gpt4oLimit = {
      providerID: 'openai',
      modelID: 'gpt-4o',
      status: 'available' as const,
      source: 'provider' as const,
      checkedAt: 1,
      windows: [
        {
          id: 'requests',
          label: 'Requests',
          unit: 'requests' as const,
          remaining: 10,
          limit: 100,
          resetAt: null,
        },
      ],
    };
    const gpt41Limit = {
      providerID: 'openai',
      modelID: 'gpt-4.1',
      status: 'available' as const,
      source: 'provider' as const,
      checkedAt: 2,
      windows: [
        {
          id: 'requests',
          label: 'Requests',
          unit: 'requests' as const,
          remaining: 4,
          limit: 20,
          resetAt: null,
        },
      ],
    };

    stateModule.setProviderLimit('openai', 'gpt-4o', gpt4oLimit);
    stateModule.setProviderLimit('openai', 'gpt-4.1', gpt41Limit);

    expect(stateModule.getProviderLimit('openai', 'gpt-4o')).toEqual(gpt4oLimit);
    expect(stateModule.getProviderLimit('openai', 'gpt-4.1')).toEqual(gpt41Limit);
    expect(stateModule.getProviderLimit('openai', 'missing')).toBeNull();

    stateModule.setProviderLimit('openai', 'gpt-4o', null);
    expect(stateModule.getProviderLimit('openai', 'gpt-4o')).toBeNull();
    expect(stateModule.getProviderLimit('openai', 'gpt-4.1')).toEqual(gpt41Limit);
  });

  it('treats permission and question state as awaiting input', async () => {
    const stateModule = await loadState();

    stateModule.setState('permissions', [
      {
        id: 'perm-1',
        type: 'write',
        sessionID: 'session-1',
        messageID: 'message-1',
        title: 'Write file',
        metadata: {},
        time: { created: 0 },
      },
    ]);
    expect(stateModule.isSessionAwaitingInput('session-1')).toBe(true);

    stateModule.setState('permissions', []);
    stateModule.setState('questions', [{ id: 'q1', sessionID: 'session-2', questions: [] }]);
    expect(stateModule.isSessionAwaitingInput('session-2')).toBe(true);

    stateModule.setState('questions', []);
    expect(stateModule.isSessionAwaitingInput('session-3')).toBe(false);
  });

  it('treats root-session prompts as awaiting input on child sessions', async () => {
    const stateModule = await loadState();

    stateModule.setState('sessions', [
      {
        id: 'session-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Session 1',
        version: '1',
        time: { created: 0, updated: 10 },
      },
      {
        id: 'child-1',
        projectID: 'project-1',
        directory: '/',
        title: 'Child 1',
        version: '1',
        parentID: 'session-1',
        time: { created: 0, updated: 20 },
      },
    ]);
    stateModule.setState('permissions', [
      {
        id: 'perm-1',
        type: 'write',
        sessionID: 'session-1',
        messageID: 'message-1',
        title: 'Write file',
        metadata: {},
        time: { created: 0 },
      },
    ]);

    expect(stateModule.isSessionAwaitingInput('child-1')).toBe(true);
  });

  it('handles incremental message updates and subagent grouping', async () => {
    const stateModule = await loadState();

    stateModule.clearMessages();
    const initialVersion = stateModule.messageStructureVersion();
    stateModule.upsertMessageInfo(userMessage('message-1'));
    expect(stateModule.messageStructureVersion()).toBe(initialVersion + 1);

    const afterMessageInsert = stateModule.messageStructureVersion();
    stateModule.upsertMessageInfo(userMessage('message-1', 'session-1', 1));
    expect(stateModule.messageStructureVersion()).toBe(afterMessageInsert + 1);

    const afterMessageInfoUpdate = stateModule.messageStructureVersion();
    stateModule.upsertMessage({
      info: userMessage('message-1', 'session-1', 1),
      parts: [],
    });
    expect(stateModule.messageStructureVersion()).toBe(afterMessageInfoUpdate);

    stateModule.applyMessagePartDelta('message-1', 'part-1', 'Hello', 'session-1');
    await nextFrame();

    expect(stateModule.state.messages[0]?.parts[0]).toMatchObject({
      id: 'part-1',
      type: 'text',
      text: 'Hello',
    });

    const afterPartInsert = stateModule.messageStructureVersion();

    stateModule.upsertPart({
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'text',
      text: 'Hello world',
    });

    expect(stateModule.messageStructureVersion()).toBe(afterPartInsert);
    expect(stateModule.state.streamingPartId).toBeNull();
    expect(stateModule.state.streamingText).toBe('');

    stateModule.updateMessagePart({
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'text',
      text: 'Updated text',
    });
    expect(stateModule.getMessageById('message-1')?.parts[0]).toMatchObject({
      id: 'part-1',
      text: 'Updated text',
    });

    stateModule.applyMessagePartDelta('message-1', 'part-2', 'Bye', 'session-1');
    await nextFrame();
    const afterSecondPartInsert = stateModule.messageStructureVersion();
    stateModule.removeMessagePart('session-1', 'message-1', 'missing-part');
    expect(stateModule.messageStructureVersion()).toBe(afterSecondPartInsert);

    stateModule.removeMessagePart('session-1', 'message-1', 'part-2');
    expect(stateModule.messageStructureVersion()).toBe(afterSecondPartInsert + 1);
    expect(stateModule.state.messages[0]?.parts).toHaveLength(1);

    stateModule.setMessagesIncremental([
      { info: assistantMessage('message-1', 'session-1', 10), parts: [] },
      { info: assistantMessage('message-2', 'session-1', 20), parts: [] },
    ]);
    stateModule.setMessagesIncremental([
      { info: assistantMessage('message-2', 'session-1', 20), parts: [] },
      { info: assistantMessage('message-3', 'session-1', 30), parts: [] },
    ]);

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'message-2',
      'message-3',
    ]);

    const afterNoOpSync = stateModule.messageStructureVersion();
    const sameEntries = stateModule.state.messages;
    stateModule.setMessagesIncremental(sameEntries);
    expect(stateModule.messageStructureVersion()).toBe(afterNoOpSync);

    const children = stateModule.getChildRunsByParentId([
      { info: assistantMessage('child-2', 'session-1', 20, 'subagent', 'parent-1'), parts: [] },
      { info: assistantMessage('normal', 'session-1', 5, 'default', 'parent-1'), parts: [] },
      { info: assistantMessage('child-1', 'session-1', 10, 'subagent', 'parent-1'), parts: [] },
    ]);

    expect(children.get('parent-1')?.map((entry) => entry.info.id)).toEqual(['child-1', 'child-2']);

    stateModule.replaceMessages([
      { info: assistantMessage('child-2', 'session-1', 20, 'subagent', 'parent-1'), parts: [] },
      { info: assistantMessage('child-1', 'session-1', 10, 'subagent', 'parent-1'), parts: [] },
    ]);

    const cachedChildren = stateModule.getChildRunsByParentId(stateModule.state.messages);
    expect(stateModule.getChildRunsByParentId(stateModule.state.messages)).toBe(cachedChildren);
    expect(cachedChildren.get('parent-1')?.map((entry) => entry.info.id)).toEqual([
      'child-1',
      'child-2',
    ]);

    stateModule.setMessagesIncremental([
      { info: assistantMessage('child-3', 'session-1', 5, 'subagent', 'parent-1'), parts: [] },
      { info: assistantMessage('child-2', 'session-1', 20, 'subagent', 'parent-1'), parts: [] },
      { info: assistantMessage('child-1', 'session-1', 10, 'subagent', 'parent-1'), parts: [] },
    ]);

    const updatedChildren = stateModule.getChildRunsByParentId(stateModule.state.messages);
    expect(updatedChildren).not.toBe(cachedChildren);
    expect(updatedChildren.get('parent-1')?.map((entry) => entry.info.id)).toEqual([
      'child-3',
      'child-1',
      'child-2',
    ]);
  });

  it('reconciles optimistic user messages when the server user message arrives', async () => {
    const stateModule = await loadState();
    const optimisticParts: Part[] = [
      {
        id: 'message-1-part-0',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'Test message',
        synthetic: true,
      },
      {
        id: 'message-1-part-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: '[Working directory: /repo]',
        synthetic: true,
      },
    ];

    stateModule.upsertMessage({
      info: userMessage('message-1'),
      parts: optimisticParts,
    });

    stateModule.upsertMessageInfo(userMessage('message-1'));

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['message-1']);
  });

  it('preserves optimistic user image parts when server metadata arrives first', async () => {
    const stateModule = await loadState();
    const optimisticParts: Part[] = [
      {
        id: 'message-1-part-0',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'Review [image.png]',
        synthetic: true,
      },
      {
        id: 'message-1-part-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'file',
        mime: 'image/png',
        filename: 'image.png',
        url: 'blob:image-1',
      },
    ];

    stateModule.upsertMessage({
      info: userMessage('message-1'),
      parts: optimisticParts,
    });

    stateModule.upsertMessageInfo(userMessage('message-1'));

    expect(stateModule.state.messages).toHaveLength(1);
    expect(stateModule.state.messages[0]?.info.id).toBe('message-1');
    expect(stateModule.state.messages[0]?.parts).toEqual([
      {
        id: 'message-1-part-0',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'Review [image.png]',
        synthetic: true,
      },
      {
        id: 'message-1-optimistic-file-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'file',
        mime: 'image/png',
        filename: 'image.png',
        url: 'blob:image-1',
      },
    ]);
  });

  it('replaces an optimistic user image part when the server file part arrives', async () => {
    const stateModule = await loadState();
    stateModule.upsertMessage({
      info: userMessage('message-1'),
      parts: [
        {
          id: 'message-1-part-0',
          sessionID: 'session-1',
          messageID: 'message-1',
          type: 'file',
          mime: 'image/png',
          filename: 'image.png',
          url: 'blob:image-1',
        },
      ],
    });
    stateModule.upsertMessageInfo(userMessage('message-1'));

    stateModule.upsertPart({
      id: 'server-file-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'file',
      mime: 'image/png',
      filename: 'image.png',
      url: 'blob:image-1',
    });

    expect(stateModule.state.messages[0]?.parts).toEqual([
      {
        id: 'server-file-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'file',
        mime: 'image/png',
        filename: 'image.png',
        url: 'blob:image-1',
      },
    ]);
  });

  it('does not preserve optimistic user text when an incremental sync replaces it', async () => {
    const stateModule = await loadState();
    const optimisticParts: Part[] = [
      {
        id: 'optimistic-user-1-part-0',
        sessionID: 'session-1',
        messageID: 'optimistic-user-1',
        type: 'text',
        text: 'Follow-up prompt',
        synthetic: true,
      },
    ];

    stateModule.setMessagesIncremental([
      { info: userMessage('user-1', 'session-1', 1), parts: [] },
      { info: assistantMessage('assistant-1', 'session-1', 2), parts: [] },
      { info: userMessage('optimistic-user-1', 'session-1', 3), parts: optimisticParts },
    ]);

    stateModule.setMessagesIncremental(
      [
        { info: userMessage('user-1', 'session-1', 1), parts: [] },
        { info: assistantMessage('assistant-1', 'session-1', 2), parts: [] },
        {
          info: userMessage('message-1', 'session-1', 4),
          parts: [
            {
              id: 'message-1-part-0',
              sessionID: 'session-1',
              messageID: 'message-1',
              type: 'text',
              text: 'Follow-up prompt',
            },
          ],
        },
      ],
      { preserveExtraParts: true }
    );

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'assistant-1',
      'message-1',
    ]);
    expect(stateModule.state.messages[2]?.parts).toEqual([
      {
        id: 'message-1-part-0',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text: 'Follow-up prompt',
      },
    ]);
  });

  it('prunes an edited user message and later messages with restore support', async () => {
    const stateModule = await loadState();
    const messages = [
      { info: userMessage('user-1', 'session-1', 1), parts: [] },
      { info: assistantMessage('assistant-1', 'session-1', 2, 'default', 'user-1'), parts: [] },
      { info: userMessage('user-2', 'session-1', 3), parts: [] },
      { info: assistantMessage('assistant-2', 'session-1', 4, 'default', 'user-2'), parts: [] },
    ];
    stateModule.setMessagesIncremental(messages);
    const retainedEntries = stateModule.state.messages.slice(0, 2);

    const restore = stateModule.pruneMessagesFrom('session-1', 'user-2');

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
    expect(stateModule.state.messages[0]).toBe(retainedEntries[0]);
    expect(stateModule.state.messages[1]).toBe(retainedEntries[1]);

    restore?.();

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
  });

  it('toggles local ui helpers and persists ui display preferences', async () => {
    const stateModule = await loadState();

    expect(stateModule.composerFocusKey()).toBe(0);
    expect(stateModule.openAttentionSessionsKey()).toBe(0);
    expect(stateModule.openCompletedSessionsKey()).toBe(0);
    expect(stateModule.messageListScrollRequestKey()).toBe(0);
    expect(stateModule.showThinking()).toBe(true);
    expect(stateModule.showChangedFiles()).toBe(false);

    stateModule.requestComposerFocus();
    stateModule.requestOpenAttentionSessions();
    stateModule.requestOpenCompletedSessions();
    stateModule.requestMessageListScrollToBottom('message-new-turn');
    stateModule.toggleThinking();
    stateModule.resetPastedImageIndex();

    expect(stateModule.composerFocusKey()).toBe(1);
    expect(stateModule.openAttentionSessionsKey()).toBe(1);
    expect(stateModule.openCompletedSessionsKey()).toBe(1);
    expect(stateModule.messageListScrollRequestKey()).toBe(1);
    expect(stateModule.messageListScrollTargetMessageId()).toBe('message-new-turn');
    stateModule.requestMessageListScrollToBottom();
    expect(stateModule.messageListScrollRequestKey()).toBe(2);
    expect(stateModule.messageListScrollTargetMessageId()).toBeNull();
    expect(stateModule.showThinking()).toBe(false);
    expect(stateModule.nextPastedImageIndex()).toBe(1);
    expect(window.localStorage.getItem('varro.showThinking')).toBe(JSON.stringify(false));
  });

  it('updates incremental message entries when only metadata changes', async () => {
    const stateModule = await loadState();

    stateModule.setMessagesIncremental([
      {
        info: assistantMessage('message-1', 'session-1', 10),
        parts: [
          {
            id: 'tool-1',
            sessionID: 'session-1',
            messageID: 'message-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'bash',
            state: {
              status: 'running',
              input: { command: 'pwd' },
              title: 'Run pwd',
              time: { start: 1 },
            },
          },
        ],
      },
    ]);

    const beforeVersion = stateModule.messageStructureVersion();

    stateModule.setMessagesIncremental([
      {
        info: {
          ...assistantMessage('message-1', 'session-1', 10),
          providerID: 'provider-2',
          modelID: 'model-2',
          variant: 'high',
          cost: 42,
          summary: true,
        },
        parts: [
          {
            id: 'tool-1',
            sessionID: 'session-1',
            messageID: 'message-1',
            type: 'tool',
            callID: 'call-1',
            tool: 'bash',
            metadata: { cwd: '/repo' },
            state: {
              status: 'completed',
              input: { command: 'pwd' },
              output: '/repo',
              title: 'Run pwd',
              metadata: { exitCode: 0 },
              time: { start: 1, end: 2 },
            },
          },
        ],
      },
    ]);

    expect(stateModule.messageStructureVersion()).toBe(beforeVersion + 1);
    expect(stateModule.state.messages[0]?.info).toMatchObject({
      providerID: 'provider-2',
      modelID: 'model-2',
      variant: 'high',
      cost: 42,
      summary: true,
    });
    expect(stateModule.state.messages[0]?.parts[0]).toMatchObject({
      metadata: { cwd: '/repo' },
      state: expect.objectContaining({
        status: 'completed',
        output: '/repo',
        metadata: { exitCode: 0 },
      }),
    });
  });

  it('preserves newer local parts during incremental snapshot refreshes', async () => {
    const stateModule = await loadState();

    stateModule.setMessagesIncremental([
      {
        info: assistantMessage('message-1', 'session-1', 10),
        parts: [],
      },
    ]);

    stateModule.upsertPart({
      id: 'tool-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'tool',
      callID: 'call-1',
      tool: 'todowrite',
      state: {
        status: 'running',
        input: { todos: [{ content: 'Keep me', status: 'pending', priority: 'medium' }] },
        time: { start: 1 },
      },
    });

    stateModule.setMessagesIncremental(
      [
        {
          info: assistantMessage('message-1', 'session-1', 10),
          parts: [],
        },
      ],
      { preserveExtraParts: true }
    );

    expect(stateModule.state.messages[0]?.parts).toHaveLength(1);
    expect(stateModule.state.messages[0]?.parts[0]).toMatchObject({ id: 'tool-1' });
  });

  it('reads desktop session pane side from initial webview state', async () => {
    // SAFETY: The fixture provides the unknown fields read by this statement.
    (window as { __initialWebviewState?: unknown }).__initialWebviewState = {
      theme: 'dark',
      serverStatus: { state: 'stopped' },
      editorContext: {
        workspacePath: '/repo',
        activeFile: null,
        selection: null,
        diagnostics: [],
      },
      terminalSelection: null,
      droppedFiles: [],
      emptyStateLogoUri: '',
      desktopSessionPaneSide: 'right',
    };

    const stateModule = await loadState();

    expect(stateModule.desktopSessionPaneSide()).toBe('right');
  });
});
