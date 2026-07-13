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
      loadFullSessionHistory: vi.fn().mockResolvedValue(undefined),
      loadOlderSessionHistoryPage: vi.fn().mockResolvedValue(true),
      loadOlderSessionPrompts: vi.fn().mockResolvedValue(true),
      createSession: vi.fn().mockResolvedValue(`${label}-session`),
      forkSession: vi.fn().mockResolvedValue(`${label}-fork`),
      renameSession: vi.fn().mockResolvedValue(true),
      deleteSession: vi.fn().mockResolvedValue(undefined),
      deleteSessionImmediately: vi.fn().mockResolvedValue(undefined),
      restoreSession: vi.fn().mockResolvedValue(undefined),
      deleteSessionPermanently: vi.fn().mockResolvedValue(undefined),
      emptyRecycleBin: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(true),
      retryMessage: vi.fn().mockResolvedValue(undefined),
      editMessage: vi.fn().mockResolvedValue(undefined),
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

  it('forwards a result-returning operation to the installed runtime', async () => {
    const installed = createRuntimeMock('installed');
    const { module } = await loadModule();
    module.installOpenCodeRuntime(installed.runtime);

    await expect(module.createSession('Plan session', 'full')).resolves.toBe('installed-session');
    expect(installed.runtime.createSession).toHaveBeenCalledWith('Plan session', 'full');
  });

  it('forwards a void operation to the installed runtime', async () => {
    const installed = createRuntimeMock('installed');
    const { module } = await loadModule();
    module.installOpenCodeRuntime(installed.runtime);

    await expect(
      module.respondPermission('session-1', 'permission-1', 'always', { rethrow: true })
    ).resolves.toBeUndefined();
    expect(installed.runtime.respondPermission).toHaveBeenCalledWith(
      'session-1',
      'permission-1',
      'always',
      { rethrow: true }
    );
  });
});
