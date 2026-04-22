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

    stateModule.markSessionSeen('session-2');
    stateModule.setState('activeSessionId', 'session-1');

    expect(stateModule.state.lastSeenSessions).toEqual({ 'session-2': 1_000 });
    expect(stateModule.isSessionUnread('session-1', 2_000)).toBe(false);
    expect(stateModule.isSessionUnread('session-2', 999)).toBe(false);
    expect(stateModule.isSessionUnread('session-2', 1_001)).toBe(true);

    stateModule.setSessionCompacting('session-4', true);
    expect(stateModule.state.compactingSessionIds).toEqual(['session-4']);

    stateModule.setSessionCompacting('session-4', false);
    expect(stateModule.state.compactingSessionIds).toEqual([]);
  });

  it('tracks draft and per-session permission modes by workspace', async () => {
    const stateModule = await loadState();

    stateModule.syncDraftPermissionForWorkspace('/repo');
    expect(stateModule.draftPermissionMode()).toBe('default');

    stateModule.setPermissionModeForSession(null, 'full');
    expect(stateModule.getPermissionModeForSession(null)).toBe('full');
    expect(window.localStorage.getItem('varro.draftPermissionMode')).toBe(JSON.stringify('full'));
    expect(JSON.parse(window.localStorage.getItem('varro.projectPermissionModes') || '{}')).toEqual({
      '/repo': 'full',
    });

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
    expect(stateModule.state.droppedFiles.map((file) => file.relativePath)).toEqual(['a.ts', 'b.ts']);
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
    expect(stateModule.getPersistedSelectedModel()).toEqual({ providerID: 'openai', modelID: 'gpt-5' });

    stateModule.clearSelectedModelForSession('session-1');
    expect(stateModule.getSelectedModelForSession('session-1')).toBeNull();
  });

  it('updates questions and model visibility state', async () => {
    const stateModule = await loadState();
    const providers = [provider('openai', ['gpt-4.1', 'gpt-4o']), provider('anthropic', ['claude'])];

    stateModule.setQuestions([{ id: 'q1', sessionID: 'session-1', questions: [] }]);
    stateModule.upsertQuestion({ id: 'q1', sessionID: 'session-1', questions: [{ question: 'Q', header: 'H', options: [] }] });
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

  it('handles incremental message updates and subagent grouping', async () => {
    const stateModule = await loadState();

    stateModule.clearMessages();
    stateModule.upsertMessageInfo(userMessage('message-1'));
    stateModule.applyMessagePartDelta('message-1', 'part-1', 'Hello', 'session-1');

    expect(stateModule.state.messages[0]?.parts[0]).toMatchObject({
      id: 'part-1',
      type: 'text',
      text: 'Hello',
    });

    stateModule.upsertPart({
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'text',
      text: 'Hello world',
    });

    expect(stateModule.state.streamingPartId).toBeNull();
    expect(stateModule.state.streamingText).toBe('');

    stateModule.applyMessagePartDelta('message-1', 'part-2', 'Bye', 'session-1');
    stateModule.removeMessagePart('session-1', 'message-1', 'part-2');
    expect(stateModule.state.messages[0]?.parts).toHaveLength(1);

    stateModule.setMessagesIncremental([
      { info: assistantMessage('message-1', 'session-1', 10), parts: [] },
      { info: assistantMessage('message-2', 'session-1', 20), parts: [] },
    ]);
    stateModule.setMessagesIncremental([
      { info: assistantMessage('message-2', 'session-1', 20), parts: [] },
      { info: assistantMessage('message-3', 'session-1', 30), parts: [] },
    ]);

    expect(stateModule.state.messages.map((entry) => entry.info.id)).toEqual(['message-2', 'message-3']);

    const children = stateModule.getChildRunsByParentId([
      { info: assistantMessage('child-2', 'session-1', 20, 'subagent', 'parent-1'), parts: [] },
      { info: assistantMessage('normal', 'session-1', 5, 'default', 'parent-1'), parts: [] },
      { info: assistantMessage('child-1', 'session-1', 10, 'subagent', 'parent-1'), parts: [] },
    ]);

    expect(children.get('parent-1')?.map((entry) => entry.info.id)).toEqual(['child-1', 'child-2']);
  });

  it('toggles local ui helpers and persisted thinking preference', async () => {
    const stateModule = await loadState();

    expect(stateModule.composerFocusKey()).toBe(0);
    expect(stateModule.messageListScrollRequestKey()).toBe(0);
    expect(stateModule.showThinking()).toBe(true);

    stateModule.requestComposerFocus();
    stateModule.requestMessageListScrollToBottom();
    stateModule.toggleThinking();
    stateModule.resetPastedImageIndex();

    expect(stateModule.composerFocusKey()).toBe(1);
    expect(stateModule.messageListScrollRequestKey()).toBe(1);
    expect(stateModule.showThinking()).toBe(false);
    expect(stateModule.nextPastedImageIndex()).toBe(1);
    expect(window.localStorage.getItem('varro.showThinking')).toBe(JSON.stringify(false));
  });
});
