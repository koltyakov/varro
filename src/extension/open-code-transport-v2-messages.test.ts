/* oxlint-disable anti-slop/no-module-mocking -- Exercise HTTP projection without a VS Code logging host. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessageInfo } from '@opencode/client';
import { OpenCodeTransport } from './open-code-transport';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

afterEach(() => vi.unstubAllGlobals());

describe('v2 message response budgets', () => {
  const screenshot = `data:image/png;base64,${'x'.repeat(10_000)}`;
  const messages: SessionMessageInfo[] = [
    {
      id: 'msg_assistant',
      type: 'assistant',
      agent: 'build',
      model: { providerID: 'openai', id: 'model' },
      time: { created: 2, completed: 3 },
      content: [
        { type: 'text', text: 'Screenshot reviewed.' },
        {
          id: 'tool_capture',
          type: 'tool',
          name: 'capture',
          time: { created: 2, completed: 3 },
          state: {
            status: 'completed',
            input: { target: 'editor' },
            content: [
              { type: 'text', text: 'Captured editor' },
              { type: 'file', uri: screenshot, mime: 'image/png' },
            ],
            metadata: { title: 'Editor screenshot' },
          },
        },
      ],
    },
    {
      id: 'msg_user',
      type: 'user',
      text: 'Review this image',
      time: { created: 1 },
      files: [{ mime: 'image/png', data: '', source: { type: 'uri', uri: 'file:///prompt.png' } }],
    },
  ];

  async function transport() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path === '/global/health') return Response.json({ healthy: true, version: '2.0.18' });
        if (path.endsWith('/inbox')) return Response.json({ data: [] });
        if (path.endsWith('/message'))
          return Response.json({ data: messages, cursor: { next: 'older' } });
        throw new Error(`Unexpected request: ${path}`);
      })
    );
    const result = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => undefined,
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: vi.fn(),
      emitEvent: vi.fn(),
    });
    expect(await result.checkHealth()).toBe(true);
    return result;
  }

  const options = {
    captureNextCursor: true,
    maxResponseBytes: 64 * 1024,
    maxProjectedResponseBytes: 16 * 1024,
    stripSummaryDiffs: true,
  };

  it('loads screenshot history without duplicating native tool content', async () => {
    const client = await transport();
    const result = await client.request(
      'GET',
      '/session/ses_one/message?limit=2',
      undefined,
      options
    );
    expect(result).toMatchObject({
      nextCursor: 'older',
      data: [
        { info: { id: 'msg_user' } },
        {
          info: { id: 'msg_assistant', parentID: 'msg_user' },
          parts: [
            { text: 'Screenshot reviewed.' },
            { state: { output: 'Captured editor', attachments: [{ url: screenshot }] } },
          ],
        },
      ],
    });
    expect(JSON.stringify(result).split(screenshot)).toHaveLength(2);
  });

  it('retries above-budget native screenshots without losing text, user files, or the cursor', async () => {
    const client = await transport();
    const budget = { ...options, maxProjectedResponseBytes: 2048 };
    await expect(
      client.request('GET', '/session/ses_one/message?limit=2', undefined, budget)
    ).rejects.toThrow('2048-byte safety limit');
    await expect(
      client.request('GET', '/session/ses_one/message?limit=2', undefined, {
        ...budget,
        stripToolAttachments: true,
      })
    ).resolves.toMatchObject({
      nextCursor: 'older',
      data: [
        { parts: [{ text: 'Review this image' }, { type: 'file', url: 'file:///prompt.png' }] },
        {
          parts: [
            { text: 'Screenshot reviewed.' },
            {
              id: 'tool_capture',
              state: {
                input: { target: 'editor' },
                output: 'Captured editor',
                metadata: { title: 'Editor screenshot' },
                attachments: [],
              },
            },
          ],
        },
      ],
    });
  });

  it('still enforces the raw response limit during attachment fallback', async () => {
    const client = await transport();
    await expect(
      client.request('GET', '/session/ses_one/message?limit=2', undefined, {
        ...options,
        maxResponseBytes: 4096,
        stripToolAttachments: true,
      })
    ).rejects.toThrow('4096-byte safety limit');
  });
});
