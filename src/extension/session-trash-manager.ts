import type { Persistence } from '../shared/persistence';
import { normalizeRecycleBinEntry, normalizeRecycleBinSession } from '../shared/recycle-bin';
import type { RecycleBinEntry, RecycleBinSession } from '../shared/protocol';

export type SessionDeleteTarget = {
  id: string;
  directory?: string;
};

const SESSION_TRASH_KEY = 'varro.sessionTrash';
export const SESSION_TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;

export class SessionTrashManager {
  private entries = new Map<string, RecycleBinEntry>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const value = persistence.get<unknown>(SESSION_TRASH_KEY);
    const stored = Array.isArray(value) ? value : [];
    for (const entry of stored) {
      const normalized = normalizeRecycleBinEntry(entry);
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

  async moveToTrash(sessionID: string, sessions: unknown[], now = Date.now()) {
    return this.mutate(async () => {
      if (this.isHidden(sessionID)) return this.entries.get(sessionID) || null;
      const normalized = sessions
        .map(normalizeRecycleBinSession)
        .filter((session): session is RecycleBinSession => !!session);
      const root = normalized.find((session) => session.id === sessionID);
      if (!root) return null;
      const tree = collectSessionTree(sessionID, normalized);
      if (tree.length === 0) return null;

      const entry: RecycleBinEntry = {
        rootID: sessionID,
        deletedAt: now,
        expiresAt: now + SESSION_TRASH_RETENTION_MS,
        root: cloneSession(root),
        sessions: tree.map(cloneSession),
      };
      const next = new Map(this.entries);
      next.set(entry.rootID, entry);
      await this.persist(next);
      this.entries = next;
      return entry;
    });
  }

  async restore(rootID: string) {
    return this.mutate(async () => {
      const entry = this.entries.get(rootID) || null;
      if (!entry) return null;
      const next = new Map(this.entries);
      next.delete(rootID);
      await this.persist(next);
      this.entries = next;
      return entry;
    });
  }

  async deletePermanently(
    rootID: string,
    deleteSession: (target: SessionDeleteTarget) => Promise<unknown>
  ) {
    return this.mutate(async () => {
      const entry = this.entries.get(rootID) || null;
      if (!entry) return null;
      await deleteEntrySessions(entry, deleteSession);
      const next = new Map(this.entries);
      next.delete(rootID);
      await this.persist(next);
      this.entries = next;
      return entry;
    });
  }

  async cleanupExpired(
    deleteSession: (target: SessionDeleteTarget) => Promise<unknown>,
    now = Date.now()
  ) {
    return this.mutate(async () => {
      const removed: RecycleBinEntry[] = [];
      const next = new Map(this.entries);
      for (const entry of this.list()) {
        if (entry.expiresAt > now) continue;
        try {
          await deleteEntrySessions(entry, deleteSession);
          next.delete(entry.rootID);
          removed.push(entry);
        } catch {
          // Keep failed cleanup entries so the next maintenance pass can retry.
        }
      }

      if (removed.length > 0) {
        await this.persist(next);
        this.entries = next;
      }
      return removed;
    });
  }

  async empty(deleteSession: (target: SessionDeleteTarget) => Promise<unknown>) {
    return this.mutate(async () => {
      const removed: RecycleBinEntry[] = [];
      for (const entry of this.list()) {
        await deleteEntrySessions(entry, deleteSession);
        removed.push(entry);
      }
      const next = new Map<string, RecycleBinEntry>();
      await this.persist(next);
      this.entries = next;
      return removed;
    });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async persist(entries: ReadonlyMap<string, RecycleBinEntry>) {
    await this.persistence.set(SESSION_TRASH_KEY, listEntries(entries));
  }
}

function listEntries(entries: ReadonlyMap<string, RecycleBinEntry>) {
  return [...entries.values()].toSorted((left, right) => right.deletedAt - left.deletedAt);
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

async function deleteIgnoringMissing(
  session: RecycleBinSession,
  deleteSession: (target: SessionDeleteTarget) => Promise<unknown>
) {
  try {
    await deleteSession({ id: session.id, directory: session.directory });
  } catch (error) {
    if (!(error instanceof Error) || !/\b404\b/.test(error.message)) throw error;
  }
}

async function deleteEntrySessions(
  entry: RecycleBinEntry,
  deleteSession: (target: SessionDeleteTarget) => Promise<unknown>
) {
  for (const session of entry.sessions) {
    await deleteIgnoringMissing(session, deleteSession);
  }
}
