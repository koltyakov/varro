import { describe, expect, it } from 'vitest';
import {
  getClientMocks,
  loadModules,
  provider,
  session,
  userMessage,
} from './useOpenCode.test-support';

const clientMocks = getClientMocks();

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
    expect(clientMocks.sessionCommand).toHaveBeenCalledWith('session-1', {
      command: 'test',
      arguments: '--watch',
    });
  });

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
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-1'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.initSession();

    expect(clientMocks.sessionInit).not.toHaveBeenCalled();
    expect(clientMocks.sessionSendAsync).toHaveBeenCalledTimes(1);
    const [calledSessionId, calledBody] = clientMocks.sessionSendAsync.mock.calls[0];
    expect(calledSessionId).toBe('session-1');
    expect(calledBody.parts[0].text).toContain('AGENTS.md');
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
    clientMocks.sessionSendAsync.mockResolvedValue(undefined);
    clientMocks.sessionGet.mockResolvedValue(session('session-2'));
    clientMocks.sessionMessages.mockResolvedValue([]);

    await hookModule.initSession();

    expect(clientMocks.sessionCreate).toHaveBeenCalled();
    expect(clientMocks.sessionInit).not.toHaveBeenCalled();
    expect(clientMocks.sessionSendAsync).toHaveBeenCalledTimes(1);
    expect(clientMocks.sessionSendAsync.mock.calls[0][0]).toBe('session-2');
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

    expect(clientMocks.sessionUnrevert).toHaveBeenCalledWith('session-1');
  });
});
