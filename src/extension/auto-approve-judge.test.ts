import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: { warn: vi.fn() },
}));

vi.mock('./logger', () => ({ logger: mocks.logger }));

import { AutoApproveJudge } from './auto-approve-judge';
import { HiddenSessionManager } from './hidden-session-manager';

describe('AutoApproveJudge', () => {
  it('allows workspace file edits without creating a judge session', async () => {
    const request = vi.fn();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => '/repo' } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: 'perm-edit',
          type: 'edit',
          sessionID: 'session-1',
          title: 'edit src/app.ts',
          metadata: {
            filepath: '/repo/src/app.ts',
            relativePath: 'src/app.ts',
            files: [{ filePath: '/repo/src/app.ts', relativePath: 'src/app.ts', type: 'update' }],
          },
        },
      })
    ).resolves.toEqual({ decision: 'allow', reason: 'Workspace file edit.' });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not locally allow edit permissions outside the workspace or file deletion', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        return { info: { structured_output: { decision: 'ask', reason: 'Needs user review.' } } };
      }
      if (method === 'DELETE' && path === '/session/judge-session-1') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => '/repo' } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: 'perm-outside',
          type: 'edit',
          sessionID: 'session-1',
          title: 'edit /tmp/file.ts',
          metadata: { filepath: '/tmp/file.ts' },
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    await expect(
      judge.judge({
        permission: {
          id: 'perm-delete',
          type: 'edit',
          sessionID: 'session-1',
          title: 'edit src/old.ts',
          metadata: { files: [{ filePath: '/repo/src/old.ts', type: 'delete' }] },
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it('allows safe local bash commands without creating a judge session', async () => {
    const request = vi.fn();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => '/repo' } as never,
      new HiddenSessionManager()
    );

    const permissions = [
      {
        id: 'perm-npm',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash rtk npm run test -- src/webview/components/PermissionPrompt.test.ts',
      },
      {
        id: 'perm-custom-npm',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash npm run preview:webview',
      },
      {
        id: 'perm-version',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash opencode --version',
      },
    ];

    for (const permission of permissions) {
      await expect(judge.judge({ permission })).resolves.toEqual({
        decision: 'allow',
        reason: 'Safe local command.',
      });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('does not locally allow chained local bash commands', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        return { info: { structured_output: { decision: 'ask', reason: 'Needs user review.' } } };
      }
      if (method === 'DELETE' && path === '/session/judge-session-1') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => '/repo' } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: 'perm-chained',
          type: 'bash',
          sessionID: 'session-1',
          title: 'bash opencode --version && rm -rf dist',
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it('asks without calling OpenCode when permission context is incomplete', async () => {
    const request = vi.fn();
    const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());

    await expect(
      judge.judge({
        permission: { id: 'perm-1', type: 'bash', sessionID: 'session-1', title: 'Run' },
      })
    ).resolves.toEqual({
      decision: 'ask',
      reason: 'Permission request lacks enough detail to judge safely.',
    });
    await expect(
      judge.judge({
        permission: { id: 'perm-2', type: 'bash', sessionID: 'session-1', title: 'bash' },
      })
    ).resolves.toEqual({
      decision: 'ask',
      reason: 'Permission request lacks enough detail to judge safely.',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('uses a hidden session and prefers small_model for structured judging', async () => {
    const hiddenSessions = new HiddenSessionManager();
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
      if (method === 'GET' && path === '/config') return { small_model: 'openai/gpt-5-mini' };
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        return {
          info: { structured_output: { decision: 'allow', reason: 'Read-only git status.' } },
          parts: [],
          body,
        };
      }
      if (method === 'DELETE' && path === '/session/judge-session-1') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge({ request } as never, hiddenSessions);

    const result = await judge.judge({
      permission: {
        id: 'perm-1',
        type: 'bash',
        sessionID: 'session-1',
        title: 'Run command: git status --short',
      },
      model: { providerID: 'openai', modelID: 'gpt-5' },
    });

    expect(result).toEqual({ decision: 'allow', reason: 'Read-only git status.' });
    expect(hiddenSessions.isHidden('judge-session-1')).toBe(true);
    expect(request).toHaveBeenCalledWith('POST', '/session', {
      title: 'Varro permission judge: perm-1',
      permission: expect.any(Array),
    });
    expect(request).toHaveBeenCalledWith(
      'POST',
      '/session/judge-session-1/message',
      expect.objectContaining({
        model: { providerID: 'openai', modelID: 'gpt-5-mini' },
        format: expect.objectContaining({ type: 'json_schema' }),
      })
    );
    expect(request).toHaveBeenCalledWith('DELETE', '/session/judge-session-1');
  });
});
