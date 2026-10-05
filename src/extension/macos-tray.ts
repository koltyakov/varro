import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SessionStateManager } from './session-state-manager';

export type TrayStatus =
  | 'running'
  | 'permission'
  | 'question'
  | 'error'
  | 'plan-ready'
  | 'completed';

export interface TraySession {
  id: string;
  title: string;
  project: string;
  projectUrl: string;
  projectID?: string;
  status: TrayStatus;
  updatedAt: number;
  turnStartedAt?: number;
}

export interface TrayProject {
  id: string;
  name: string;
  url: string;
}

export interface TraySnapshot {
  version: 1;
  instanceID: string;
  available: boolean;
  eventDriven: true;
  projects: TrayProject[];
  sessions: TraySession[];
}

interface TrayProjectionHost {
  state: Pick<
    SessionStateManager,
    | 'busy'
    | 'completed'
    | 'failed'
    | 'pendingForUser'
    | 'rootSessionIdFor'
    | 'directoryFor'
    | 'titleFor'
    | 'isPlanSession'
    | 'completionMarkerFor'
    | 'failureMarkerFor'
    | 'busyStartedAtFor'
  >;
  serverIdentity: string;
  readState: Readonly<Record<string, number>>;
  runningSessionIDs?: readonly string[];
  includes(sessionID: string): boolean;
  projectFor(sessionID: string): TrayProject;
}

const PRIORITY: Record<TrayStatus, number> = {
  permission: 6,
  question: 5,
  error: 4,
  running: 3,
  'plan-ready': 2,
  completed: 1,
};

/** Projects existing host state without changing unread markers or permission ownership. */
export function projectTraySessions(host: TrayProjectionHost): TraySession[] {
  const rows = new Map<string, TraySession>();
  const add = (sessionID: string, status: TrayStatus) => {
    const root = host.state.rootSessionIdFor(sessionID);
    if (!host.includes(sessionID) || !host.includes(root)) return;
    const eventAt =
      status === 'error'
        ? (host.state.failureMarkerFor(sessionID) ?? host.state.failureMarkerFor(root))
        : (host.state.completionMarkerFor(sessionID) ?? host.state.completionMarkerFor(root));
    if (status === 'completed' || status === 'plan-ready' || status === 'error') {
      const seenAt = Math.max(host.readState[root] ?? -1, host.readState[sessionID] ?? -1);
      // Read markers survive editor reloads; a delayed terminal event can outlive its unread UI.
      // Only suppress that known turn, never a later completion or a pending request.
      if (eventAt !== undefined && eventAt <= seenAt) return;
    }
    const project = host.projectFor(sessionID);
    if (!project.url) return;
    const id = createHash('sha256')
      .update(JSON.stringify([host.serverIdentity, host.state.directoryFor(root), root]))
      .digest('hex');
    const previous = rows.get(id);
    if (
      previous &&
      (PRIORITY[previous.status] > PRIORITY[status] ||
        (previous.status === status && previous.updatedAt >= (eventAt ?? 0)))
    )
      return;
    rows.set(id, {
      id,
      title: (host.state.titleFor(root) || host.state.titleFor(sessionID) || 'Untitled chat').slice(
        0,
        180
      ),
      project: project.name.slice(0, 180),
      projectUrl: project.url,
      projectID: project.id,
      status,
      updatedAt: eventAt ?? 0,
      turnStartedAt: host.state.busyStartedAtFor(root) ?? host.state.busyStartedAtFor(sessionID),
    });
  };
  for (const id of host.state.completed)
    add(id, host.state.isPlanSession(id) ? 'plan-ready' : 'completed');
  for (const id of host.state.busy) add(id, 'running');
  for (const id of host.runningSessionIDs ?? []) add(id, 'running');
  for (const id of host.state.failed) add(id, 'error');
  for (const request of host.state.pendingForUser.values()) add(request.sessionID, request.kind);
  return [...rows.values()]
    .toSorted((a, b) => PRIORITY[b.status] - PRIORITY[a.status])
    .slice(0, 256);
}

/**
 * Optional, outbound-only publisher. The app creates its private directory on first launch.
 * Without that directory this stays inert: no watcher, no timers, and no per-update checks.
 */
export class MacOSTray {
  private readonly instanceID = randomUUID();
  private socket: Socket | undefined;
  private watcher: FSWatcher | undefined;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAllowed = true;
  private connected = false;
  private disposed = false;
  private socketIdentity: string | undefined;
  private lastFrame: string | undefined;
  private readonly observed = new Map<string, TraySession>();

  constructor(
    private readonly sessions: () => TraySession[],
    private readonly socketPath = join(
      homedir(),
      'Library',
      'Application Support',
      'Varro',
      'tray',
      'tray.sock'
    ),
    private readonly available: () => boolean = () => true,
    private readonly projects: () => TrayProject[] = () => []
  ) {
    void this.start();
  }

  update(): void {
    // Host state only matters to a live app connection. Discovery is driven by socket events.
    if (!this.connected || this.updateTimer) return;
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      // The connection outlived its first frame, so a later reset earns one recovery attempt.
      this.reconnectAllowed = true;
      this.publish();
    }, 200);
    this.updateTimer.unref();
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = undefined;
    this.detach()?.destroy();
    this.observed.clear();
  }

  private async start(): Promise<void> {
    const directory = dirname(this.socketPath);
    try {
      // Never send project metadata to a socket outside the user's private app directory.
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
        return;
    } catch {
      // Not installed. Stay inert for this extension host's lifetime.
      return;
    }
    if (this.disposed) return;
    try {
      // The app directory only holds its socket, lock, and history file, so this stays quiet.
      const name = basename(this.socketPath);
      const watcher = watch(directory, { persistent: false }, (_event, filename) => {
        if (!filename || filename.toString() === name) void this.socketChanged();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
        // Best effort: the next extension host discovers the app again.
      });
      this.watcher = watcher;
    } catch {
      return;
    }
    await this.socketChanged();
  }

  private async socketChanged(): Promise<void> {
    let identity: string | undefined;
    try {
      const file = await lstat(this.socketPath);
      if (file.isSocket() && file.uid === process.getuid?.())
        identity = `${file.dev}:${file.ino}:${file.birthtimeMs}`;
    } catch {
      // A removal notification normally arrives after the socket has disappeared.
    }
    // macOS can report creation as change, and connections can touch metadata too.
    // Only a different socket identity should restart the connection.
    if (this.disposed || identity === this.socketIdentity) return;
    this.socketIdentity = identity;
    this.reconnectAllowed = true;
    this.detach()?.destroy();
    if (identity) this.connect();
  }

  private connect(): void {
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.unref();
    socket.setTimeout(2_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (this.socket !== socket) return;
      const wasConnected = this.connected;
      this.detach();
      // One immediate recovery attempt after a reset. A stale socket or a peer that keeps
      // rejecting waits for the app to replace its socket instead of a retry loop.
      if (wasConnected && this.reconnectAllowed && !this.disposed) {
        this.reconnectAllowed = false;
        this.connect();
      }
    });
    // The protocol is one-way; the native app cannot issue extension commands.
    socket.on('data', () => socket.destroy());
    socket.once('connect', () => {
      socket.setTimeout(0);
      this.connected = true;
      this.lastFrame = undefined;
      this.publish();
    });
  }

  /** Forgets the current connection and returns it for the caller to close. */
  private detach(): Socket | undefined {
    const socket = this.socket;
    this.socket = undefined;
    this.connected = false;
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    return socket;
  }

  private readSessions(): TraySession[] {
    const next = new Map<string, TraySession>();
    for (const row of this.sessions()) {
      const previous = this.observed.get(row.id);
      const updatedAt =
        row.status === 'completed' || row.status === 'plan-ready' || row.status === 'error'
          ? row.updatedAt || (previous?.status === row.status ? previous.updatedAt : Date.now())
          : previous?.status === row.status && previous.turnStartedAt === row.turnStartedAt
            ? previous.updatedAt
            : Date.now();
      next.set(row.id, { ...row, updatedAt });
    }
    this.observed.clear();
    for (const [id, row] of next) this.observed.set(id, row);
    return [...next.values()];
  }

  private publish(): void {
    if (!this.socket || !this.connected || this.disposed) return;
    // The host's completion set is unread state. Never replay an acknowledged completion.
    const snapshot: TraySnapshot = {
      version: 1,
      instanceID: this.instanceID,
      available: this.available(),
      eventDriven: true,
      projects: this.projects().slice(0, 256),
      sessions: this.readSessions()
        .toSorted((a, b) => PRIORITY[b.status] - PRIORITY[a.status])
        .slice(0, 256),
    };
    const frame = `${JSON.stringify(snapshot)}\n`;
    if (frame === this.lastFrame) return;
    if (Buffer.byteLength(frame) > 1_048_576 || this.socket.writableLength > 1_048_576) {
      this.socket.destroy();
      return;
    }
    this.socket.write(frame);
    this.lastFrame = frame;
  }
}
