import { describe, expect, it, vi } from 'vitest';
import type { ShellInfo } from '@opencode/client';
import { BackgroundProcessJudge } from './background-process-judge';

const shell: ShellInfo = {
  id: 'sh_server',
  status: 'running',
  command: 'python3 tools/serve.py 18765',
  cwd: '/repo',
  shell: '/bin/zsh',
  file: '/output',
  metadata: { sessionID: 'ses_one' },
  time: { started: 1 },
};
const specification = { paths: { '/api/experimental/generate': { post: {} } } };

describe('background process model judgment', () => {
  it.each([true, false])(
    'uses the owning model and a tool-free request for blocking=%s',
    async (blocking) => {
      const request = vi.fn(async (_method: string, path: string) =>
        path.startsWith('/api/session/')
          ? {
              data: {
                model: { providerID: 'openai', id: 'current-model', variant: 'low' },
                title: 'Preview server',
              },
            }
          : path === '/openapi.json'
            ? specification
            : { data: { text: JSON.stringify({ blocking }) } }
      );
      const judge = new BackgroundProcessJudge(request);
      expect(await judge.classify(shell, '/repo', new AbortController().signal)).toBe(!blocking);
      expect(request).toHaveBeenLastCalledWith(
        'POST',
        '/api/experimental/generate',
        {
          model: { providerID: 'openai', id: 'current-model', variant: 'low' },
          prompt: expect.stringContaining(shell.command),
        },
        { directory: '/repo', signal: expect.any(AbortSignal) }
      );
      expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
        ['GET', '/api/session/ses_one'],
        ['GET', '/openapi.json'],
        ['POST', '/api/experimental/generate'],
      ]);
    }
  );

  it('does not generate without an identified session model', async () => {
    const request = vi.fn(async () => ({ data: {} }));
    expect(
      await new BackgroundProcessJudge(request).classify(
        shell,
        '/repo',
        new AbortController().signal
      )
    ).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['{}', '{"blocking":"false"}'])(
    'leaves malformed boolean verdict %s undecided',
    async (text) => {
      const request = vi.fn(async (_method: string, path: string) =>
        path.startsWith('/api/session/')
          ? { data: { model: { providerID: 'openai', id: 'current-model' } } }
          : path === '/openapi.json'
            ? specification
            : { data: { text } }
      );
      expect(
        await new BackgroundProcessJudge(request).classify(
          shell,
          '/repo',
          new AbortController().signal
        )
      ).toBeNull();
    }
  );

  it('does not start generation after cancellation', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      return { data: { model: { providerID: 'openai', id: 'current-model' } } };
    });
    await expect(
      new BackgroundProcessJudge(request).classify(shell, '/repo', controller.signal)
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
