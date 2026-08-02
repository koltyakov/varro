import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

describe('SidebarProvider session message responses', () => {
  it('posts pending deltas before a canonical message API response', async () => {
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/session-1?directory=%2Frepo'
          ? { id: 'session-1', directory: '/repo' }
          : []
      ),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);
    const eventHandler = server.on.mock.calls.find(([event]) => event === 'event')?.[1];

    eventHandler?.({
      type: 'message.part.delta',
      properties: {
        sessionID: 'session-1',
        messageID: 'message-1',
        partID: 'part-1',
        field: 'text',
        delta: 'late',
      },
    });
    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: '/session/session-1/message' },
    });

    expect(posted.map((message) => (message as { type: string }).type)).toEqual([
      'server/event',
      'api/response',
    ]);
  });

  it('filters malformed session message entries and parts from API responses', async () => {
    const messages = [
      {
        info: {
          id: 'message-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 1 },
          parentID: 'user-1',
          modelID: 'gpt-4.1',
          providerID: 'openai',
          mode: 'default',
          path: { cwd: '/repo', root: '/repo' },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            id: 'part-1',
            sessionID: 'session-1',
            messageID: 'message-1',
            type: 'text',
            text: 'Hello',
          },
          {
            id: 'broken-part',
            sessionID: 'session-1',
            type: 'text',
            text: 'missing message id',
          },
        ],
      },
      {
        parts: [],
      },
      {
        info: {
          id: 'message-2',
          sessionID: 'session-1',
          role: 'user',
          time: { created: 2 },
          agent: 'build',
          model: { providerID: 'openai', modelID: 'gpt-4.1' },
        },
        parts: 'invalid-parts',
      },
    ];
    const server = createServer({
      request: vi.fn(async (_method: string, path: string) =>
        path === '/session/session-1?directory=%2Frepo'
          ? { id: 'session-1', directory: '/repo' }
          : messages
      ),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: '/session/session-1/message' },
    });

    expect(server.request.mock.calls).toEqual([
      ['GET', '/session/session-1?directory=%2Frepo'],
      ['GET', '/session/session-1/message', undefined],
    ]);
    expect(posted).toContainEqual({
      type: 'api/response',
      payload: {
        id: 1,
        data: [
          {
            info: expect.objectContaining({ id: 'message-1' }),
            parts: [
              expect.objectContaining({ id: 'part-1', messageID: 'message-1', type: 'text' }),
            ],
          },
          {
            info: expect.objectContaining({ id: 'message-2' }),
            parts: [],
          },
        ],
      },
    });
  });
});

function runInTerminal(provider: object, command: string, title?: string) {
  return (
    provider as unknown as {
      runInTerminal: (command: string, title?: string) => Promise<void>;
    }
  ).runInTerminal(command, title);
}

describe('SidebarProvider terminal commands', () => {
  it('releases the binary before running an install or update command', async () => {
    // Windows cannot overwrite a running opencode.exe, so the one-click update
    // needs the same prerequisite as Varro's own upgrade path.
    const server = createServer();
    const { provider } = await createSidebarProviderInstance({ server });
    attachTestView(provider);

    await runInTerminal(provider, 'npm install -g opencode-ai@latest', 'OpenCode Update');
    expect(server.prepareForWindowsCliUpgrade).toHaveBeenCalledOnce();

    await runInTerminal(provider, 'npm i -g opencode-ai', 'OpenCode Install');
    expect(server.prepareForWindowsCliUpgrade).toHaveBeenCalledTimes(2);
  });

  it('keeps a Windows update reserved until its terminal closes', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const server = createServer();
      const { provider } = await createSidebarProviderInstance({ server });
      attachTestView(provider);

      await runInTerminal(provider, 'npm install -g opencode-ai@latest', 'OpenCode Update');

      const terminal = getVscodeMock().window.createTerminal.mock.results[0]?.value;
      const onDidCloseTerminal = getVscodeMock().window.onDidCloseTerminal as Mock<
        (listener: (terminal: object) => void) => { dispose(): void }
      >;
      const closeListener = onDidCloseTerminal.mock.calls[0]?.[0];
      expect(closeListener).toBeTypeOf('function');
      expect(server.finishWindowsCliUpgrade).not.toHaveBeenCalled();

      if (terminal) closeListener?.(terminal);

      expect(server.finishWindowsCliUpgrade).toHaveBeenCalledOnce();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
      });
    }
  });

  it('leaves the server alone for commands that do not touch the binary', async () => {
    const server = createServer();
    const { provider } = await createSidebarProviderInstance({ server });
    attachTestView(provider);

    await runInTerminal(provider, 'opencode auth login', 'OpenCode Auth');

    expect(server.prepareForWindowsCliUpgrade).not.toHaveBeenCalled();
  });

  it('does not open a terminal when the server cannot be stopped safely', async () => {
    const server = createServer({
      prepareForWindowsCliUpgrade: vi.fn(() => Promise.reject(new Error('active sessions'))),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    attachTestView(provider);

    await expect(
      runInTerminal(provider, 'npm install -g opencode-ai@latest', 'OpenCode Update')
    ).rejects.toThrow('active sessions');

    expect(getVscodeMock().window.createTerminal).not.toHaveBeenCalled();
  });
});
