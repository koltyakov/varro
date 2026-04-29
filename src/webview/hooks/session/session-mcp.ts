import type { McpStatus } from '../../../shared/protocol';

type SessionMcpDependencies = {
  getSelectedMcpsForSession(sessionId: string): string[] | null | undefined;
  getMcpStatus(): Record<string, McpStatus>;
  loadMcps(): Promise<void>;
  getAvailableMcpNames(): string[];
  connectMcp(name: string): Promise<unknown>;
  disconnectMcp(name: string): Promise<unknown>;
  logError(context: string, err: unknown): void;
  setSelectedMcpsForSession(sessionId: string, names: string[]): void;
};

export class SessionMcpOperations {
  constructor(private readonly deps: SessionMcpDependencies) {}

  readonly syncSessionMcps = async (sessionId: string) => {
    await syncSessionMcpsWithDependencies(
      {
        getSelectedMcpsForSession: this.deps.getSelectedMcpsForSession,
        getMcpStatus: this.deps.getMcpStatus,
        loadMcps: this.deps.loadMcps,
        getAvailableMcpNames: this.deps.getAvailableMcpNames,
        connectMcp: this.deps.connectMcp,
        disconnectMcp: this.deps.disconnectMcp,
        logError: this.deps.logError,
      },
      sessionId
    );
  };

  readonly applySessionMcps = async (names: string[], sessionId: string | null | undefined) => {
    await applySessionMcpsWithDependencies(
      {
        setSelectedMcpsForSession: this.deps.setSelectedMcpsForSession,
        syncSessionMcps: this.syncSessionMcps,
      },
      names,
      sessionId
    );
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
