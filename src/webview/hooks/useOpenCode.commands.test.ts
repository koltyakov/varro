import { flush as flushSolid } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { describe, expect, it, vi } from 'vitest';
import type { client } from '../lib/client';
import {
  getClientMocks,
  loadModules,
  provider,
  session,
  userMessage,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();
type SessionSendAsync = typeof client.session.sendAsync;
const sessionSendAsync = vi.fn<SessionSendAsync>();
Object.assign(clientMocks, { sessionSendAsync });

describe('command helpers', () => {
  it('creates a sessions-list skill command in its captured workspace and opens it after acceptance', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setSessions([session('existing-session')]);
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'existing-session'));
    flushSolid();
    stateModule.setState(
      storePath('commands', [{ name: 'control', template: 'Check machines', source: 'skill' }])
    );
    flushSolid();
    clientMocks.sessionCreate.mockResolvedValue(session('created'));
    clientMocks.sessionGet.mockResolvedValue(session('created'));
    clientMocks.sessionMessages.mockResolvedValue([]);
    let accept!: () => void;
    clientMocks.sessionCommand.mockReturnValue(
      new Promise<void>((resolve) => {
        accept = resolve;
      })
    );
    const onAccepted = vi.fn();

    const operation = hookModule.runSlashCommandByName('control', 'check machines', {
      targetSessionId: null,
      newSessionWorkspace: { scope: 'folder', directory: '/repo-b' },
      onAccepted,
    });
    flushSolid();
    await vi.waitFor(() => expect(clientMocks.sessionCommand).toHaveBeenCalled());
    flushSolid();
    expect(clientMocks.sessionCreate.mock.calls[0]?.[1]).toEqual({ directory: '/repo-b' });
    expect(clientMocks.sessionCommand.mock.calls[0]?.[0]).toBe('created');
    expect(stateModule.state.activeSessionId).toBe('created');
    expect(onAccepted).not.toHaveBeenCalled();
    accept();
    flushSolid();

    expect(await operation).toBe(true);
    flushSolid();
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(stateModule.state.activeSessionId).toBe('created');
  });

  it('does not open the sessions-list command when the backend rejects it', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(
      storePath('commands', [{ name: 'control', template: 'Check machines', source: 'skill' }])
    );
    flushSolid();
    clientMocks.sessionCreate.mockResolvedValue(session('created'));
    clientMocks.sessionCommand.mockRejectedValue(new Error('Command failed'));
    const onAccepted = vi.fn();

    expect(
      await hookModule.runSlashCommandByName('control', 'check machines', {
        targetSessionId: null,
        onAccepted,
      })
    ).toBe(false);
    flushSolid();
    expect(onAccepted).not.toHaveBeenCalled();
    expect(stateModule.error()).toBe('Command failed');
  });

  it('accepts an asynchronous V2 command and reconciles its session without a response message', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(storePath('commands', [{ name: 'test', template: 'Run tests' }]));
    flushSolid();
    clientMocks.sessionCommand.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    expect(await hookModule.runSlashCommandByName('test', '--watch')).toBe(true);
    flushSolid();
    expect(stateModule.error()).toBeNull();
    expect(clientMocks.sessionGet).toHaveBeenCalled();
  });

  it('reconciles an uncertain command admission without replay or changing parent controls', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(storePath('selectedAgent', 'build'));
    flushSolid();
    stateModule.setState(
      storePath('selectedModel', { providerID: 'openai', modelID: 'parent-model' })
    );
    flushSolid();
    stateModule.setState(
      storePath('commands', [{ name: 'audit', template: '', source: 'command' }])
    );
    flushSolid();
    clientMocks.sessionCommand.mockRejectedValue(new Error('Connection lost after admission'));
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);
    expect(await hookModule.runSlashCommandByName('audit', 'src/auth "error handling"')).toBe(
      false
    );
    flushSolid();
    expect(clientMocks.sessionCommand).toHaveBeenCalledOnce();
    expect(clientMocks.sessionGet).toHaveBeenCalled();
    expect(clientMocks.sessionMessages).toHaveBeenCalled();
    expect(stateModule.state.activeSessionId).toBe('session-1');
    expect(stateModule.state.selectedAgent).toBe('build');
    expect(stateModule.state.selectedModel).toEqual({
      providerID: 'openai',
      modelID: 'parent-model',
    });
    expect(stateModule.error()).toBe('Connection lost after admission');
    expect(sessionSendAsync).not.toHaveBeenCalled();
  });

  it('runs custom slash commands against the session command API', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();

    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(
      storePath('commands', [
        {
          name: 'test',
          description: 'Run tests',
          template: 'Run tests',
        },
      ])
    );
    flushSolid();
    stateModule.setState(storePath('messages', [{ info: userMessage('user-1'), parts: [] }]));
    flushSolid();
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    const result = await hookModule.runSlashCommandByName('test', '--watch');
    flushSolid();

    expect(result).toBe(true);
    expect(clientMocks.sessionCommand).toHaveBeenCalledWith(
      'session-1',
      {
        command: 'test',
        arguments: '--watch',
      },
      { directory: undefined }
    );
  });

  it.each([false, true])(
    'passes picker routing as command defaults (command override: %s)',
    async (override) => {
      const { stateModule, hookModule } = await loadModules();
      flushSolid();
      stateModule.setState(storePath('activeSessionId', 'session-1'));
      flushSolid();
      stateModule.setState(storePath('selectedAgent', 'ask'));
      flushSolid();
      stateModule.setState(
        storePath('selectedModel', {
          providerID: 'openai',
          modelID: 'chosen-model',
          variant: 'low',
        })
      );
      flushSolid();
      stateModule.setState(
        storePath('commands', [
          override
            ? {
                name: 'inspect',
                template: 'Inspect this code',
                agent: 'reviewer',
                model: 'other/command-model',
              }
            : { name: 'inspect', template: 'Inspect this code' },
        ])
      );
      flushSolid();
      stateModule.setState(storePath('messages', [{ info: userMessage('user-1'), parts: [] }]));
      flushSolid();
      clientMocks.sessionGet.mockResolvedValue(session('session-1'));
      clientMocks.sessionMessages.mockResolvedValue([]);

      expect(await hookModule.runSlashCommandByName('inspect', '')).toBe(true);
      flushSolid();
      expect(clientMocks.sessionCommand.mock.calls.at(-1)?.[1]).toEqual({
        command: 'inspect',
        arguments: '',
        agent: 'ask',
        model: 'openai/chosen-model',
        variant: 'low',
      });
      // OpenCode applies command overrides before these request defaults.
      expect(stateModule.state.commands[0]?.agent).toBe(override ? 'reviewer' : undefined);
      expect(stateModule.state.commands[0]?.model).toBe(
        override ? 'other/command-model' : undefined
      );
    }
  );

  it.each([
    ['low', 'low'],
    ['high', 'high'],
    ['minimal', 'low'],
    ['default', undefined],
    [undefined, undefined],
  ])('sends a skill command with selected effort %s', async (selectedVariant, expectedVariant) => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(
      storePath('selectedModel', {
        providerID: 'openai',
        modelID: 'gpt-5.5',
        variant: selectedVariant,
      })
    );
    flushSolid();
    stateModule.setState(
      storePath('commands', [{ name: 'find-skills', template: '', source: 'skill' }])
    );
    flushSolid();
    clientMocks.sessionCommand.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    expect(await hookModule.runSlashCommandByName('find-skills', '')).toBe(true);
    flushSolid();

    const body = clientMocks.sessionCommand.mock.calls[0]?.[1];
    expect(body).toEqual({
      command: 'find-skills',
      arguments: '',
      model: 'openai/gpt-5.5',
      variant: expectedVariant,
    });
    if (!expectedVariant) expect(body).not.toHaveProperty('variant');
  });

  it('uses the session Default instead of the global or remembered reasoning variant', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();
    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    const model = { providerID: 'openai', modelID: 'gpt-5.5' };
    stateModule.setState(storePath('selectedModel', { ...model, variant: 'high' }));
    flushSolid();
    stateModule.setState(storePath('sessionSelectedModels', 'session-1', model));
    flushSolid();
    stateModule.setState(storePath('modelVariantSelections', { 'openai:gpt-5.5': 'high' }));
    flushSolid();
    stateModule.setState(
      storePath('commands', [{ name: 'find-skills', template: '', source: 'skill' }])
    );
    flushSolid();
    clientMocks.sessionCommand.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    expect(await hookModule.runSlashCommandByName('find-skills', '')).toBe(true);
    flushSolid();

    const body = clientMocks.sessionCommand.mock.calls[0]?.[1];
    expect(body).toMatchObject({ command: 'find-skills', model: 'openai/gpt-5.5' });
    expect(body).not.toHaveProperty('variant');
    expect(stateModule.state.modelVariantSelections['openai:gpt-5.5']).toBe('high');
  });

  it.each([false, true])(
    'captures blank-session command routing before creation (navigate: %s)',
    async (navigate) => {
      const { stateModule, hookModule } = await loadModules();
      flushSolid();
      stateModule.setState(storePath('activeSessionId', null));
      flushSolid();
      stateModule.setState(storePath('selectedAgent', 'ask'));
      flushSolid();
      stateModule.setState(
        storePath('selectedModel', {
          providerID: 'openai',
          modelID: 'chosen-model',
          variant: 'low',
        })
      );
      flushSolid();
      stateModule.setState(
        storePath('commands', [{ name: 'inspect', template: 'Inspect this code' }])
      );
      flushSolid();
      let finish!: (value: ReturnType<typeof session>) => void;
      clientMocks.sessionCreate.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      clientMocks.sessionGet.mockResolvedValue(session('created'));
      clientMocks.sessionMessages.mockResolvedValue([]);
      const operation = hookModule.runSlashCommandByName('inspect', 'files');
      flushSolid();
      if (navigate) {
        stateModule.setSessions([session('other')]);
        flushSolid();
        stateModule.setState(storePath('activeSessionId', 'other'));
        flushSolid();
        stateModule.setState(storePath('selectedAgent', 'build'));
        flushSolid();
        stateModule.setState(
          storePath('selectedModel', {
            providerID: 'other',
            modelID: 'other-model',
            variant: 'high',
          })
        );
        flushSolid();
        stateModule.startLoading();
        flushSolid();
      }
      flushSolid();
      finish(session('created'));
      await operation;
      flushSolid();
      expect(clientMocks.sessionCommand).toHaveBeenCalledWith(
        'created',
        {
          command: 'inspect',
          arguments: 'files',
          agent: 'ask',
          model: 'openai/chosen-model',
          variant: 'low',
        },
        { directory: '/repo' }
      );
      if (navigate) expect(stateModule.isLoading()).toBe(true);
    }
  );

  it('initializes a blank session by sending an AGENTS.md prompt', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();

    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(
      storePath('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            options: {},
            headers: {},
            limit: { context: 1, output: 1 },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            capabilities: {
              temperature: true,
              reasoning: true,
              attachment: true,
              toolcall: true,
              input: { text: true, audio: false, image: true, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
            },
            status: 'active',
            api: { id: 'openai', url: '', npm: '' },
          },
        }),
      ])
    );
    flushSolid();
    stateModule.setState(storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' }));
    flushSolid();
    stateModule.setState(storePath('messages', []));
    flushSolid();
    sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.initSession();
    flushSolid();

    expect(clientMocks.sessionInit).not.toHaveBeenCalled();
    expect(sessionSendAsync).toHaveBeenCalledTimes(1);
    const call = sessionSendAsync.mock.calls[0];
    if (!call) throw new Error('Expected sessionSendAsync to be called');
    const [calledSessionId, calledBody] = call;
    const firstPart = calledBody.parts[0];
    if (!firstPart) throw new Error('Expected init prompt part');
    expect(calledSessionId).toBe('session-1');
    expect(firstPart.text).toContain('AGENTS.md');
  });

  it('creates a new session before initializing when none is active', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();

    stateModule.setState(storePath('activeSessionId', null));
    flushSolid();
    stateModule.setState(
      storePath('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            options: {},
            headers: {},
            limit: { context: 1, output: 1 },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            capabilities: {
              temperature: true,
              reasoning: true,
              attachment: true,
              toolcall: true,
              input: { text: true, audio: false, image: true, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
            },
            status: 'active',
            api: { id: 'openai', url: '', npm: '' },
          },
        }),
      ])
    );
    flushSolid();
    stateModule.setState(storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' }));
    flushSolid();
    stateModule.setState(storePath('messages', []));
    flushSolid();
    clientMocks.sessionCreate.mockResolvedValue(session('session-2'));
    sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-2'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.initSession();
    flushSolid();

    expect(clientMocks.sessionCreate).toHaveBeenCalled();
    expect(clientMocks.sessionInit).not.toHaveBeenCalled();
    expect(sessionSendAsync).toHaveBeenCalledTimes(1);
    const call = sessionSendAsync.mock.calls[0];
    if (!call) throw new Error('Expected sessionSendAsync to be called');
    expect(call[0]).toBe('session-2');
  });

  it('does not initialize sessions that already contain messages', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();

    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    stateModule.setState(
      storePath('providers', [
        provider('openai', {
          'gpt-4o': {
            id: 'gpt-4o',
            name: 'GPT-4o',
            options: {},
            headers: {},
            limit: { context: 1, output: 1 },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            capabilities: {
              temperature: true,
              reasoning: true,
              attachment: true,
              toolcall: true,
              input: { text: true, audio: false, image: true, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
            },
            status: 'active',
            api: { id: 'openai', url: '', npm: '' },
          },
        }),
      ])
    );
    flushSolid();
    stateModule.setState(storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' }));
    flushSolid();
    stateModule.setState(storePath('messages', [{ info: userMessage('user-1'), parts: [] }]));
    flushSolid();

    await hookModule.initSession();
    flushSolid();

    expect(clientMocks.sessionInit).not.toHaveBeenCalled();
    expect(stateModule.error()).toBe('Init is only available for blank sessions');
  });

  it('redos through the session unrevert API', async () => {
    const { stateModule, hookModule } = await loadModules();
    flushSolid();

    stateModule.setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.redoSession();
    flushSolid();

    expect(clientMocks.sessionUnrevert).toHaveBeenCalledWith('session-1', {
      directory: undefined,
    });
  });
});
