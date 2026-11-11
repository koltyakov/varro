import { describe, expect, it, vi } from 'vitest';
import type { ShellInfo } from '@opencode/client';
import { BackgroundProcessJudge } from './background-process-judge';
import * as extensionConfig from './extension-config';
import { configurePromptTrace } from './prompt-trace';

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
  it('traces the owning conversation and shell request', async () => {
    const trace = vi.spyOn(extensionConfig, 'readPromptTrace').mockReturnValue(true);
    configurePromptTrace(extensionConfig.readPromptTrace);
    const request = vi.fn(async (_method: string, path: string) => {
      if (path === '/api/session/ses_one')
        return { data: { model: { providerID: 'test', id: 'small' } } };
      if (path === '/session/ses_one') return { id: 'ses_one' };
      if (path === '/openapi.json') return specification;
      return { data: { text: '{"blocking":false}' } };
    });
    try {
      expect(
        await new BackgroundProcessJudge(request).classify(
          shell,
          '/repo',
          new AbortController().signal
        )
      ).toBe(true);
      expect(request).toHaveBeenLastCalledWith(
        'POST',
        '/api/experimental/generate',
        expect.objectContaining({
          prompt: expect.stringMatching(
            /^VARRO_TRACE_V1 \{"purpose":"background-process-judge","sessionID":"ses_one","rootSessionID":"ses_one","requestID":"sh_server"\}\n/
          ),
        }),
        expect.any(Object)
      );
    } finally {
      trace.mockRestore();
      configurePromptTrace(() => false);
    }
  });

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

  it.each([
    '{}',
    '{"blocking":"false"}',
    '',
    '{"blocking":false',
    'Here is the verdict: {"blocking":false}',
    '```json\n{"blocking":false}\n```',
    'null',
    'false',
    '[{"blocking":false}]',
  ])('leaves invalid verdict %s undecided', async (text) => {
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
  });

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
