import { beforeEach, describe, expect, it, vi } from 'vitest';

function createRuntimeMock(label: string) {
  const useOpenCodeResult = { client: { label } };

  return {
    useOpenCodeResult,
    runtime: {
      useOpenCode: vi.fn(() => useOpenCodeResult),
      recheckSessionStatus: vi.fn().mockResolvedValue(undefined),
      refreshRoutingState: vi.fn().mockResolvedValue(undefined),
      continueInterruptedSession: vi.fn().mockResolvedValue(undefined),
      applySessionMcps: vi.fn().mockResolvedValue(undefined),
      selectSession: vi.fn().mockResolvedValue(undefined),
      createSession: vi.fn().mockResolvedValue(`${label}-session`),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      restoreSession: vi.fn().mockResolvedValue(undefined),
      deleteSessionPermanently: vi.fn().mockResolvedValue(undefined),
      emptyRecycleBin: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      retryMessage: vi.fn().mockResolvedValue(undefined),
      implementPlan: vi.fn().mockResolvedValue(undefined),
      openPlan: vi.fn().mockResolvedValue(undefined),
      abortSession: vi.fn().mockResolvedValue(undefined),
      undoSession: vi.fn().mockResolvedValue(undefined),
      redoSession: vi.fn().mockResolvedValue(undefined),
      initSession: vi.fn().mockResolvedValue(undefined),
      runSlashCommandByName: vi.fn().mockResolvedValue(`${label}-command`),
      reviewSession: vi.fn().mockResolvedValue(undefined),
      compactSession: vi.fn().mockResolvedValue(undefined),
      respondPermission: vi.fn().mockResolvedValue(undefined),
      respondQuestion: vi.fn().mockResolvedValue(undefined),
      updatePermissionModeForSession: vi.fn().mockResolvedValue(undefined),
      rejectQuestion: vi.fn().mockResolvedValue(undefined),
    },
  };
}

async function loadModule(initialRuntime = createRuntimeMock('initial').runtime) {
  vi.resetModules();

  const createOpenCodeRuntime = vi.fn(() => initialRuntime);
  vi.doMock('./open-code-runtime-instance', () => ({
    createOpenCodeRuntime,
  }));

  const module = await import('./useOpenCode.runtime');
  return { module, createOpenCodeRuntime };
}

describe('useOpenCode.runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-exports the runtime factory and restores the previous runtime after installation cleanup', async () => {
    const initial = createRuntimeMock('initial');
    const installed = createRuntimeMock('installed');
    const { module, createOpenCodeRuntime } = await loadModule(initial.runtime);

    expect(module.createOpenCodeRuntime).toBe(createOpenCodeRuntime);
    expect(module.useOpenCode()).toEqual(initial.useOpenCodeResult);

    const restoreRuntime = module.installOpenCodeRuntime(installed.runtime);

    expect(module.useOpenCode()).toEqual(installed.useOpenCodeResult);

    restoreRuntime();

    expect(module.useOpenCode()).toEqual(initial.useOpenCodeResult);
    expect(initial.runtime.useOpenCode).toHaveBeenCalledTimes(2);
    expect(installed.runtime.useOpenCode).toHaveBeenCalledTimes(1);
  });

  it('forwards runtime operations to the installed runtime', async () => {
    const installed = createRuntimeMock('installed');
    const { module } = await loadModule();
    module.installOpenCodeRuntime(installed.runtime);

    const queuedAttachments = {
      droppedFiles: [{ path: '/repo/file.ts' }],
      clipboardImages: [{ name: 'image.png', data: 'base64' }],
      terminalSelection: { text: 'npm test', terminalName: 'Terminal 1' },
    };

    const operations = [
      {
        invoke: () => module.recheckSessionStatus('session-1'),
        mock: installed.runtime.recheckSessionStatus,
        args: ['session-1'],
      },
      {
        invoke: () => module.refreshRoutingState(),
        mock: installed.runtime.refreshRoutingState,
        args: [],
      },
      {
        invoke: () => module.continueInterruptedSession('session-1'),
        mock: installed.runtime.continueInterruptedSession,
        args: ['session-1'],
      },
      {
        invoke: () => module.applySessionMcps(['alpha'], 'session-1'),
        mock: installed.runtime.applySessionMcps,
        args: [['alpha'], 'session-1'],
      },
      {
        invoke: () => module.selectSession('session-1', { markSeen: false }),
        mock: installed.runtime.selectSession,
        args: ['session-1', { markSeen: false }],
      },
      {
        invoke: () => module.createSession('Plan session', 'full'),
        mock: installed.runtime.createSession,
        args: ['Plan session', 'full'],
        result: 'installed-session',
      },
      {
        invoke: () => module.deleteSession('session-1'),
        mock: installed.runtime.deleteSession,
        args: ['session-1'],
      },
      {
        invoke: () => module.restoreSession('root-1'),
        mock: installed.runtime.restoreSession,
        args: ['root-1'],
      },
      {
        invoke: () => module.deleteSessionPermanently('root-1'),
        mock: installed.runtime.deleteSessionPermanently,
        args: ['root-1'],
      },
      {
        invoke: () => module.emptyRecycleBin(),
        mock: installed.runtime.emptyRecycleBin,
        args: [],
      },
      {
        invoke: () =>
          module.sendMessage('hello', {
            noReply: true,
            queuedAttachments,
            preserveComposer: true,
          }),
        mock: installed.runtime.sendMessage,
        args: [
          'hello',
          {
            noReply: true,
            queuedAttachments,
            preserveComposer: true,
          },
        ],
      },
      {
        invoke: () => module.retryMessage('message-1', 'session-1'),
        mock: installed.runtime.retryMessage,
        args: ['message-1', 'session-1'],
      },
      {
        invoke: () => module.implementPlan('Implement the next step', 'session-1'),
        mock: installed.runtime.implementPlan,
        args: ['Implement the next step', 'session-1'],
      },
      {
        invoke: () => module.openPlan('# Plan', 'session-1'),
        mock: installed.runtime.openPlan,
        args: ['# Plan', 'session-1'],
      },
      {
        invoke: () => module.abortSession(),
        mock: installed.runtime.abortSession,
        args: [],
      },
      {
        invoke: () => module.undoSession(),
        mock: installed.runtime.undoSession,
        args: [],
      },
      {
        invoke: () => module.redoSession(),
        mock: installed.runtime.redoSession,
        args: [],
      },
      {
        invoke: () => module.initSession(),
        mock: installed.runtime.initSession,
        args: [],
      },
      {
        invoke: () => module.runSlashCommandByName('test', '--watch'),
        mock: installed.runtime.runSlashCommandByName,
        args: ['test', '--watch'],
        result: 'installed-command',
      },
      {
        invoke: () => module.reviewSession(),
        mock: installed.runtime.reviewSession,
        args: [],
      },
      {
        invoke: () => module.compactSession(),
        mock: installed.runtime.compactSession,
        args: [],
      },
      {
        invoke: () =>
          module.respondPermission('session-1', 'permission-1', 'always', { rethrow: true }),
        mock: installed.runtime.respondPermission,
        args: ['session-1', 'permission-1', 'always', { rethrow: true }],
      },
      {
        invoke: () => module.respondQuestion('question-1', [['answer']]),
        mock: installed.runtime.respondQuestion,
        args: ['question-1', [['answer']]],
      },
      {
        invoke: () => module.updatePermissionModeForSession('full', 'session-1'),
        mock: installed.runtime.updatePermissionModeForSession,
        args: ['full', 'session-1'],
      },
      {
        invoke: () => module.rejectQuestion('question-1'),
        mock: installed.runtime.rejectQuestion,
        args: ['question-1'],
      },
    ];

    for (const operation of operations) {
      const result = await operation.invoke();

      if ('result' in operation) {
        expect(result).toBe(operation.result);
      } else {
        expect(result).toBeUndefined();
      }

      expect(operation.mock).toHaveBeenCalledWith(...operation.args);
    }
  });
});
