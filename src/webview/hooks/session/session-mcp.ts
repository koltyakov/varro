import type { McpStatus } from '../../../shared/protocol';

type SessionMcpDependencies = {
  getSelectedMcpsForSession(sessionId: string | null): string[] | null | undefined;
  getRequiredMcpSessionIds?(targetSessionId: string | null): string[];
  getMcpStatus(): Record<string, McpStatus>;
  loadMcps(): Promise<void>;
  getAvailableMcpNames(): string[];
  connectMcp(name: string): Promise<unknown>;
  authenticateMcp(name: string): Promise<unknown>;
  disconnectMcp(name: string): Promise<unknown>;
  logError(context: string, err: unknown): void;
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
  setDraftSelectedMcps(names: string[]): void;
};

export class SessionMcpOperations {
  private reconciliationGeneration = 0;
  private reconciliationQueue = Promise.resolve();

  constructor(private readonly deps: SessionMcpDependencies) {}

  readonly invalidate = () => {
    this.reconciliationGeneration += 1;
  };

  private reconcileSessionMcps = (
    sessionId: string | null,
    preserveBackgroundMcps: boolean
  ): Promise<void> => {
    const generation = ++this.reconciliationGeneration;
    const reconciliation = this.reconciliationQueue.then(async () => {
      if (generation !== this.reconciliationGeneration) return;
      await syncSessionMcpsWithDependencies(
        {
          getSelectedMcpsForSession: this.deps.getSelectedMcpsForSession,
          getRequiredMcpSessionIds: this.deps.getRequiredMcpSessionIds,
          getMcpStatus: this.deps.getMcpStatus,
          loadMcps: this.deps.loadMcps,
          getAvailableMcpNames: this.deps.getAvailableMcpNames,
          connectMcp: this.deps.connectMcp,
          authenticateMcp: this.deps.authenticateMcp,
          disconnectMcp: this.deps.disconnectMcp,
          logError: this.deps.logError,
        },
        sessionId,
        () => generation === this.reconciliationGeneration,
        preserveBackgroundMcps
      );
    });
    this.reconciliationQueue = reconciliation.catch(() => {});
    return reconciliation;
  };

  readonly syncSessionMcps = (sessionId: string | null): Promise<void> => {
    return this.reconcileSessionMcps(sessionId, true);
  };

  readonly applySessionMcps = async (names: string[], sessionId: string | null | undefined) => {
    await applySessionMcpsWithDependencies(
      {
        setSelectedMcpsForSession: this.deps.setSelectedMcpsForSession,
        setDraftSelectedMcps: this.deps.setDraftSelectedMcps,
        syncSessionMcps: (targetSessionId) => this.reconcileSessionMcps(targetSessionId, false),
      },
      names,
      sessionId
    );
  };
}

export async function syncSessionMcpsWithDependencies(
  deps: {
    getSelectedMcpsForSession(sessionId: string | null): string[] | null | undefined;
    getRequiredMcpSessionIds?(targetSessionId: string | null): string[];
    getMcpStatus(): Record<string, McpStatus>;
    loadMcps(): Promise<void>;
    getAvailableMcpNames(): string[];
    connectMcp(name: string): Promise<unknown>;
    authenticateMcp(name: string): Promise<unknown>;
    disconnectMcp(name: string): Promise<unknown>;
    logError(context: string, err: unknown): void;
  },
  sessionId: string | null,
  isCurrent: () => boolean = () => true,
  preserveBackgroundMcps = true
) {
  if (!deps.getSelectedMcpsForSession(sessionId) || Object.keys(deps.getMcpStatus()).length === 0) {
    await deps.loadMcps();
  }
  if (!isCurrent()) return;

  const available = new Set(deps.getAvailableMcpNames());
  const selectedTargetMcps = deps.getSelectedMcpsForSession(sessionId);
  if (!selectedTargetMcps) return;
  const requiredSessionIds = new Set(
    preserveBackgroundMcps ? deps.getRequiredMcpSessionIds?.(sessionId) || [] : []
  );
  if (sessionId) requiredSessionIds.add(sessionId);
  const desiredSet = new Set([
    ...selectedTargetMcps.filter((name) => available.has(name)),
    ...[...requiredSessionIds].flatMap(
      (id) => deps.getSelectedMcpsForSession(id)?.filter((name) => available.has(name)) || []
    ),
  ]);

  const statuses = deps.getMcpStatus();
  const connected = Object.entries(statuses)
    .filter(([, value]) => value?.status === 'connected')
    .map(([name]) => name);

  const connect = [...desiredSet].filter(
    (name) =>
      !connected.includes(name) &&
      statuses[name]?.status !== 'needs_auth' &&
      statuses[name]?.status !== 'needs_client_registration'
  );
  const disconnect = connected.filter((name) => !desiredSet.has(name));
  if (connect.length === 0 && disconnect.length === 0) return;
  if (!isCurrent()) return;

  const results = await Promise.allSettled([
    ...connect.map((name) => deps.connectMcp(name)),
    ...disconnect.map((name) => deps.disconnectMcp(name)),
  ]);
  if (!isCurrent()) return;
  for (const result of results) {
    if (result.status === 'rejected') deps.logError('syncSessionMcps', result.reason);
  }

  await deps.loadMcps();
}

export async function applySessionMcpsWithDependencies(
  deps: {
    setSelectedMcpsForSession(sessionId: string, names: string[]): void;
    setDraftSelectedMcps(names: string[]): void;
    syncSessionMcps(sessionId: string | null): Promise<void>;
  },
  names: string[],
  sessionId: string | null | undefined
) {
  if (!sessionId) {
    deps.setDraftSelectedMcps(names);
  } else {
    deps.setSelectedMcpsForSession(sessionId, names);
  }
  await deps.syncSessionMcps(sessionId || null);
}
