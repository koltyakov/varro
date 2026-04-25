import type { Memento } from 'vscode';
import type { RecycleBinEntry, RecycleBinSession } from '../shared/protocol';

const SESSION_TRASH_KEY = 'varro.sessionTrash';
export const SESSION_TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;

export class SessionTrashManager {
  private readonly entries = new Map<string, RecycleBinEntry>();

  constructor(private readonly workspaceState: Memento) {
    const stored = workspaceState.get<RecycleBinEntry[]>(SESSION_TRASH_KEY, []) || [];
    for (const entry of stored) {
      const normalized = normalizeEntry(entry);
      if (normalized) this.entries.set(normalized.rootID, normalized);
    }
  }

  list() {
    return [...this.entries.values()].toSorted((left, right) => right.deletedAt - left.deletedAt);
  }

  isHidden(sessionID: string | null | undefined) {
    if (!sessionID) return false;
    return this.hiddenSessionIds().has(sessionID);
  }

  hiddenSessionIds() {
    const ids = new Set<string>();
    for (const entry of this.entries.values()) {
      for (const session of entry.sessions) ids.add(session.id);
    }
    return ids;
  }

  filterVisibleSessions<T extends { id: string }>(sessions: T[]) {
    const hidden = this.hiddenSessionIds();
    return sessions.filter((session) => !hidden.has(session.id));
  }

  filterVisibleSessionStatuses<T>(statuses: Record<string, T>) {
    const hidden = this.hiddenSessionIds();
    return Object.fromEntries(
      Object.entries(statuses).filter(([sessionID]) => !hidden.has(sessionID))
    ) as Record<string, T>;
  }

  filterVisibleSessionRequests<T extends { sessionID: string }>(items: T[]) {
    const hidden = this.hiddenSessionIds();
    return items.filter((item) => !hidden.has(item.sessionID));
  }

  async moveToTrash(sessionID: string, sessions: RecycleBinSession[], now = Date.now()) {
    if (this.isHidden(sessionID)) return this.entries.get(sessionID) || null;
    const root = sessions.find((session) => session.id === sessionID);
    if (!root) return null;
    const tree = collectSessionTree(sessionID, sessions);
    if (tree.length === 0) return null;

    const entry: RecycleBinEntry = {
      rootID: sessionID,
      deletedAt: now,
      expiresAt: now + SESSION_TRASH_RETENTION_MS,
      root: cloneSession(root),
      sessions: tree.map(cloneSession),
    };
    this.entries.set(entry.rootID, entry);
    await this.persist();
    return entry;
  }

  async restore(rootID: string) {
    const entry = this.entries.get(rootID) || null;
    if (!entry) return null;
    this.entries.delete(rootID);
    await this.persist();
    return entry;
  }

  async deletePermanently(rootID: string, deleteSession: (sessionID: string) => Promise<unknown>) {
    const entry = this.entries.get(rootID) || null;
    if (!entry) return null;
    await deleteEntrySessions(entry, deleteSession);
    this.entries.delete(rootID);
    await this.persist();
    return entry;
  }

  async cleanupExpired(deleteSession: (sessionID: string) => Promise<unknown>, now = Date.now()) {
    const removed: RecycleBinEntry[] = [];
    for (const entry of this.list()) {
      if (entry.expiresAt > now) continue;
      try {
        await deleteEntrySessions(entry, deleteSession);
        this.entries.delete(entry.rootID);
        removed.push(entry);
      } catch {
        // Keep failed cleanup entries so the next maintenance pass can retry.
      }
    }

    if (removed.length > 0) {
      await this.persist();
    }
    return removed;
  }

  async empty(deleteSession: (sessionID: string) => Promise<unknown>) {
    const removed: RecycleBinEntry[] = [];
    for (const entry of this.list()) {
      await deleteEntrySessions(entry, deleteSession);
      this.entries.delete(entry.rootID);
      removed.push(entry);
    }
    await this.persist();
    return removed;
  }

  private async persist() {
    await this.workspaceState.update(SESSION_TRASH_KEY, this.list());
  }
}

function collectSessionTree(rootID: string, sessions: RecycleBinSession[]) {
  const tree: RecycleBinSession[] = [];
  const pending = [rootID];
  while (pending.length > 0) {
    const currentID = pending.pop();
    if (!currentID || tree.some((session) => session.id === currentID)) continue;
    const session = sessions.find((item) => item.id === currentID);
    if (!session) continue;
    tree.push(session);
    for (const child of sessions) {
      if (child.parentID === currentID) pending.push(child.id);
    }
  }
  return tree.toSorted((left, right) => right.time.updated - left.time.updated);
}

function cloneSession(session: RecycleBinSession): RecycleBinSession {
  return {
    ...session,
    ...(session.summary ? { summary: { ...session.summary } } : {}),
    time: { ...session.time },
  };
}

function normalizeEntry(value: unknown): RecycleBinEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const rootID = typeof record.rootID === 'string' ? record.rootID : null;
  const deletedAt = typeof record.deletedAt === 'number' ? record.deletedAt : null;
  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : null;
  const root = normalizeSession(record.root);
  const sessions = Array.isArray(record.sessions)
    ? record.sessions
        .map(normalizeSession)
        .filter((session): session is RecycleBinSession => !!session)
    : [];
  if (!rootID || deletedAt === null || expiresAt === null || !root || sessions.length === 0) {
    return null;
  }
  return { rootID, deletedAt, expiresAt, root, sessions };
}

function normalizeSession(value: unknown): RecycleBinSession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const time = record.time as Record<string, unknown> | undefined;
  if (
    typeof record.id !== 'string' ||
    typeof record.projectID !== 'string' ||
    typeof record.directory !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.version !== 'string' ||
    typeof time?.created !== 'number' ||
    typeof time.updated !== 'number'
  ) {
    return null;
  }
  const summary = record.summary as Record<string, unknown> | undefined;
  return {
    id: record.id,
    projectID: record.projectID,
    directory: record.directory,
    ...(typeof record.parentID === 'string' ? { parentID: record.parentID } : {}),
    ...(summary &&
    typeof summary.additions === 'number' &&
    typeof summary.deletions === 'number' &&
    typeof summary.files === 'number'
      ? {
          summary: {
            additions: summary.additions,
            deletions: summary.deletions,
            files: summary.files,
          },
        }
      : {}),
    title: record.title,
    version: record.version,
    time: {
      created: time.created,
      updated: time.updated,
      ...(typeof time.compacting === 'number' ? { compacting: time.compacting } : {}),
    },
  };
}

async function deleteIgnoringMissing(
  sessionID: string,
  deleteSession: (sessionID: string) => Promise<unknown>
) {
  try {
    await deleteSession(sessionID);
  } catch (error) {
    if (!(error instanceof Error) || !/\b404\b/.test(error.message)) throw error;
  }
}

async function deleteEntrySessions(
  entry: RecycleBinEntry,
  deleteSession: (sessionID: string) => Promise<unknown>
) {
  for (const session of entry.sessions) {
    await deleteIgnoringMissing(session.id, deleteSession);
  }
}
