import type { McpStatus } from '../../shared/protocol';

export function createSessionMcpOperations(deps: {
  getSelectedMcpsForSession(sessionId: string): string[] | null | undefined;
  getMcpStatus(): Record<string, McpStatus>;
  loadMcps(): Promise<void>;
  getAvailableMcpNames(): string[];
  connectMcp(name: string): Promise<unknown>;
  disconnectMcp(name: string): Promise<unknown>;
  logError(context: string, err: unknown): void;
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
}) {
  const syncSessionMcps = async (sessionId: string) => {
    await syncSessionMcpsWithDependencies(
      {
        getSelectedMcpsForSession: deps.getSelectedMcpsForSession,
        getMcpStatus: deps.getMcpStatus,
        loadMcps: deps.loadMcps,
        getAvailableMcpNames: deps.getAvailableMcpNames,
        connectMcp: deps.connectMcp,
        disconnectMcp: deps.disconnectMcp,
        logError: deps.logError,
      },
      sessionId
    );
  };

  const applySessionMcps = async (names: string[], sessionId: string | null | undefined) => {
    await applySessionMcpsWithDependencies(
      {
        setSelectedMcpsForSession: deps.setSelectedMcpsForSession,
        syncSessionMcps,
      },
      names,
      sessionId
    );
  };

  return {
    syncSessionMcps,
    applySessionMcps,
  };
}

export async function syncSessionMcpsWithDependencies(
  deps: {
    getSelectedMcpsForSession(sessionId: string): string[] | null | undefined;
    getMcpStatus(): Record<string, McpStatus>;
    loadMcps(): Promise<void>;
    getAvailableMcpNames(): string[];
    connectMcp(name: string): Promise<unknown>;
    disconnectMcp(name: string): Promise<unknown>;
    logError(context: string, err: unknown): void;
  },
  sessionId: string
) {
  const desired = deps.getSelectedMcpsForSession(sessionId);
  if (!desired) return;

  if (Object.keys(deps.getMcpStatus()).length === 0) {
    await deps.loadMcps();
  }

  const available = new Set(deps.getAvailableMcpNames());
  const desiredSet = new Set(desired.filter((name) => available.has(name)));
  const connected = Object.entries(deps.getMcpStatus())
    .filter(([, value]) => value?.status === 'connected')
    .map(([name]) => name);

  const connect = [...desiredSet].filter((name) => !connected.includes(name));
  const disconnect = connected.filter((name) => !desiredSet.has(name));
  if (connect.length === 0 && disconnect.length === 0) return;

  try {
    await Promise.all([
      ...connect.map((name) => deps.connectMcp(name)),
      ...disconnect.map((name) => deps.disconnectMcp(name)),
    ]);
  } catch (err) {
    deps.logError('syncSessionMcps', err);
  }

  await deps.loadMcps();
}

export async function applySessionMcpsWithDependencies(
  deps: {
    setSelectedMcpsForSession(sessionId: string, names: string[]): void;
    syncSessionMcps(sessionId: string): Promise<void>;
  },
  names: string[],
  sessionId: string | null | undefined
) {
  if (!sessionId) return;
  deps.setSelectedMcpsForSession(sessionId, names);
  await deps.syncSessionMcps(sessionId);
}
