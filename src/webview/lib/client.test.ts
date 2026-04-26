import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionMessage } from '../../shared/protocol';

const bridgeMocks = vi.hoisted(() => {
  const apiCall = vi.fn();
  const postMessage = vi.fn();
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const onMessage = vi.fn((handler: (msg: unknown) => void) => {
    messageHandlers.push(handler);
    return () => {
      const index = messageHandlers.indexOf(handler);
      if (index >= 0) messageHandlers.splice(index, 1);
    };
  });

  return { apiCall, postMessage, messageHandlers, onMessage };
});

vi.mock('./bridge', () => ({
  apiCall: bridgeMocks.apiCall,
  onMessage: bridgeMocks.onMessage,
  postMessage: bridgeMocks.postMessage,
}));

async function loadClient() {
  return import('./client');
}

function emitMessage(message: ExtensionMessage) {
  for (const handler of bridgeMocks.messageHandlers) handler(message);
}

beforeEach(() => {
  vi.resetModules();
  bridgeMocks.apiCall.mockReset();
  bridgeMocks.postMessage.mockReset();
  bridgeMocks.onMessage.mockClear();
  bridgeMocks.messageHandlers.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('client', () => {
  it('forwards health, session, config, agent, and question requests to the api bridge', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue(undefined);

    await client.health();
    await client.command.list();
    await client.session.list();
    await client.session.get('session-1');
    await client.session.update('session-1', { title: 'Renamed' });
    await client.session.delete('session-1');
    await client.session.abort('session-1');
    await client.session.init('session-1', {
      messageID: 'message-1',
      providerID: 'openai',
      modelID: 'gpt-4.1',
    });
    await client.session.diff('session-1');
    await client.session.diff('session-1', 'message-1');
    await client.session.status();
    await client.session.messages('session-1');
    await client.session.sendAsync('session-1', {
      parts: [{ type: 'text', text: 'Hello' }],
      model: { providerID: 'openai', modelID: 'gpt-4.1' },
      agent: 'build',
      noReply: true,
      variant: 'high',
    });
    await client.session.respondPermission('session-1', 'perm-1', 'always');
    await client.session.revert('session-1', 'message-1');
    await client.session.unrevert('session-1');
    await client.session.compact('session-1', { providerID: 'openai', modelID: 'gpt-4.1' });
    await client.session.command('session-1', {
      command: 'test',
      arguments: '--watch',
      agent: 'build',
      model: 'openai/gpt-4.1',
      messageID: 'message-1',
    });
    await client.config.providers();
    await client.agent.list();
    await client.question.list();
    await client.question.reply('question-1', [['Yes'], ['No']]);
    await client.question.reject('question-1');

    expect(bridgeMocks.apiCall.mock.calls).toEqual([
      ['GET', '/global/health'],
      ['GET', '/command'],
      ['GET', '/session'],
      ['GET', '/session/session-1'],
      ['PATCH', '/session/session-1', { title: 'Renamed' }],
      ['DELETE', '/session/session-1'],
      ['POST', '/session/session-1/abort'],
      [
        'POST',
        '/session/session-1/init',
        { messageID: 'message-1', providerID: 'openai', modelID: 'gpt-4.1' },
      ],
      ['GET', '/session/session-1/diff'],
      ['GET', '/session/session-1/diff?messageID=message-1'],
      ['GET', '/session/status'],
      ['GET', '/session/session-1/message'],
      [
        'POST',
        '/session/session-1/prompt_async',
        {
          parts: [{ type: 'text', text: 'Hello' }],
          model: { providerID: 'openai', modelID: 'gpt-4.1' },
          agent: 'build',
          noReply: true,
          variant: 'high',
        },
      ],
      ['POST', '/session/session-1/permissions/perm-1', { response: 'always' }],
      ['POST', '/session/session-1/revert', { messageID: 'message-1' }],
      ['POST', '/session/session-1/unrevert'],
      ['POST', '/session/session-1/summarize', { providerID: 'openai', modelID: 'gpt-4.1' }],
      [
        'POST',
        '/session/session-1/command',
        {
          command: 'test',
          arguments: '--watch',
          agent: 'build',
          model: 'openai/gpt-4.1',
          messageID: 'message-1',
        },
      ],
      ['GET', '/config/providers'],
      ['GET', '/agent'],
      ['GET', '/question'],
      ['POST', '/question/question-1/reply', { answers: [['Yes'], ['No']] }],
      ['POST', '/question/question-1/reject'],
    ]);
  });

  it('creates sessions with an empty body when none is provided', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({ id: 'session-1' });

    await client.session.create();

    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('POST', '/session', {});
  });

  it('builds provider limit query parameters only when a model is selected', async () => {
    const { client } = await loadClient();
    bridgeMocks.apiCall.mockResolvedValue({ status: 'available' });

    await client.config.providerLimit('openai');
    await client.config.providerLimit('openai', 'gpt-4.1');

    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(
      1,
      'GET',
      '/varro/provider-limit?providerID=openai'
    );
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(
      2,
      'GET',
      '/varro/provider-limit?providerID=openai&modelID=gpt-4.1'
    );
  });

  it('dedupes concurrent session status requests', async () => {
    const { client } = await loadClient();
    const deferred = Promise.resolve({ 'session-1': { type: 'idle' } });
    bridgeMocks.apiCall.mockReturnValue(deferred);

    const [first, second] = await Promise.all([client.session.status(), client.session.status()]);

    expect(first).toEqual({ 'session-1': { type: 'idle' } });
    expect(second).toEqual({ 'session-1': { type: 'idle' } });
    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('GET', '/session/status');
  });

  it('dedupes concurrent question list requests', async () => {
    const { client } = await loadClient();
    const deferred = Promise.resolve([{ id: 'q1' }]);
    bridgeMocks.apiCall.mockReturnValue(deferred);

    const [first, second] = await Promise.all([client.question.list(), client.question.list()]);

    expect(first).toEqual([{ id: 'q1' }]);
    expect(second).toEqual([{ id: 'q1' }]);
    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.apiCall).toHaveBeenCalledWith('GET', '/question');
  });

  it('caches file status requests for two seconds', async () => {
    const { client } = await loadClient();
    const nowSpy = vi.spyOn(Date, 'now');
    const response = [{ path: 'src/app.ts' }];

    nowSpy.mockReturnValueOnce(1_000);
    nowSpy.mockReturnValueOnce(1_500);
    nowSpy.mockReturnValueOnce(3_100);
    bridgeMocks.apiCall.mockResolvedValue(response);

    expect(await client.file.status()).toBe(response);
    expect(await client.file.status()).toBe(response);
    expect(await client.file.status()).toBe(response);

    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(1, 'GET', '/file/status');
    expect(bridgeMocks.apiCall).toHaveBeenNthCalledWith(2, 'GET', '/file/status');
  });

  it('clears the file status cache after a failed request', async () => {
    const { client } = await loadClient();

    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    bridgeMocks.apiCall.mockRejectedValueOnce(new Error('offline'));
    bridgeMocks.apiCall.mockResolvedValueOnce([]);

    await expect(client.file.status()).rejects.toThrow('offline');
    await expect(client.file.status()).resolves.toEqual([]);

    expect(bridgeMocks.apiCall).toHaveBeenCalledTimes(2);
  });

  it('delivers server events to specific and wildcard listeners', async () => {
    const { serverEvents } = await loadClient();
    const specific = vi.fn();
    const wildcard = vi.fn();
    const stopSpecific = serverEvents.on('session.updated', specific);
    serverEvents.on('*', wildcard);

    const message: ExtensionMessage = {
      type: 'server/event',
      payload: { type: 'session.updated' },
    };

    emitMessage(message);
    stopSpecific();
    emitMessage(message);

    expect(specific).toHaveBeenCalledTimes(1);
    expect(specific).toHaveBeenCalledWith(message.payload);
    expect(wildcard).toHaveBeenCalledTimes(2);
    expect(wildcard).toHaveBeenNthCalledWith(1, message.payload);
    expect(wildcard).toHaveBeenNthCalledWith(2, message.payload);
  });

  it('logs errors from server event handlers without aborting other listeners', async () => {
    const { serverEvents } = await loadClient();
    const healthy = vi.fn();

    serverEvents.on('session.updated', () => {
      throw new Error('specific boom');
    });
    serverEvents.on('session.updated', healthy);
    serverEvents.on('*', () => {
      throw new Error('wildcard boom');
    });

    emitMessage({
      type: 'server/event',
      payload: { type: 'session.updated' },
    });

    expect(healthy).toHaveBeenCalledTimes(1);
    expect(bridgeMocks.postMessage).toHaveBeenCalledTimes(2);
    expect(bridgeMocks.postMessage).toHaveBeenNthCalledWith(1, {
      type: 'log',
      payload: {
        msg: 'event handler error',
        error: 'Error: specific boom',
        level: 'error',
      },
    });
    expect(bridgeMocks.postMessage).toHaveBeenNthCalledWith(2, {
      type: 'log',
      payload: {
        msg: 'wildcard handler error',
        error: 'Error: wildcard boom',
        level: 'error',
      },
    });
  });

  it('ignores non-server messages for event listeners', async () => {
    const { serverEvents } = await loadClient();
    const listener = vi.fn();

    serverEvents.on('*', listener);
    emitMessage({ type: 'command/abort' });

    expect(listener).not.toHaveBeenCalled();
    expect(bridgeMocks.postMessage).not.toHaveBeenCalled();
  });
});
