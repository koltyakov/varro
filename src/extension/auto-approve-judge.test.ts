import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PermissionRule } from '../shared/opencode-types';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('./logger', () => ({ logger: mocks.logger }));

import { AutoApproveJudge } from './auto-approve-judge';
import { HiddenSessionManager } from './hidden-session-manager';

const cargoBuildPermission = (id: string) => ({
  id,
  type: 'bash',
  sessionID: 'session-1',
  title: 'Run command: cargo build',
  metadata: { command: 'cargo build' },
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createTemporaryWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'varro-auto-approve-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  temporaryDirectories.push(root);
  return { root, workspace };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAskJudgeRequest() {
  return vi.fn(async (method: string, path: string) => {
    if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
    if (method === 'GET' && path === '/config') return {};
    if (method === 'POST' && path === '/session/judge-session-1/message') {
      return { info: { structured_output: { decision: 'ask', reason: 'Needs user review.' } } };
    }
    if (method === 'DELETE' && path === '/session/judge-session-1') return true;
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
}

function resolveToolAction(rules: PermissionRule[], tool: string) {
  return rules.findLast((rule) => rule.permission === '*' || rule.permission === tool)?.action;
}

describe('AutoApproveJudge', () => {
  it('allows workspace file edits without creating a judge session', async () => {
    const { workspace } = createTemporaryWorkspace();
    const filePath = join(workspace, 'src', 'app.ts');
    const request = vi.fn();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
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
            filepath: filePath,
            relativePath: 'src/app.ts',
            files: [{ filePath, relativePath: 'src/app.ts', type: 'update' }],
          },
        },
      })
    ).resolves.toEqual({ decision: 'allow', reason: 'Workspace file edit.' });
    expect(request).not.toHaveBeenCalled();
  });

  it('does not locally allow edit permissions outside the workspace or file deletion', async () => {
    const { root, workspace } = createTemporaryWorkspace();
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: 'perm-outside',
          type: 'edit',
          sessionID: 'session-1',
          title: 'edit outside.ts',
          metadata: { filepath: join(root, 'outside.ts') },
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
          metadata: { files: [{ filePath: join(workspace, 'src', 'old.ts'), type: 'delete' }] },
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it('does not locally allow relative edit paths that escape the workspace', async () => {
    const { workspace } = createTemporaryWorkspace();
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: 'perm-traversal',
          type: 'edit',
          sessionID: 'session-1',
          title: 'edit src/../../etc/passwd',
          metadata: { relativePath: 'src/../../etc/passwd' },
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it('still locally allows relative edit paths that stay inside the workspace', async () => {
    const { workspace } = createTemporaryWorkspace();
    const request = vi.fn();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: 'perm-nested',
          type: 'edit',
          sessionID: 'session-1',
          title: 'edit src/app.ts',
          metadata: { relativePath: 'src/features/../app.ts' },
        },
      })
    ).resolves.toEqual({ decision: 'allow', reason: 'Workspace file edit.' });
    expect(request).not.toHaveBeenCalled();
  });

  it('allows safe local bash commands without creating a judge session', async () => {
    const { workspace } = createTemporaryWorkspace();
    mkdirSync(join(workspace, 'tmp', 'opencode'), { recursive: true });
    const request = vi.fn();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    const permissions = [
      {
        id: 'perm-git-status',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash rtk git status --short',
      },
      {
        id: 'perm-git-status-log',
        type: 'bash',
        sessionID: 'session-1',
        title:
          'bash rtk git -C "tmp/opencode" status --short && rtk git -C "tmp/opencode" log --oneline -10',
      },
      {
        id: 'perm-git-diff',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash rtk git diff -- src/extension/auto-approve-judge.ts',
      },
      {
        id: 'perm-git-diff-pathspecs',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash git diff -- src/app.ts src/lib.ts',
      },
      {
        id: 'perm-git-diff-revision',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash git diff HEAD~1 -- src/app.ts',
      },
      {
        id: 'perm-git-rev-parse-branch',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash git rev-parse --show-toplevel && git branch --show-current',
      },
      {
        id: 'perm-pwd-which',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash pwd && command -v npm',
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

  it.each([
    ['outside operand', 'git diff --no-index src/app.ts /etc/hosts'],
    ['quoted flag', 'git diff "--no-index" src/app.ts /etc/hosts'],
    ['ANSI-C quoted flag', "git diff $'--no-index' src/app.ts /etc/hosts"],
    ['escaped flag', 'git diff --no\\-index src/app.ts /etc/hosts'],
    ['reversed operands', 'git diff --no-index /etc/hosts src/app.ts'],
    ['option separator', 'git diff --no-index -- src/app.ts /etc/hosts'],
    ['relative escape', 'git diff --no-index src/app.ts src/../../outside.ts'],
    ['git -C', 'git -C nested diff --no-index app.ts ../../outside.ts'],
  ])('does not locally allow git diff --no-index with %s', async (_case, command) => {
    const { workspace } = createTemporaryWorkspace();
    mkdirSync(join(workspace, 'nested'));
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: `perm-${_case}`,
          type: 'bash',
          sessionID: 'session-1',
          title: `bash ${command}`,
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it.each([
    ['absolute operands', 'git diff /dev/null /etc/hosts'],
    ['quoted absolute operands', 'git diff "/dev/null" "/etc/hosts"'],
    ['reversed operands', 'git diff /etc/hosts /dev/null'],
    ['option separator', 'git diff -- /dev/null /etc/hosts'],
    ['relative escapes', 'git diff ../outside-one ../outside-two'],
    ['home expansion', 'git diff src/app.ts ~/outside-file'],
    ['git -C', 'git -C nested diff /dev/null ../../outside.ts'],
  ])('does not locally allow implicit git diff no-index mode with %s', async (_case, command) => {
    const { workspace } = createTemporaryWorkspace();
    mkdirSync(join(workspace, 'nested'));
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: `perm-implicit-${_case}`,
          type: 'bash',
          sessionID: 'session-1',
          title: `bash ${command}`,
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it.each([
    ['semicolon', 'git status; pwd'],
    ['pipe', 'git status | cat'],
    ['input redirection', 'git diff < /etc/hosts'],
    ['output redirection', 'git diff > /tmp/diff.patch'],
    ['command substitution', 'git diff $(pwd)'],
  ])('does not locally allow shell commands containing %s', async (_case, command) => {
    const { workspace } = createTemporaryWorkspace();
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: `perm-shell-${_case}`,
          type: 'bash',
          sessionID: 'session-1',
          title: `bash ${command}`,
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it('defers arbitrary npm scripts and executable version commands to the judge', async () => {
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => '/repo' } as never,
      new HiddenSessionManager()
    );

    for (const permission of [
      {
        id: 'perm-npm',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash npm run project-defined-script',
      },
      {
        id: 'perm-version',
        type: 'bash',
        sessionID: 'session-1',
        title: 'bash ./project-defined-tool --version',
      },
    ]) {
      await expect(judge.judge({ permission })).resolves.toEqual({
        decision: 'ask',
        reason: 'Needs user review.',
      });
    }

    expect(
      request.mock.calls.filter(([method, path]) => method === 'POST' && path === '/session')
    ).toHaveLength(2);
  });

  it('does not locally allow git -C outside the canonical workspace', async () => {
    const { root, workspace } = createTemporaryWorkspace();
    const outside = join(root, 'outside');
    const linkedOutside = join(workspace, 'linked-outside');
    mkdirSync(outside);
    symlinkSync(outside, linkedOutside, process.platform === 'win32' ? 'junction' : 'dir');
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    for (const [id, directory] of [
      ['perm-external-git', outside],
      ['perm-symlinked-external-git', linkedOutside],
    ]) {
      await expect(
        judge.judge({
          permission: {
            id,
            type: 'bash',
            sessionID: 'session-1',
            title: `bash git -C "${directory}" status --short`,
          },
        })
      ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    }
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it('defers backslash git -C paths even when the host reports Windows', async () => {
    const { workspace } = createTemporaryWorkspace();
    mkdirSync(join(workspace, 'tmp\\opencode'), { recursive: true });
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      await expect(
        judge.judge({
          permission: {
            id: 'perm-native-backslash-git',
            type: 'bash',
            sessionID: 'session-1',
            title: 'bash git -C "tmp\\opencode" status --short',
          },
        })
      ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }

    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it('does not locally allow new files through a symlink outside the workspace', async () => {
    const { root, workspace } = createTemporaryWorkspace();
    const outside = join(root, 'outside');
    const linkedDirectory = join(workspace, 'linked');
    mkdirSync(outside);
    symlinkSync(outside, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: 'perm-symlink-escape',
          type: 'edit',
          sessionID: 'session-1',
          title: 'edit linked/new-file.ts',
          metadata: { filepath: join(linkedDirectory, 'new-file.ts') },
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
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

  it('does not locally allow chained git commands with unsafe segments', async () => {
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
          id: 'perm-unsafe-git-chain',
          type: 'bash',
          sessionID: 'session-1',
          title: 'bash rtk git status --short && rtk git reset --hard',
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it('does not locally allow git inspection commands with write-capable flags', async () => {
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
          id: 'perm-git-output',
          type: 'bash',
          sessionID: 'session-1',
          title: 'bash rtk git diff --output=/tmp/diff.patch',
        },
      })
    ).resolves.toEqual({ decision: 'ask', reason: 'Needs user review.' });
    expect(request).toHaveBeenCalledWith('POST', '/session', expect.any(Object));
  });

  it.each([
    ['quoted output option', 'git diff "--output=/tmp/patch"'],
    ['concatenated output option', 'git diff --out"put"=/tmp/patch'],
    ['empty-quoted output option', "git diff --out''put=/tmp/patch"],
    ['escaped output option', 'git diff --out\\put=/tmp/patch'],
    ['quoted ext-diff option', 'git diff "--ext-diff"'],
    ['concatenated ext-diff option', 'git diff --ext"-"diff'],
    ['empty-quoted ext-diff option', "git diff --ext''-diff"],
    ['escaped ext-diff option', 'git diff --ext\\-diff'],
  ])('does not locally allow a reconstructed %s', async (_case, command) => {
    const { workspace } = createTemporaryWorkspace();
    const request = createAskJudgeRequest();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await expect(
      judge.judge({
        permission: {
          id: `perm-reconstructed-${_case}`,
          type: 'bash',
          sessionID: 'session-1',
          title: `bash ${command}`,
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

  it('keeps a deleted judge session hidden until its deletion event', async () => {
    const hiddenSessions = new HiddenSessionManager();
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
      if (method === 'GET' && path === '/config') return { small_model: 'openai/gpt-5-mini' };
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        return {
          info: { structured_output: { decision: 'allow', reason: 'Read-only git remote.' } },
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
        title: 'Run command: git remote -v',
      },
      model: { providerID: 'openai', modelID: 'gpt-5' },
      approvedReferences: [{ type: 'bash', title: 'bash git status --short', response: 'once' }],
    });

    expect(result).toEqual({ decision: 'allow', reason: 'Read-only git remote.' });
    expect(hiddenSessions.isHidden('judge-session-1')).toBe(true);
    hiddenSessions.observeEvent({
      type: 'session.updated',
      properties: { info: { id: 'judge-session-1', title: 'Queued helper update' } },
    });
    expect(hiddenSessions.isHidden('judge-session-1')).toBe(true);
    hiddenSessions.observeEvent({
      type: 'session.deleted',
      properties: { info: { id: 'judge-session-1' } },
    });
    expect(hiddenSessions.isHidden('judge-session-1')).toBe(false);
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
        parts: [
          expect.objectContaining({
            text: expect.stringContaining('bash git status --short'),
          }),
        ],
      })
    );
    expect(request).toHaveBeenCalledWith('DELETE', '/session/judge-session-1');
  });

  it('prefers GPT Luna from a connected provider when small_model is absent', async () => {
    let messageBody: Record<string, unknown> | undefined;
    const isOpenAIPro = vi.fn(() => Promise.resolve(false));
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/config') return {};
      if (method === 'GET' && path === '/config/providers') {
        return {
          providers: [
            {
              id: 'openai',
              models: {
                'gpt-5.6-luna': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
              },
            },
            {
              id: 'anthropic',
              models: { opus: { id: 'opus', name: 'Claude Opus' } },
            },
          ],
        };
      }
      if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        messageBody = body as Record<string, unknown>;
        return { info: { structured: { decision: 'ask', reason: 'Needs user review.' } } };
      }
      if (method === 'DELETE' && path === '/session/judge-session-1') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge(
      { request } as never,
      new HiddenSessionManager(),
      isOpenAIPro
    );

    await judge.judge({
      permission: cargoBuildPermission('perm-luna'),
      model: { providerID: 'anthropic', modelID: 'opus', variant: 'high' },
    });

    expect(messageBody?.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.6-luna' });
    expect(messageBody).not.toHaveProperty('variant');
    expect(isOpenAIPro).not.toHaveBeenCalled();
  });

  it('prefers OpenAI GPT Luna Fast for a Pro plan', async () => {
    let messageBody: Record<string, unknown> | undefined;
    const isOpenAIPro = vi.fn(() => Promise.resolve(true));
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/config') return {};
      if (method === 'GET' && path === '/config/providers') {
        return {
          providers: [
            {
              id: 'openai',
              models: {
                'gpt-5.6-luna': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
                'gpt-5.6-luna-fast': {
                  id: 'gpt-5.6-luna-fast',
                  name: 'GPT-5.6 Luna Fast',
                },
              },
            },
          ],
        };
      }
      if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        messageBody = body as Record<string, unknown>;
        return { info: { structured: { decision: 'ask', reason: 'Needs user review.' } } };
      }
      if (method === 'DELETE' && path === '/session/judge-session-1') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge(
      { request } as never,
      new HiddenSessionManager(),
      isOpenAIPro
    );

    await judge.judge({ permission: cargoBuildPermission('perm-luna-fast') });

    expect(messageBody?.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-luna-fast',
    });
    expect(isOpenAIPro).toHaveBeenCalledOnce();
  });

  it('uses the request model with low reasoning when GPT Luna is unavailable', async () => {
    let messageBody: Record<string, unknown> | undefined;
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'GET' && path === '/config') return {};
      if (method === 'GET' && path === '/config/providers') {
        return {
          providers: [
            {
              id: 'anthropic',
              models: {
                opus: {
                  id: 'opus',
                  name: 'Claude Opus',
                  variants: {
                    high: { reasoningEffort: 'high' },
                    low: { reasoningEffort: 'low' },
                  },
                },
              },
            },
          ],
        };
      }
      if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        messageBody = body as Record<string, unknown>;
        return { info: { structured: { decision: 'ask', reason: 'Needs user review.' } } };
      }
      if (method === 'DELETE' && path === '/session/judge-session-1') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());

    await judge.judge({
      permission: cargoBuildPermission('perm-fallback'),
      model: { providerID: 'anthropic', modelID: 'opus', variant: 'high' },
    });

    expect(messageBody?.model).toEqual({ providerID: 'anthropic', modelID: 'opus' });
    expect(messageBody?.variant).toBe('low');
  });

  it.each(['false response', 'rejected request'] as const)(
    'keeps a judge helper session hidden after a %s deletion',
    async (failure) => {
      const hiddenSessions = new HiddenSessionManager();
      const request = vi.fn(async (method: string, path: string) => {
        if (method === 'GET' && path === '/config') return {};
        if (method === 'POST' && path === '/session') {
          return { id: 'judge-session-failed-delete' };
        }
        if (method === 'POST' && path === '/session/judge-session-failed-delete/message') {
          return { info: { structured: { decision: 'ask', reason: 'Needs user review.' } } };
        }
        if (method === 'DELETE' && path === '/session/judge-session-failed-delete') {
          if (failure === 'rejected request') throw new Error('delete failed');
          return false;
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      });
      const judge = new AutoApproveJudge({ request } as never, hiddenSessions);

      await judge.judge({ permission: cargoBuildPermission('perm-failed-delete') });

      expect(hiddenSessions.isHidden('judge-session-failed-delete')).toBe(true);
    }
  );

  it('allows only the StructuredOutput synthetic tool in deny-all judge sessions', async () => {
    let permissionRules: PermissionRule[] = [];
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/session') {
        permissionRules = (body as { permission: PermissionRule[] }).permission;
        return { id: 'judge-session-1' };
      }
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        return { info: { structured: { decision: 'ask', reason: 'Needs user review.' } } };
      }
      if (method === 'DELETE' && path === '/session/judge-session-1') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());

    await judge.judge({ permission: cargoBuildPermission('perm-structured-permission') });

    expect(resolveToolAction(permissionRules, 'StructuredOutput')).toBe('allow');
    expect(resolveToolAction(permissionRules, 'unknown_custom_tool')).toBe('deny');
    expect(permissionRules.at(-1)).toEqual({
      permission: 'StructuredOutput',
      pattern: '*',
      action: 'allow',
    });
  });

  it('reads structured judge output from current OpenCode responses', async () => {
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') return { id: 'judge-session-1' };
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path === '/session/judge-session-1/message') {
        return { info: { structured: { decision: 'allow', reason: 'Current field.' } } };
      }
      if (method === 'DELETE' && path === '/session/judge-session-1') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());

    await expect(
      judge.judge({ permission: cargoBuildPermission('perm-structured') })
    ).resolves.toEqual({
      decision: 'allow',
      reason: 'Current field.',
    });
  });

  it('reuses an allow verdict for an identical permission without a second judge session', async () => {
    let sessionCount = 0;
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') {
        sessionCount += 1;
        return { id: `judge-session-${sessionCount}` };
      }
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path.endsWith('/message')) {
        return { info: { structured_output: { decision: 'allow', reason: 'Local build.' } } };
      }
      if (method === 'DELETE') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());

    await expect(judge.judge({ permission: cargoBuildPermission('perm-1') })).resolves.toEqual({
      decision: 'allow',
      reason: 'Local build.',
    });
    await expect(judge.judge({ permission: cargoBuildPermission('perm-2') })).resolves.toEqual({
      decision: 'allow',
      reason: 'Local build.',
    });
    expect(sessionCount).toBe(1);
  });

  it('does not cache an allow verdict that arrives after the judge times out', async () => {
    vi.useFakeTimers();
    try {
      const lateResponse = deferred<unknown>();
      let sessionCount = 0;
      const request = vi.fn(async (method: string, path: string) => {
        if (method === 'GET' && path === '/config') return {};
        if (method === 'POST' && path === '/session') {
          sessionCount += 1;
          return { id: `judge-session-${sessionCount}` };
        }
        if (method === 'POST' && path === '/session/judge-session-1/message') {
          return lateResponse.promise;
        }
        if (method === 'POST' && path === '/session/judge-session-2/message') {
          return { info: { structured: { decision: 'ask', reason: 'Second judge.' } } };
        }
        if (method === 'DELETE') return true;
        throw new Error(`Unexpected request: ${method} ${path}`);
      });
      const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());

      const timedOut = judge.judge({ permission: cargoBuildPermission('perm-timeout-1') });
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(request).toHaveBeenCalledWith(
        'POST',
        '/session/judge-session-1/message',
        expect.anything()
      );

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(timedOut).resolves.toEqual({
        decision: 'ask',
        reason: 'Judge failed; asking user.',
      });

      lateResponse.resolve({
        info: { structured: { decision: 'allow', reason: 'Late allow.' } },
      });
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      expect(request).toHaveBeenCalledWith('DELETE', '/session/judge-session-1');

      await expect(
        judge.judge({ permission: cargoBuildPermission('perm-timeout-2') })
      ).resolves.toEqual({ decision: 'ask', reason: 'Second judge.' });
      expect(sessionCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reuse an allow verdict across workspace contexts', async () => {
    const { root, workspace } = createTemporaryWorkspace();
    const otherWorkspace = join(root, 'other-workspace');
    mkdirSync(otherWorkspace);
    let currentWorkspace = workspace;
    let sessionCount = 0;
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') {
        sessionCount += 1;
        return { id: `judge-session-${sessionCount}` };
      }
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path.endsWith('/message')) {
        return { info: { structured: { decision: 'allow', reason: 'Local build.' } } };
      }
      if (method === 'DELETE') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => currentWorkspace } as never,
      new HiddenSessionManager()
    );

    await judge.judge({ permission: cargoBuildPermission('perm-workspace-1') });
    currentWorkspace = otherWorkspace;
    await judge.judge({ permission: cargoBuildPermission('perm-workspace-2') });

    expect(sessionCount).toBe(2);
  });

  it('does not reuse an allow verdict across resolved model contexts', async () => {
    let sessionCount = 0;
    let smallModel = 'openai/model-one';
    const messageModels: unknown[] = [];
    const request = vi.fn(async (method: string, path: string, body?: unknown) => {
      if (method === 'POST' && path === '/session') {
        sessionCount += 1;
        return { id: `judge-session-${sessionCount}` };
      }
      if (method === 'GET' && path === '/config') return { small_model: smallModel };
      if (method === 'POST' && path.endsWith('/message')) {
        messageModels.push((body as { model?: unknown }).model);
        return { info: { structured: { decision: 'allow', reason: 'Local build.' } } };
      }
      if (method === 'DELETE') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());

    await judge.judge({ permission: cargoBuildPermission('perm-model-1') });
    smallModel = 'openai/model-two';
    await judge.judge({ permission: cargoBuildPermission('perm-model-2') });

    expect(sessionCount).toBe(2);
    expect(messageModels).toEqual([
      { providerID: 'openai', modelID: 'model-one' },
      { providerID: 'openai', modelID: 'model-two' },
    ]);
  });

  it('does not reuse an allow verdict when permission metadata changes', async () => {
    let sessionCount = 0;
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') {
        sessionCount += 1;
        return { id: `judge-session-${sessionCount}` };
      }
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path.endsWith('/message')) {
        return { info: { structured_output: { decision: 'allow', reason: 'Safe fetch.' } } };
      }
      if (method === 'DELETE') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());
    const permission = {
      id: 'perm-1',
      type: 'webfetch',
      sessionID: 'session-1',
      title: 'Fetch documentation',
      metadata: { url: 'https://example.com/one' },
    };

    await judge.judge({ permission });
    await judge.judge({
      permission: {
        ...permission,
        id: 'perm-2',
        metadata: { url: 'https://example.com/two' },
      },
    });

    expect(sessionCount).toBe(2);
  });

  it('does not reuse ask verdicts or allow verdicts across different prior approvals', async () => {
    let sessionCount = 0;
    let decision: 'allow' | 'ask' = 'ask';
    const request = vi.fn(async (method: string, path: string) => {
      if (method === 'POST' && path === '/session') {
        sessionCount += 1;
        return { id: `judge-session-${sessionCount}` };
      }
      if (method === 'GET' && path === '/config') return {};
      if (method === 'POST' && path.endsWith('/message')) {
        return { info: { structured_output: { decision, reason: 'Judged.' } } };
      }
      if (method === 'DELETE') return true;
      throw new Error(`Unexpected request: ${method} ${path}`);
    });
    const judge = new AutoApproveJudge({ request } as never, new HiddenSessionManager());
    const permission = {
      id: 'perm-1',
      type: 'bash',
      sessionID: 'session-1',
      title: 'Run command: npm install left-pad',
      metadata: { command: 'npm install left-pad' },
    };

    await expect(judge.judge({ permission })).resolves.toEqual({
      decision: 'ask',
      reason: 'Judged.',
    });
    await expect(judge.judge({ permission })).resolves.toEqual({
      decision: 'ask',
      reason: 'Judged.',
    });
    expect(sessionCount).toBe(2);

    decision = 'allow';
    await expect(judge.judge({ permission })).resolves.toEqual({
      decision: 'allow',
      reason: 'Judged.',
    });
    await expect(
      judge.judge({
        permission,
        approvedReferences: [{ type: 'bash', title: 'bash npm ci', response: 'once' }],
      })
    ).resolves.toEqual({ decision: 'allow', reason: 'Judged.' });
    expect(sessionCount).toBe(4);
  });

  it('writes an audit line for every auto-approve decision', async () => {
    mocks.logger.info.mockClear();
    const { workspace } = createTemporaryWorkspace();
    const filePath = join(workspace, 'src', 'app.ts');
    const request = vi.fn();
    const judge = new AutoApproveJudge(
      { request, getWorkspaceCwd: () => workspace } as never,
      new HiddenSessionManager()
    );

    await judge.judge({
      permission: {
        id: 'perm-edit',
        type: 'edit',
        sessionID: 'session-1',
        title: 'edit src/app.ts',
        metadata: { filepath: filePath },
      },
    });

    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.stringContaining(`[auto-approve] allow (local-rule) edit "${filePath}`)
    );
  });
});
