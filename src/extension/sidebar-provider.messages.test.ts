import { describe, expect, it, vi } from 'vitest';
import {
  attachTestView,
  createServer,
  createSidebarProviderInstance,
} from './sidebar-provider.test-support';

describe('SidebarProvider session message responses', () => {
  it('filters malformed session message entries and parts from API responses', async () => {
    const server = createServer({
      request: vi.fn(async () => [
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
      ]),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const { posted } = attachTestView(provider);

    await provider.handleMessage({
      type: 'api/request',
      payload: { id: 1, method: 'GET', path: '/session/session-1/message' },
    });

    expect(server.request).toHaveBeenCalledWith('GET', '/session/session-1/message', undefined);
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
