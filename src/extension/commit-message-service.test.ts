/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-module-mocking, anti-slop/no-runtime-typeof, anti-slop/no-shape-in-symbol-names, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- These tests model malformed transport payloads and inspect module-boundary calls with minimal service fixtures. */
import type * as vscode from 'vscode';
import type * as nodeFsPromises from 'node:fs/promises';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PermissionRule } from '../shared/opencode-types';

const mocks = vi.hoisted(() => {
  type CancellationListener = () => void;
  type ProgressTask = (
    progress: { report: (value: unknown) => void },
    token: {
      readonly isCancellationRequested: boolean;
      onCancellationRequested(listener: CancellationListener): { dispose(): void };
    }
  ) => Promise<unknown>;

  const cancellationListeners = new Set<CancellationListener>();
  let cancellationRequested = false;
  const extensionSlot: { value: unknown } = { value: undefined };
  const window = {
    activeTextEditor: undefined as { document: { uri: { fsPath: string } } } | undefined,
    showWarningMessage: vi.fn((..._args: unknown[]): Promise<string | undefined> =>
      Promise.resolve(undefined)
    ),
    showErrorMessage: vi.fn((..._args: unknown[]): Promise<string | undefined> =>
      Promise.resolve(undefined)
    ),
    showInformationMessage: vi.fn((..._args: unknown[]): Promise<string | undefined> =>
      Promise.resolve(undefined)
    ),
    showQuickPick: vi.fn((..._args: unknown[]): Promise<unknown | undefined> =>
      Promise.resolve(undefined)
    ),
    withProgress: vi.fn(async (_options: unknown, task: ProgressTask) => {
      cancellationListeners.clear();
      cancellationRequested = false;
      return task(
        { report: vi.fn() },
        {
          get isCancellationRequested() {
            return cancellationRequested;
          },
          onCancellationRequested(listener: CancellationListener) {
            cancellationListeners.add(listener);
            return { dispose: () => cancellationListeners.delete(listener) };
          },
        }
      );
    }),
  };

  return {
    extensionSlot,
    window,
    getExtension: vi.fn(() => extensionSlot.value),
    uriFile: vi.fn((fsPath: string) => ({ fsPath })),
    workspaceReadFile: vi.fn((_uri: vscode.Uri) => Promise.resolve(new Uint8Array())),
    nodeCreateReadStream: vi.fn(),
    nodeOpen: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
    nodeRealpath: vi.fn<(path: string) => Promise<string>>(),
    nodeStat: vi.fn<(path: string) => Promise<{ dev: number; ino: number }>>(),
    workspaceStat: vi.fn((_uri: vscode.Uri) =>
      Promise.resolve({ type: 1, ctime: 0, mtime: 1, size: 0 })
    ),
    clipboardWriteText: vi.fn((_value: string) => Promise.resolve()),
    executeCommand: vi.fn((_command: string) => Promise.resolve()),
    triggerCancellation() {
      cancellationRequested = true;
      for (const listener of cancellationListeners) listener();
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

vi.mock('vscode', () => ({
  extensions: { getExtension: mocks.getExtension },
  window: mocks.window,
  Uri: { file: mocks.uriFile },
  workspace: {
    fs: {
      readFile: mocks.workspaceReadFile,
      stat: mocks.workspaceStat,
    },
  },
  ProgressLocation: { SourceControl: 1 },
  FileType: { SymbolicLink: 64 },
  env: { clipboard: { writeText: mocks.clipboardWriteText } },
  commands: { executeCommand: mocks.executeCommand },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();
  const open = (...args: unknown[]) => mocks.nodeOpen(...args);
  const realpath = (path: string) => mocks.nodeRealpath(path);
  const stat = (path: string) => mocks.nodeStat(path);
  return {
    ...actual,
    default: { ...actual, open, realpath, stat },
    open,
    realpath,
    stat,
  };
});

vi.mock('./logger', () => ({ logger: mocks.logger }));

import { CommitMessageService } from './commit-message-service';
import { HiddenSessionManager } from './hidden-session-manager';
import type { OpenCodeServer } from './server';

type HiddenSessionActions = Pick<
  HiddenSessionManager,
  'registerPendingTitle' | 'forgetPendingTitle' | 'hide' | 'retainUntilDeleted'
>;

type RequestOptions = {
  config?: unknown;
  deleteResponse?: unknown | (() => unknown | Promise<unknown>);
  providers?: unknown;
  messageResponse?: unknown | (() => unknown | Promise<unknown>);
  sessionResponse?: unknown | (() => unknown | Promise<unknown>);
  onMessage?: () => void;
};

function uri(fsPath: string): vscode.Uri {
  return { fsPath, scheme: 'file' } as vscode.Uri;
}

function createRepository(root = '/repo', patch = 'diff --git a/src/a.ts b/src/a.ts\n+change') {
  return {
    rootUri: uri(root),
    inputBox: { value: '' },
    ui: { selected: false },
    state: {
      indexChanges: [{ uri: uri(`${root}/src/a.ts`) }],
      mergeChanges: [] as Array<{ uri: vscode.Uri }>,
      workingTreeChanges: [] as Array<{ uri: vscode.Uri; status?: number }>,
    },
    status: vi.fn(() => Promise.resolve()),
    diff: vi.fn((_cached?: boolean) => Promise.resolve(patch)),
    log: vi.fn((_options: { maxEntries: number }) =>
      Promise.resolve([{ message: 'feat: prior subject\n\nPrior body' }])
    ),
  };
}

function setGitRepositories(
  repositories: ReturnType<typeof createRepository>[],
  options: {
    active?: boolean;
    getRepository?: (value: vscode.Uri) => (typeof repositories)[number] | null;
  } = {}
) {
  const getRepository = vi.fn(
    options.getRepository ||
      ((value: vscode.Uri) =>
        repositories.find(
          (repository) =>
            value.fsPath === repository.rootUri.fsPath ||
            value.fsPath.startsWith(`${repository.rootUri.fsPath}/`)
        ) || null)
  );
  const api = { repositories, getRepository };
  const git = { enabled: true, getAPI: vi.fn(() => api) };
  const extension = {
    isActive: options.active !== false,
    exports: git,
    activate: vi.fn(() => Promise.resolve(git)),
  };
  mocks.extensionSlot.value = extension;
  return { api, extension, git };
}

function createHiddenSessions() {
  const actions = {
    registerPendingTitle: vi.fn<HiddenSessionActions['registerPendingTitle']>(),
    forgetPendingTitle: vi.fn<HiddenSessionActions['forgetPendingTitle']>(),
    hide: vi.fn<HiddenSessionActions['hide']>(),
    retainUntilDeleted: vi.fn<HiddenSessionActions['retainUntilDeleted']>(),
  } satisfies HiddenSessionActions;
  return Object.assign(new HiddenSessionManager(), actions);
}

function createRequest(options: RequestOptions = {}) {
  const request = vi.fn<OpenCodeServer['request']>(async (method, path) => {
    if (method === 'POST' && path.startsWith('/session?')) {
      return resolveOption(
        Object.prototype.hasOwnProperty.call(options, 'sessionResponse')
          ? options.sessionResponse
          : { id: 'helper-1' }
      );
    }
    if (method === 'GET' && path.startsWith('/config?')) {
      const value = Object.prototype.hasOwnProperty.call(options, 'config')
        ? options.config
        : { small_model: 'openai/gpt-4o-mini' };
      if (value instanceof Error) throw value;
      return value;
    }
    if (method === 'GET' && path.startsWith('/config/providers?')) {
      const value = Object.prototype.hasOwnProperty.call(options, 'providers')
        ? options.providers
        : { providers: [] };
      if (value instanceof Error) throw value;
      return value;
    }
    if (method === 'POST' && /\/session\/[^/]+\/message\?/.test(path)) {
      options.onMessage?.();
      return resolveOption(
        Object.prototype.hasOwnProperty.call(options, 'messageResponse')
          ? options.messageResponse
          : {
              info: {
                structured: {
                  subject: 'feat: generated message',
                  body: 'Explain the generated change.',
                },
              },
            }
      );
    }
    if (method === 'POST' && /\/session\/[^/]+\/abort\?/.test(path)) return true;
    if (method === 'DELETE' && path.startsWith('/session/')) {
      return resolveOption(
        Object.prototype.hasOwnProperty.call(options, 'deleteResponse')
          ? options.deleteResponse
          : true
      );
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  return request;
}

function resolveOption(value: unknown | (() => unknown | Promise<unknown>)) {
  return typeof value === 'function' ? value() : value;
}

function createService(
  request = createRequest(),
  hiddenSessions = createHiddenSessions(),
  workspacePath?: string,
  activeModel: { providerID: string; modelID: string; variant?: string } | null = null,
  openAIPro = false,
  configuredModel: unknown = null
) {
  const ensureServerStarted = vi.fn(() => Promise.resolve());
  const isOpenAIPro = vi.fn(() => Promise.resolve(openAIPro));
  const service = new CommitMessageService(
    { request },
    hiddenSessions,
    ensureServerStarted,
    () => workspacePath,
    () => activeModel,
    isOpenAIPro,
    () => configuredModel
  );
  return { service, request, hiddenSessions, ensureServerStarted, isOpenAIPro };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for test condition');
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function requestBody(request: ReturnType<typeof createRequest>, pathPart: string) {
  const call = request.mock.calls.find(([_method, path]) => path.includes(pathPart));
  return call?.[2] as Record<string, unknown> | undefined;
}

function resolveToolAction(rules: PermissionRule[], tool: string) {
  return rules.findLast((rule) => rule.permission === '*' || rule.permission === tool)?.action;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.extensionSlot.value = undefined;
  mocks.window.activeTextEditor = undefined;
  mocks.window.showWarningMessage.mockResolvedValue(undefined);
  mocks.window.showErrorMessage.mockResolvedValue(undefined);
  mocks.window.showInformationMessage.mockResolvedValue(undefined);
  mocks.window.showQuickPick.mockResolvedValue(undefined);
  mocks.workspaceReadFile.mockReset().mockResolvedValue(new Uint8Array());
  mocks.nodeCreateReadStream.mockReset().mockImplementation((fsPath: string) =>
    Readable.from(
      (async function* () {
        yield await mocks.workspaceReadFile(uri(fsPath));
      })()
    )
  );
  mocks.nodeOpen.mockReset().mockImplementation(async (fsPath: unknown) => ({
    createReadStream: () => mocks.nodeCreateReadStream(String(fsPath)),
    close: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ dev: 1, ino: 1 })),
  }));
  mocks.nodeRealpath.mockReset().mockImplementation(async (path: string) => path);
  mocks.nodeStat.mockReset().mockResolvedValue({ dev: 1, ino: 1 });
  mocks.workspaceStat.mockReset().mockResolvedValue({ type: 1, ctime: 0, mtime: 1, size: 0 });
});

describe('CommitMessageService', () => {
  it('generates a scoped staged-only message with the VS Code model setting', async () => {
    const patch = `${'x'.repeat(60_005)}SECRET_TAIL`;
    const repository = createRepository('/repo with spaces', patch);
    repository.state.indexChanges.push({ uri: uri('/repo with spaces/docs/complete path.md') });
    repository.log.mockResolvedValue([
      { message: 'feat: prior style\r\n\r\nBody' },
      { message: 'fix: second example' },
      { message: 'docs(extension): document the workflow' },
      { message: 'Merge branch main' },
    ]);
    setGitRepositories([repository], { active: false });
    const request = createRequest({
      messageResponse: {
        info: {
          structured_output: {
            subject: '  feat: generated subject\r\n ',
            body: 'Explain this.  \r\n\r\n\r\nMore context. ',
          },
        },
      },
    });
    const { service, hiddenSessions, ensureServerStarted, isOpenAIPro } = createService(
      request,
      createHiddenSessions(),
      undefined,
      null,
      false,
      'anthropic/claude-haiku'
    );

    await service.generate();

    expect(mocks.getExtension).toHaveBeenCalledWith('vscode.git');
    expect(
      (mocks.extensionSlot.value as { activate: ReturnType<typeof vi.fn> }).activate
    ).toHaveBeenCalledOnce();
    expect(repository.status).toHaveBeenCalledTimes(2);
    expect(repository.diff).toHaveBeenCalledTimes(2);
    expect(repository.diff).toHaveBeenNthCalledWith(1, true);
    expect(repository.diff).toHaveBeenNthCalledWith(2, true);
    expect(repository.log).toHaveBeenCalledWith({ maxEntries: 50 });
    expect(ensureServerStarted).toHaveBeenCalledOnce();
    expect(isOpenAIPro).not.toHaveBeenCalled();
    expect(mocks.window.withProgress).toHaveBeenCalledWith(
      {
        location: 1,
        title: 'Generating commit message',
        cancellable: true,
      },
      expect.any(Function)
    );

    const directory = 'directory=%2Frepo%20with%20spaces';
    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ['POST', `/session?${directory}`],
      ['POST', `/session/helper-1/message?${directory}`],
      ['DELETE', `/session/helper-1?${directory}`],
    ]);

    const sessionBody = requestBody(request, '/session?');
    const rules = sessionBody?.permission as PermissionRule[];
    expect(resolveToolAction(rules, 'StructuredOutput')).toBe('allow');
    expect(resolveToolAction(rules, 'bash')).toBe('deny');
    expect(resolveToolAction(rules, 'unknown_custom_tool')).toBe('deny');
    expect(rules.slice(-2)).toEqual([
      { permission: '*', pattern: '*', action: 'deny' },
      { permission: 'StructuredOutput', pattern: '*', action: 'allow' },
    ]);

    const messageBody = requestBody(request, '/message?');
    expect(messageBody).toMatchObject({
      model: { providerID: 'anthropic', modelID: 'claude-haiku' },
      format: {
        type: 'json_schema',
        retryCount: 1,
        schema: {
          additionalProperties: false,
          required: ['subject'],
          properties: {
            subject: { type: 'string', maxLength: 72 },
            body: { type: 'string', maxLength: 4000 },
          },
        },
      },
    });
    const system = messageBody?.system as string;
    const prompt = ((messageBody?.parts || []) as Array<{ text: string }>)[0]?.text || '';
    expect(system).toContain('untrusted evidence');
    expect(system).toContain('72 characters or fewer');
    expect(system).toContain('primary intent');
    expect(prompt).toContain('src/a.ts');
    expect(prompt).toContain('docs/complete path.md');
    expect(prompt).toContain('feat: prior style');
    expect(prompt).toContain('fix: second example');
    expect(prompt).toContain('Conventional Commits is established');
    expect(prompt).toContain('Observed scopes: extension');
    expect(prompt).not.toContain('Merge branch main');
    expect(prompt).not.toContain('Body');
    expect(prompt).toContain('SECRET_TAIL');
    const sentDiff = prompt
      .split('----- BEGIN UNTRUSTED STAGED DIFF -----\n')[1]
      ?.split('\n----- END UNTRUSTED STAGED DIFF -----')[0];
    expect(sentDiff).toHaveLength(60_000);

    expect(repository.inputBox.value).toBe(
      'feat: generated subject\n\nExplain this.\n\nMore context.'
    );
    expect(hiddenSessions.registerPendingTitle).toHaveBeenCalledOnce();
    expect(hiddenSessions.registerPendingTitle.mock.invocationCallOrder[0]).toBeLessThan(
      request.mock.invocationCallOrder[0] || Infinity
    );
    expect(hiddenSessions.hide).toHaveBeenCalledWith('helper-1');
    expect(hiddenSessions.forgetPendingTitle).toHaveBeenCalledOnce();
    expect(hiddenSessions.retainUntilDeleted).toHaveBeenCalledWith('helper-1');
    expect(mocks.executeCommand).toHaveBeenCalledWith('workbench.view.scm');
    expect(mocks.logger.error).not.toHaveBeenCalled();
  });

  it('balances oversized diff context across generated and source files', async () => {
    const patch = [
      'diff --git a/package-lock.json b/package-lock.json',
      '--- a/package-lock.json',
      '+++ b/package-lock.json',
      `+${'lock-data'.repeat(12_000)}`,
      'diff --git a/src/checkout.ts b/src/checkout.ts',
      '--- a/src/checkout.ts',
      '+++ b/src/checkout.ts',
      '@@ -1 +1 @@',
      '-return charge();',
      '+return retryFailedCharge();',
    ].join('\n');
    const repository = createRepository('/repo', patch);
    repository.state.indexChanges.push({ uri: uri('/repo/package-lock.json') });
    setGitRepositories([repository]);
    const request = createRequest();
    const { service } = createService(request);

    await service.generate();

    const messageBody = requestBody(request, '/message?');
    const prompt = ((messageBody?.parts || []) as Array<{ text: string }>)[0]?.text || '';
    const sentDiff = prompt
      .split('----- BEGIN UNTRUSTED STAGED DIFF -----\n')[1]
      ?.split('\n----- END UNTRUSTED STAGED DIFF -----')[0];
    expect(sentDiff).toHaveLength(60_000);
    expect(sentDiff).toContain('retryFailedCharge');
    expect(sentDiff).toContain('omitted diff content');
    expect(prompt).toContain('sampled across files');
  });

  it('omits the model when small_model is absent and treats history failure as best effort', async () => {
    const repository = createRepository();
    repository.log.mockRejectedValue(new Error('No history yet'));
    setGitRepositories([repository]);
    const request = createRequest({ config: {} });
    const { service } = createService(request);

    await service.generate();

    expect(requestBody(request, '/message?')).not.toHaveProperty('model');
    expect(repository.inputBox.value).toContain('feat: generated message');
  });

  it('prefers GPT Luna from a connected provider when small_model is absent', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const request = createRequest({
      config: {},
      providers: {
        providers: [
          {
            id: 'openai',
            models: {
              'gpt-5.6-luna': {
                id: 'gpt-5.6-luna',
                name: 'GPT-5.6 Luna',
                variants: { low: { reasoningEffort: 'low' } },
              },
            },
          },
          {
            id: 'anthropic',
            models: { opus: { id: 'opus', name: 'Claude Opus' } },
          },
        ],
      },
    });
    const { service, isOpenAIPro } = createService(request, createHiddenSessions(), undefined, {
      providerID: 'anthropic',
      modelID: 'opus',
      variant: 'high',
    });

    await service.generate();

    expect(requestBody(request, '/message?')).toMatchObject({
      model: { providerID: 'openai', modelID: 'gpt-5.6-luna' },
    });
    expect(isOpenAIPro).not.toHaveBeenCalled();
    expect(requestBody(request, '/message?')).not.toHaveProperty('variant');
  });

  it('prefers OpenAI GPT Luna Fast for a Pro plan', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const request = createRequest({
      config: {},
      providers: {
        providers: [
          {
            id: 'openai',
            models: {
              'gpt-5.6-luna': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
              'gpt-5.6-luna-fast': {
                id: 'gpt-5.6-luna-fast',
                name: 'GPT-5.6 Luna Fast',
                options: { serviceTier: 'priority' },
              },
            },
          },
        ],
      },
    });
    const { service, isOpenAIPro } = createService(
      request,
      createHiddenSessions(),
      undefined,
      null,
      true
    );

    await service.generate();

    expect(isOpenAIPro).toHaveBeenCalledOnce();
    expect(requestBody(request, '/message?')?.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-luna-fast',
    });
  });

  it('uses standard Luna when Luna Fast is exposed without a confirmed Pro plan', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const request = createRequest({
      config: {},
      providers: {
        providers: [
          {
            id: 'openai',
            models: {
              'gpt-5.6-luna-fast': {
                id: 'gpt-5.6-luna-fast',
                name: 'GPT-5.6 Luna Fast',
              },
              'gpt-5.6-luna': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
            },
          },
        ],
      },
    });
    const { service, isOpenAIPro } = createService(request);

    await service.generate();

    expect(isOpenAIPro).toHaveBeenCalledOnce();
    expect(requestBody(request, '/message?')?.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.6-luna',
    });
  });

  it('uses the active chat model with low reasoning when GPT Luna is unavailable', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const request = createRequest({
      config: {},
      providers: {
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
                  none: { reasoningEffort: 'none' },
                },
              },
            },
          },
        ],
      },
    });
    const { service } = createService(request, createHiddenSessions(), undefined, {
      providerID: 'anthropic',
      modelID: 'opus',
      variant: 'high',
    });

    await service.generate();

    expect(requestBody(request, '/message?')).toMatchObject({
      model: { providerID: 'anthropic', modelID: 'opus' },
      variant: 'low',
    });
    expect(requestBody(request, '/message?')?.model).toEqual({
      providerID: 'anthropic',
      modelID: 'opus',
    });
  });

  it('does not use an active chat model missing from connected providers', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const request = createRequest({ config: {}, providers: { providers: [] } });
    const { service } = createService(request, createHiddenSessions(), undefined, {
      providerID: 'openai',
      modelID: 'missing',
      variant: 'high',
    });

    await service.generate();

    expect(requestBody(request, '/message?')).not.toHaveProperty('model');
    expect(requestBody(request, '/message?')).not.toHaveProperty('variant');
  });

  it.each([
    ['structured', { info: { structured: { subject: 'valid subject' } } }],
    ['structured_output', { info: { structured_output: { subject: 'valid subject' } } }],
    ['structuredOutput', { info: { structuredOutput: { subject: 'valid subject' } } }],
    [
      'text JSON',
      { parts: [{ type: 'text', text: '{"subject":"valid subject","body":"Valid body"}' }] },
    ],
  ])('accepts %s commit-message output', async (_shape, messageResponse) => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const { service } = createService(createRequest({ messageResponse }));

    await service.generate();

    expect(repository.inputBox.value).toContain('valid subject');
    expect(mocks.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('drops a body that only repeats the subject', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const { service } = createService(
      createRequest({
        messageResponse: {
          info: {
            structured: { subject: 'Handle failed charges', body: 'Handle failed charges.' },
          },
        },
      })
    );

    await service.generate();

    expect(repository.inputBox.value).toBe('Handle failed charges');
  });

  it('uses all unstaged changes when there are no staged changes', async () => {
    const repository = createRepository('/repo');
    repository.state.indexChanges = [];
    repository.state.workingTreeChanges.push(
      { uri: uri('/repo/src/first.ts') },
      { uri: uri('/repo/src/second.ts') }
    );
    repository.diff.mockImplementation((cached?: boolean) =>
      Promise.resolve(cached ? '' : 'diff --git a/src/first.ts b/src/first.ts\n+unstaged change')
    );
    setGitRepositories([repository]);
    const request = createRequest();
    const { service } = createService(request);

    await service.generate();

    expect(repository.diff.mock.calls).toEqual([[true], [false], [false]]);
    const messageBody = requestBody(request, '/message?');
    const prompt = ((messageBody?.parts || []) as Array<{ text: string }>)[0]?.text || '';
    expect(prompt).toContain('Create a commit message for these unstaged changes.');
    expect(prompt).toContain('src/first.ts');
    expect(prompt).toContain('src/second.ts');
    expect(prompt).toContain('unstaged change');
    expect(repository.inputBox.value).toContain('feat: generated message');
  });

  it('generates from an untracked file when no tracked diff exists', async () => {
    const repository = createRepository('/repo', '');
    repository.state.indexChanges = [];
    repository.state.workingTreeChanges.push({
      uri: uri('/repo/src/new-file.ts'),
      status: 7,
    });
    const contents = new TextEncoder().encode('export const newValue = 42;\n');
    mocks.workspaceStat.mockResolvedValue({
      type: 1,
      ctime: 0,
      mtime: 1,
      size: contents.byteLength,
    });
    mocks.workspaceReadFile.mockResolvedValue(contents);
    setGitRepositories([repository]);
    const request = createRequest();
    const { service } = createService(request);

    await service.generate();

    expect(mocks.nodeCreateReadStream).toHaveBeenCalled();
    const messageBody = requestBody(request, '/message?');
    const prompt = ((messageBody?.parts || []) as Array<{ text: string }>)[0]?.text || '';
    expect(prompt).toContain('src/new-file.ts');
    expect(prompt).toContain('export const newValue = 42;');
    expect(repository.inputBox.value).toContain('feat: generated message');
    expect(mocks.window.showWarningMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('no changes')
    );
  });

  it('does not read through an untracked symbolic link', async () => {
    const repository = createRepository('/repo', '');
    repository.state.indexChanges = [];
    repository.state.workingTreeChanges.push({
      uri: uri('/repo/linked-secret'),
      status: 7,
    });
    mocks.workspaceStat.mockResolvedValue({
      type: 65,
      ctime: 0,
      mtime: 1,
      size: 20,
    });
    mocks.workspaceReadFile.mockResolvedValue(new TextEncoder().encode('outside-repo-secret'));
    setGitRepositories([repository]);
    const request = createRequest();
    const { service } = createService(request);

    await service.generate();

    const messageBody = requestBody(request, '/message?');
    const prompt = ((messageBody?.parts || []) as Array<{ text: string }>)[0]?.text || '';
    expect(prompt).toContain('symbolic link; content omitted');
    expect(prompt).not.toContain('outside-repo-secret');
    expect(mocks.workspaceReadFile).not.toHaveBeenCalled();
  });

  it('does not read through a symbolic link swapped in after metadata inspection', async () => {
    const repository = createRepository('/repo', '');
    repository.state.indexChanges = [];
    repository.state.workingTreeChanges.push({
      uri: uri('/repo/swapped-secret'),
      status: 7,
    });
    mocks.workspaceStat.mockResolvedValue({
      type: 1,
      ctime: 0,
      mtime: 1,
      size: 20,
    });
    mocks.workspaceReadFile.mockResolvedValue(new TextEncoder().encode('outside-repo-secret'));
    mocks.nodeCreateReadStream.mockImplementation(
      () =>
        new Readable({
          read() {
            this.destroy(Object.assign(new Error('symbolic link refused'), { code: 'ELOOP' }));
          },
        })
    );
    setGitRepositories([repository]);
    const request = createRequest();
    const { service } = createService(request);

    await service.generate();

    const messageBody = requestBody(request, '/message?');
    const prompt = ((messageBody?.parts || []) as Array<{ text: string }>)[0]?.text || '';
    expect(prompt).toContain('content unavailable');
    expect(prompt).not.toContain('outside-repo-secret');
    expect(mocks.workspaceReadFile).not.toHaveBeenCalled();
  });

  it('does not read through a parent directory redirected outside the repository', async () => {
    const repository = createRepository('/repo', '');
    repository.state.indexChanges = [];
    repository.state.workingTreeChanges.push({
      uri: uri('/repo/src/linked-secret'),
      status: 7,
    });
    mocks.workspaceStat.mockResolvedValue({
      type: 1,
      ctime: 0,
      mtime: 1,
      size: 20,
    });
    mocks.workspaceReadFile.mockResolvedValue(new TextEncoder().encode('outside-repo-secret'));
    mocks.nodeRealpath.mockImplementation(async (path: string) =>
      path === '/repo' ? path : '/outside/secret'
    );
    setGitRepositories([repository]);
    const request = createRequest();
    const { service } = createService(request);

    await service.generate();

    const messageBody = requestBody(request, '/message?');
    const prompt = ((messageBody?.parts || []) as Array<{ text: string }>)[0]?.text || '';
    expect(prompt).toContain('content unavailable');
    expect(prompt).not.toContain('outside-repo-secret');
  });

  it('detects metadata changes when atomic untracked reads are unavailable', async () => {
    const repository = createRepository('/repo', 'tracked change');
    repository.state.indexChanges = [];
    repository.diff.mockImplementation((cached?: boolean) =>
      Promise.resolve(cached ? '' : 'tracked change')
    );
    repository.state.workingTreeChanges.push({
      uri: { ...uri('/repo/remote-file.ts'), scheme: 'vscode-remote' } as vscode.Uri,
      status: 7,
    });
    mocks.workspaceStat
      .mockResolvedValueOnce({ type: 1, ctime: 0, mtime: 1, size: 10 })
      .mockResolvedValueOnce({ type: 1, ctime: 0, mtime: 2, size: 20 });
    setGitRepositories([repository]);
    const { service } = createService();

    await service.generate();

    expect(repository.inputBox.value).toBe('');
    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Unstaged changes changed')
    );
  });

  it('does not apply output when an untracked file changes during generation', async () => {
    const repository = createRepository('/repo', 'tracked change');
    repository.state.indexChanges = [];
    repository.diff.mockImplementation((cached?: boolean) =>
      Promise.resolve(cached ? '' : 'tracked change')
    );
    repository.state.workingTreeChanges.push({
      uri: uri('/repo/src/new-file.ts'),
      status: 7,
    });
    const initial = new TextEncoder().encode('initial contents\n');
    const changed = new TextEncoder().encode('changed contents\n');
    mocks.workspaceStat.mockResolvedValue({
      type: 1,
      ctime: 0,
      mtime: 1,
      size: initial.byteLength,
    });
    mocks.workspaceReadFile.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
    setGitRepositories([repository]);
    const { service } = createService();

    await service.generate();

    expect(repository.inputBox.value).toBe('');
    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Unstaged changes changed')
    );
  });

  it('does not apply output when a large untracked file changes without metadata changes', async () => {
    const repository = createRepository('/repo', 'tracked change');
    repository.state.indexChanges = [];
    repository.diff.mockImplementation((cached?: boolean) =>
      Promise.resolve(cached ? '' : 'tracked change')
    );
    repository.state.workingTreeChanges.push({
      uri: uri('/repo/large.bin'),
      status: 7,
    });
    const initial = new TextEncoder().encode('a'.repeat(20_001));
    const changed = new TextEncoder().encode(`${'a'.repeat(20_000)}b`);
    mocks.workspaceStat.mockResolvedValue({
      type: 1,
      ctime: 0,
      mtime: 1,
      size: initial.byteLength,
    });
    mocks.workspaceReadFile.mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
    setGitRepositories([repository]);
    const { service } = createService();

    await service.generate();

    expect(repository.inputBox.value).toBe('');
    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Unstaged changes changed')
    );
  });

  it('warns without calling OpenCode when there are no changes', async () => {
    const repository = createRepository('/repo', ' \r\n ');
    setGitRepositories([repository]);
    const { service, request, ensureServerStarted } = createService();

    await service.generate();

    expect(repository.status).toHaveBeenCalledOnce();
    expect(repository.diff.mock.calls).toEqual([[true], [false]]);
    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('no changes')
    );
    expect(ensureServerStarted).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects merge changes before reading the staged diff', async () => {
    const repository = createRepository();
    repository.state.mergeChanges.push({ uri: uri('/repo/conflicted.ts') });
    setGitRepositories([repository]);
    const { service, request } = createService();

    await service.generate();

    expect(repository.diff).not.toHaveBeenCalled();
    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('merge changes')
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('prefers the Git UI selected repository over editor and workspace repositories', async () => {
    const editorRepository = createRepository('/editor');
    const selectedRepository = createRepository('/selected');
    selectedRepository.ui.selected = true;
    mocks.window.activeTextEditor = { document: { uri: uri('/editor/src/file.ts') } };
    setGitRepositories([editorRepository, selectedRepository]);
    const { service, request } = createService(createRequest(), createHiddenSessions(), '/editor');

    await service.generate();

    expect(selectedRepository.status).toHaveBeenCalledTimes(2);
    expect(editorRepository.status).not.toHaveBeenCalled();
    expect(
      request.mock.calls.every(([_method, path]) => path.includes('directory=%2Fselected'))
    ).toBe(true);
  });

  it('prefers an explicit source control root over the selected repository', async () => {
    const explicitRepository = createRepository('/explicit');
    const selectedRepository = createRepository('/selected');
    selectedRepository.ui.selected = true;
    setGitRepositories([explicitRepository, selectedRepository]);
    const { service } = createService();
    const sourceControl = { rootUri: explicitRepository.rootUri } as vscode.SourceControl;

    await service.generate(sourceControl);

    expect(explicitRepository.status).toHaveBeenCalledTimes(2);
    expect(selectedRepository.status).not.toHaveBeenCalled();
  });

  it('shows distinguishable repository roots and handles quick-pick cancellation', async () => {
    const first = createRepository('/workspace/first');
    const second = createRepository('/other/first');
    setGitRepositories([first, second], { getRepository: () => null });
    const { service, request } = createService();

    await service.generate();

    expect(mocks.window.showQuickPick).toHaveBeenCalledWith(
      [
        expect.objectContaining({ label: '/workspace/first' }),
        expect.objectContaining({ label: '/other/first' }),
      ],
      expect.anything()
    );
    expect(first.status).not.toHaveBeenCalled();
    expect(second.status).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it('requires modal confirmation before replacing an existing commit input', async () => {
    const repository = createRepository();
    repository.inputBox.value = 'Keep this draft';
    setGitRepositories([repository]);
    mocks.window.showWarningMessage.mockResolvedValueOnce('Cancel');
    const { service, request } = createService();

    await service.generate();

    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('not empty'),
      { modal: true },
      'Replace',
      'Cancel'
    );
    expect(repository.inputBox.value).toBe('Keep this draft');
    expect(request).not.toHaveBeenCalled();
  });

  it('copies generated output only when chosen after the input changes', async () => {
    const repository = createRepository();
    repository.inputBox.value = 'Initial draft';
    setGitRepositories([repository]);
    mocks.window.showWarningMessage
      .mockResolvedValueOnce('Replace')
      .mockResolvedValueOnce('Copy Generated Message');
    const request = createRequest({
      onMessage: () => {
        repository.inputBox.value = 'New user draft';
      },
    });
    const { service } = createService(request);

    await service.generate();

    expect(mocks.window.showWarningMessage).toHaveBeenLastCalledWith(
      expect.stringContaining('input changed'),
      'Replace Anyway',
      'Copy Generated Message'
    );
    expect(repository.inputBox.value).toBe('New user draft');
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith(
      'feat: generated message\n\nExplain the generated change.'
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith('workbench.view.scm');
  });

  it('does not write or copy when the changed-input prompt is dismissed', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const request = createRequest({
      onMessage: () => {
        repository.inputBox.value = 'User edit';
      },
    });
    const { service } = createService(request);

    await service.generate();

    expect(repository.inputBox.value).toBe('User edit');
    expect(mocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it('does not apply output when the authoritative staged diff changes', async () => {
    const repository = createRepository('/repo', 'first staged patch');
    repository.diff
      .mockResolvedValueOnce('first staged patch')
      .mockResolvedValueOnce('changed staged patch');
    setGitRepositories([repository]);
    const { service } = createService();

    await service.generate();

    expect(repository.inputBox.value).toBe('');
    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Staged changes changed')
    );
    expect(mocks.executeCommand).not.toHaveBeenCalled();
  });

  it('silently aborts and deletes a helper session when generation is cancelled', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const response = deferred<unknown>();
    const request = createRequest({ messageResponse: () => response.promise });
    const { service, hiddenSessions } = createService(request);

    const generation = service.generate();
    await waitFor(() => request.mock.calls.some(([, path]) => path.includes('/message?')));
    mocks.triggerCancellation();
    await generation;
    await waitFor(() =>
      request.mock.calls.some(([method, path]) => method === 'DELETE' && path.includes('helper-1'))
    );

    expect(request).toHaveBeenCalledWith('POST', '/session/helper-1/abort?directory=%2Frepo');
    expect(request).toHaveBeenCalledWith('DELETE', '/session/helper-1?directory=%2Frepo');
    expect(hiddenSessions.retainUntilDeleted).toHaveBeenCalledWith('helper-1');
    expect(mocks.window.showErrorMessage).not.toHaveBeenCalled();
    expect(repository.inputBox.value).toBe('');

    response.resolve({ info: { structured: { subject: 'late stale output' } } });
    await flush();
    expect(repository.inputBox.value).toBe('');
  });

  it('hides, aborts, and deletes a helper session created after cancellation', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const session = deferred<unknown>();
    const request = createRequest({ sessionResponse: () => session.promise });
    const { service, hiddenSessions } = createService(request);

    const generation = service.generate();
    await waitFor(() =>
      request.mock.calls.some(([method, path]) => method === 'POST' && path.startsWith('/session?'))
    );
    mocks.triggerCancellation();
    await generation;
    expect(hiddenSessions.forgetPendingTitle).not.toHaveBeenCalled();

    session.resolve({ id: 'helper-late' });
    await waitFor(() =>
      request.mock.calls.some(
        ([method, path]) => method === 'DELETE' && path.includes('helper-late')
      )
    );

    expect(hiddenSessions.hide).toHaveBeenCalledWith('helper-late');
    expect(hiddenSessions.forgetPendingTitle).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('POST', '/session/helper-late/abort?directory=%2Frepo');
    expect(request).toHaveBeenCalledWith('DELETE', '/session/helper-late?directory=%2Frepo');
    expect(repository.inputBox.value).toBe('');
  });

  it('reports timeout and cleans up the helper session', async () => {
    vi.useFakeTimers();
    try {
      const repository = createRepository();
      setGitRepositories([repository]);
      const response = deferred<unknown>();
      const request = createRequest({ messageResponse: () => response.promise });
      const { service } = createService(request);

      const generation = service.generate();
      await waitFor(() => request.mock.calls.some(([, path]) => path.includes('/message?')));
      await vi.advanceTimersByTimeAsync(30_000);
      await generation;
      await flush();

      expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(
        'Generating commit message timed out.'
      );
      expect(request).toHaveBeenCalledWith('POST', '/session/helper-1/abort?directory=%2Frepo');
      expect(request).toHaveBeenCalledWith('DELETE', '/session/helper-1?directory=%2Frepo');
      expect(repository.inputBox.value).toBe('');

      response.resolve({ info: { structured: { subject: 'too late' } } });
      await flush();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prevents duplicate in-flight generation for the same root', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const response = deferred<unknown>();
    const request = createRequest({ messageResponse: () => response.promise });
    const { service } = createService(request);

    const first = service.generate();
    await waitFor(() => request.mock.calls.some(([, path]) => path.includes('/message?')));
    await service.generate();

    expect(repository.status).toHaveBeenCalledOnce();
    expect(mocks.window.showInformationMessage).toHaveBeenCalledWith(
      'A commit message is already being generated for this repository.'
    );
    expect(
      request.mock.calls.filter(
        ([method, path]) => method === 'POST' && path.startsWith('/session?')
      )
    ).toHaveLength(1);

    mocks.triggerCancellation();
    await first;
  });

  it('applies a generated message without waiting for helper-session deletion', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const deletion = deferred<unknown>();
    const request = createRequest({ deleteResponse: () => deletion.promise });
    const { service } = createService(request);

    await service.generate();

    expect(repository.inputBox.value).toBe(
      'feat: generated message\n\nExplain the generated change.'
    );
    expect(request).toHaveBeenCalledWith('DELETE', '/session/helper-1?directory=%2Frepo');
    expect(mocks.executeCommand).toHaveBeenCalledWith('workbench.view.scm');

    deletion.resolve(true);
    await flush();
  });

  it('rejects malformed output, cleans up, and never logs the staged patch', async () => {
    const patch = 'PRIVATE_STAGED_PATCH';
    const repository = createRepository('/repo', patch);
    setGitRepositories([repository]);
    const request = createRequest({
      messageResponse: {
        info: { structured: { subject: '', extra: true } },
        parts: [{ type: 'text', text: 'not json' }],
      },
    });
    const { service } = createService(request);

    await service.generate();

    expect(repository.inputBox.value).toBe('');
    expect(request).toHaveBeenCalledWith('DELETE', '/session/helper-1?directory=%2Frepo');
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('invalid commit message')
    );
    expect(mocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('invalid commit message')
    );
    expect(JSON.stringify(mocks.logger.error.mock.calls)).not.toContain(patch);
  });

  it('rejects a generic generated subject', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const { service } = createService(
      createRequest({ messageResponse: { info: { structured: { subject: 'Update files' } } } })
    );

    await service.generate();

    expect(repository.inputBox.value).toBe('');
    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('invalid commit message')
    );
  });

  it('surfaces a meaningful provider error without applying output', async () => {
    const repository = createRepository();
    setGitRepositories([repository]);
    const request = createRequest({
      messageResponse: {
        info: {
          error: { name: 'ProviderError', data: { message: 'Quota exceeded for this model' } },
        },
      },
    });
    const { service } = createService(request);

    await service.generate();

    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('ProviderError: Quota exceeded for this model')
    );
    expect(repository.inputBox.value).toBe('');
  });

  it('reports a missing Git extension and rejects a disabled Git API', async () => {
    const { service, request } = createService();

    await service.generate();

    expect(mocks.window.showErrorMessage).toHaveBeenCalledWith(
      'The built-in Git extension is unavailable.'
    );
    expect(request).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.extensionSlot.value = {
      isActive: true,
      exports: { enabled: false, getAPI: vi.fn() },
      activate: vi.fn(),
    };
    await service.generate();

    expect(mocks.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Git integration is disabled')
    );
    expect(request).not.toHaveBeenCalled();
  });
});
