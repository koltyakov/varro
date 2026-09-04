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
  it('runs custom slash commands against the session command API', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('commands', [
      {
        name: 'test',
        description: 'Run tests',
        template: 'Run tests',
      },
    ]);
    stateModule.setState('messages', [{ info: userMessage('user-1'), parts: [] }]);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    const result = await hookModule.runSlashCommandByName('test', '--watch');

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
      stateModule.setState('activeSessionId', 'session-1');
      stateModule.setState('selectedAgent', 'ask');
      stateModule.setState('selectedModel', { providerID: 'openai', modelID: 'chosen-model' });
      stateModule.setState('commands', [
        override
          ? {
              name: 'inspect',
              template: 'Inspect this code',
              agent: 'reviewer',
              model: 'other/command-model',
            }
          : { name: 'inspect', template: 'Inspect this code' },
      ]);
      stateModule.setState('messages', [{ info: userMessage('user-1'), parts: [] }]);
      clientMocks.sessionGet.mockResolvedValue(session('session-1'));
      clientMocks.sessionMessages.mockResolvedValue([]);

      expect(await hookModule.runSlashCommandByName('inspect', '')).toBe(true);
      expect(clientMocks.sessionCommand.mock.calls.at(-1)?.[1]).toEqual({
        command: 'inspect',
        arguments: '',
        agent: 'ask',
        model: 'openai/chosen-model',
      });
      // OpenCode applies command overrides before these request defaults.
      expect(stateModule.state.commands[0]?.agent).toBe(override ? 'reviewer' : undefined);
      expect(stateModule.state.commands[0]?.model).toBe(
        override ? 'other/command-model' : undefined
      );
    }
  );

  it.each([false, true])(
    'captures blank-session command routing before creation (navigate: %s)',
    async (navigate) => {
      const { stateModule, hookModule } = await loadModules();
      stateModule.setState('activeSessionId', null);
      stateModule.setState('selectedAgent', 'ask');
      stateModule.setState('selectedModel', { providerID: 'openai', modelID: 'chosen-model' });
      stateModule.setState('commands', [{ name: 'inspect', template: 'Inspect this code' }]);
      let finish!: (value: ReturnType<typeof session>) => void;
      clientMocks.sessionCreate.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        })
      );
      clientMocks.sessionGet.mockResolvedValue(session('created'));
      clientMocks.sessionMessages.mockResolvedValue([]);
      const operation = hookModule.runSlashCommandByName('inspect', 'files');
      if (navigate) {
        stateModule.setSessions([session('other')]);
        stateModule.setState('activeSessionId', 'other');
        stateModule.setState('selectedAgent', 'build');
        stateModule.setState('selectedModel', { providerID: 'other', modelID: 'other-model' });
        stateModule.startLoading();
      }
      finish(session('created'));
      await operation;
      expect(clientMocks.sessionCommand).toHaveBeenCalledWith(
        'created',
        {
          command: 'inspect',
          arguments: 'files',
          agent: 'ask',
          model: 'openai/chosen-model',
        },
        { directory: '/repo' }
      );
      if (navigate) expect(stateModule.isLoading()).toBe(true);
    }
  );

  it('initializes a blank session by sending an AGENTS.md prompt', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
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
    ]);
    stateModule.setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('messages', []);
    sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.initSession();

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

    stateModule.setState('activeSessionId', null);
    stateModule.setState('providers', [
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
    ]);
    stateModule.setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('messages', []);
    clientMocks.sessionCreate.mockResolvedValue(session('session-2'));
    sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-2'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.initSession();

    expect(clientMocks.sessionCreate).toHaveBeenCalled();
    expect(clientMocks.sessionInit).not.toHaveBeenCalled();
    expect(sessionSendAsync).toHaveBeenCalledTimes(1);
    const call = sessionSendAsync.mock.calls[0];
    if (!call) throw new Error('Expected sessionSendAsync to be called');
    expect(call[0]).toBe('session-2');
  });

  it('does not initialize sessions that already contain messages', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    stateModule.setState('providers', [
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
    ]);
    stateModule.setState('selectedModel', { providerID: 'openai', modelID: 'gpt-4o' });
    stateModule.setState('messages', [{ info: userMessage('user-1'), parts: [] }]);

    await hookModule.initSession();

    expect(clientMocks.sessionInit).not.toHaveBeenCalled();
    expect(stateModule.error()).toBe('Init is only available for blank sessions');
  });

  it('redos through the session unrevert API', async () => {
    const { stateModule, hookModule } = await loadModules();

    stateModule.setState('activeSessionId', 'session-1');
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.redoSession();

    expect(clientMocks.sessionUnrevert).toHaveBeenCalledWith('session-1', {
      directory: undefined,
    });
  });
});
