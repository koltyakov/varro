import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Provider, UserMessage } from '../types';

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
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
      return;
    }
    setTimeout(resolve, 16);
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

  it('persists active session state and unread markers', async () => {
    const stateModule = await loadState();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    stateModule.persistActiveSessionId('session-1');
    expect(stateModule.getPersistedActiveSessionId()).toBe('session-1');

    stateModule.markSessionSeen('session-1');
    stateModule.markSessionSeen('session-2');
    stateModule.setState('activeSessionId', 'session-1');

    expect(stateModule.state.lastSeenSessions).toEqual({ 'session-1': 1_000, 'session-2': 1_000 });
    expect(stateModule.isSessionUnread('session-1', 1_000)).toBe(false);
    expect(stateModule.isSessionUnread('session-1', 1_001)).toBe(true);
    expect(stateModule.isSessionUnread('session-2', 999)).toBe(false);
    expect(stateModule.isSessionUnread('session-2', 1_001)).toBe(true);

    stateModule.markSessionSeen('session-1', 1_500);
    expect(stateModule.state.lastSeenSessions['session-1']).toBe(1_500);
    expect(stateModule.isSessionUnread('session-1', 1_500)).toBe(false);

    stateModule.setSessionCompacting('session-4', true);
    expect(stateModule.state.compactingSessionIds).toEqual(['session-4']);

    stateModule.setSessionCompacting('session-4', false);
    expect(stateModule.state.compactingSessionIds).toEqual([]);
  });

  it('persists skipped plan sessions by session update time', async () => {
    const stateModule = await loadState();

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
      JSON.stringify({ 'session-1': 200 })
    );

    stateModule.clearSkippedPlanSession('session-1');

    expect(stateModule.state.skippedPlanSessions).toEqual({});
    expect(window.localStorage.getItem('varro.skippedPlanSessions')).toBe(JSON.stringify({}));
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

  it('tracks current document auto-context state by session in memory', async () => {
    const stateModule = await loadState();

    stateModule.setState('activeSessionId', null);
    stateModule.rememberCurrentDocumentNavigation(null, '/repo/a.ts');
    expect(stateModule.getCurrentDocumentEnabled()).toBe(true);

    stateModule.toggleCurrentDocumentEnabled();
    expect(stateModule.getCurrentDocumentEnabled()).toBe(false);

    stateModule.rememberCurrentDocumentNavigation('/repo/a.ts', '/repo/b.ts');
    expect(stateModule.getCurrentDocumentEnabled()).toBe(false);

    stateModule.adoptDraftCurrentDocumentState('session-1');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(false);
    expect(stateModule.getCurrentDocumentEnabled()).toBe(true);

    stateModule.setCurrentDocumentEnabled(true, 'session-1');
    stateModule.rememberCurrentDocumentNavigation('/repo/a.ts', '/repo/b.ts', 'session-1');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(true);

    stateModule.setCurrentDocumentEnabled(false, 'session-1');
    stateModule.rememberCurrentDocumentNavigation('/repo/b.ts', '/repo/c.ts', 'session-1');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(false);

    stateModule.clearCurrentDocumentStateForSession('session-1');
    expect(stateModule.getCurrentDocumentEnabled('session-1')).toBe(true);
    expect(stateModule.getCurrentDocumentEnabled('session-2')).toBe(true);
  });

  it('deduplicates context files and manages clipboard image placeholders', async () => {
    const stateModule = await loadState();

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
      {
        path: '/repo/a.ts',
        relativePath: 'a.ts',
        type: 'file',
        lineRanges: [
          { startLine: 2, endLine: 4 },
          { startLine: 8, endLine: 9 },
        ],
      },
    ]);

    stateModule.removeContextFile('/repo/a.ts');
    expect(stateModule.state.droppedFiles).toEqual([]);

    stateModule.addContextFile({ path: '/repo/b.ts', relativePath: 'b.ts', type: 'file' });
    expect(stateModule.state.droppedFiles.map((file) => file.relativePath)).toEqual(['b.ts']);

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
      { path: '/repo/a.ts', relativePath: 'a.ts', type: 'file' },
    ]);

    stateModule.clearContextFiles();
    expect(stateModule.state.droppedFiles).toEqual([]);

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

    expect(stateModule.state.clipboardImages.map((image) => image.id)).toEqual([
      'img-2',
      'img-3',
      'img-4',
      'img-5',
      'img-6',
    ]);

    stateModule.removeClipboardImage('img-2');
    expect(stateModule.inputText()).toBe('See _____ later');

    stateModule.setInputText('   ');
    stateModule.setNextPastedImageIndex(4);
    stateModule.clearClipboardImages();

    expect(stateModule.state.clipboardImages).toEqual([]);
    expect(stateModule.nextPastedImageIndex()).toBe(1);
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

  it('tracks global and per-session selected agents independently', async () => {
    const stateModule = await loadState();

    stateModule.setSelectedAgent('build');
    stateModule.setSelectedAgent('plan', { sessionId: 'session-1', persistGlobal: false });

    expect(stateModule.state.selectedAgent).toBe('plan');
    expect(stateModule.getSelectedAgentForSession('session-1')).toBe('plan');
    expect(stateModule.getPersistedSelectedAgent()).toBe('build');

    stateModule.clearSelectedAgentForSession('session-1');
    expect(stateModule.getSelectedAgentForSession('session-1')).toBeNull();
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

  it('treats synced pending-attention sessions as awaiting input', async () => {
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
    stateModule.setState('pendingAttentionSessionIds', ['session-3']);
    expect(stateModule.isSessionAwaitingInput('session-3')).toBe(true);
    expect(stateModule.isSessionAwaitingInput('session-4')).toBe(false);
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
  });

  it('toggles local ui helpers and persists ui display preferences', async () => {
    const stateModule = await loadState();

    expect(stateModule.composerFocusKey()).toBe(0);
    expect(stateModule.openAttentionSessionsKey()).toBe(0);
    expect(stateModule.messageListScrollRequestKey()).toBe(0);
    expect(stateModule.showThinking()).toBe(true);
    expect(stateModule.expandThinkingByDefault()).toBe(false);
    expect(stateModule.showStickyUserPrompt()).toBe(true);

    stateModule.requestComposerFocus();
    stateModule.requestOpenAttentionSessions();
    stateModule.requestMessageListScrollToBottom();
    stateModule.toggleThinking();
    stateModule.setExpandThinkingByDefaultPreference(true);
    stateModule.setShowStickyUserPromptPreference(false);
    stateModule.resetPastedImageIndex();

    expect(stateModule.composerFocusKey()).toBe(1);
    expect(stateModule.openAttentionSessionsKey()).toBe(1);
    expect(stateModule.messageListScrollRequestKey()).toBe(1);
    expect(stateModule.showThinking()).toBe(false);
    expect(stateModule.expandThinkingByDefault()).toBe(true);
    expect(stateModule.showStickyUserPrompt()).toBe(false);
    expect(stateModule.nextPastedImageIndex()).toBe(1);
    expect(window.localStorage.getItem('varro.showThinking')).toBe(JSON.stringify(false));
    expect(window.localStorage.getItem('varro.expandThinkingByDefault')).toBe(JSON.stringify(true));
    expect(window.localStorage.getItem('varro.showStickyUserPrompt')).toBe(JSON.stringify(false));
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

  it('reads desktop session pane side from initial webview state', async () => {
    (window as unknown as { __initialWebviewState?: unknown }).__initialWebviewState = {
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
