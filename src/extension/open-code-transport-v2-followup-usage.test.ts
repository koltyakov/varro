/* oxlint-disable anti-slop/no-module-mocking -- Exercise the native route without a VS Code logging host. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessageInfo } from '@opencode/client';
import { OpenCodeTransport } from './open-code-transport';

vi.mock('./logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

afterEach(() => vi.unstubAllGlobals());

const step = (id: string, input: number): SessionMessageInfo => ({
  id,
  type: 'assistant',
  agent: 'build',
  model: { providerID: 'openai', id: 'model' },
  time: { created: 0, completed: 1 },
  content: [{ type: 'text', text: 'body that must not leave the extension' }],
  tokens: { input, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0.1,
});
const user = (id: string): SessionMessageInfo => ({
  id,
  type: 'user',
  text: 'prompt',
  time: { created: 0 },
});

describe('v2 follow-up usage route', () => {
  it('pages native history until an empty page and returns only the summary', async () => {
    // Newest first. The last non-empty page still carries a next cursor.
    const pages = {
      first: [step('msg_step2', 20), user('msg_c'), user('msg_b')],
      older: [step('msg_step1', 10), user('msg_a')],
      oldest: [],
    } satisfies Record<string, SessionMessageInfo[]>;
    const requests: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === '/global/health')
          return Response.json({ healthy: true, version: '2.3.2' });
        requests.push(url.pathname + url.search);
        if (url.pathname.endsWith('/inbox'))
          return Response.json({ data: [{ id: 'msg_queued', type: 'user' }] });
        if (url.pathname.endsWith('/message')) {
          const cursor = url.searchParams.get('cursor');
          const page = cursor === 'older' ? 'older' : cursor === 'oldest' ? 'oldest' : 'first';
          const next = page === 'first' ? 'older' : 'oldest';
          return Response.json({ data: pages[page], cursor: { next } });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      })
    );
    const transport = new OpenCodeTransport({
      getUrl: () => 'http://localhost:4096',
      getWorkspaceCwd: () => undefined,
      getStatus: () => ({ state: 'running', url: 'http://localhost:4096', eventStream: 'healthy' }),
      isDisposing: () => false,
      updateEventStreamState: vi.fn(),
      emitEvent: vi.fn(),
    });
    expect(await transport.checkHealth()).toBe(true);

    const result = await transport.request('GET', '/session/ses_child/followup-usage', undefined, {
      maxResponseBytes: 1024 * 1024,
    });

    expect(result).toEqual({
      supported: true,
      complete: true,
      pendingPromptIDs: ['msg_queued'],
      intervals: [
        expect.objectContaining({ promptIDs: ['msg_a'], final: true }),
        expect.objectContaining({ promptIDs: ['msg_b', 'msg_c'], final: false }),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('body that must not leave');
    expect(requests).toEqual([
      '/api/session/ses_child/inbox',
      '/api/session/ses_child/message?limit=200&order=desc',
      '/api/session/ses_child/message?limit=200&cursor=older',
      '/api/session/ses_child/message?limit=200&cursor=oldest',
    ]);
  });
});
