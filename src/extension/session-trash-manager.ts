/* oxlint-disable anti-slop/no-unknown-returns -- OpenCode deletion responses are intentionally opaque and only completion is observed. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Recycle-bin entries are normalized before restoration. */
import type { Persistence } from '../shared/persistence';
import { normalizeRecycleBinEntries, normalizeRecycleBinSession } from '../shared/recycle-bin';
import type { RecycleBinEntry, RecycleBinSession } from '../shared/protocol';
import { isSameWorkspacePath } from '../shared/workspace-path';

export type SessionDeleteTarget = {
  id: string;
  directory?: string;
};

const SESSION_TRASH_KEY = 'varro.sessionTrash';
export const SESSION_TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;

export class SessionTrashManager {
  private entries = new Map<string, RecycleBinEntry>();
  private hiddenIds = new Set<string>();
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const value = persistence.get<unknown>(SESSION_TRASH_KEY);
    const stored = Array.isArray(value) ? value : [];
    for (const entry of normalizeRecycleBinEntries(stored)) {
      this.entries.set(entry.rootID, entry);
    }
    this.hiddenIds = collectHiddenSessionIds(this.entries);
  }

  list(workspaceDirectory?: string) {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          workspaceDirectory === undefined ||
          isSameWorkspacePath(entry.root.directory, workspaceDirectory)
      )
      .toSorted((left, right) => right.deletedAt - left.deletedAt);
  }

  isHidden(sessionID: string | null | undefined) {
    return !!sessionID && this.hiddenIds.has(sessionID);
  }

  hiddenSessionIds() {
    return new Set(this.hiddenIds);
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
      const containingEntry = this.findEntryContaining(sessionID);
      if (containingEntry) return containingEntry;
      const normalized = sessions
        .map(normalizeRecycleBinSession)
        .filter((session): session is RecycleBinSession => !!session);
      const root = normalized.find((session) => session.id === sessionID);
      if (!root) return null;
      const tree = collectSessionTree(sessionID, normalized);
      if (tree.length === 0) return null;
      if (
        tree.some(
          (session) =>
            session.projectID !== root.projectID ||
            !isSameWorkspacePath(session.directory, root.directory)
        )
      ) {
        return null;
      }

      const entry: RecycleBinEntry = {
        rootID: sessionID,
        deletedAt: now,
        expiresAt: now + SESSION_TRASH_RETENTION_MS,
        root: cloneSession(root),
        sessions: tree.map(cloneSession),
      };
      const next = new Map(this.entries);
      const treeIDs = new Set(tree.map((session) => session.id));
      for (const existing of next.values()) {
        if (existing.sessions.some((session) => treeIDs.has(session.id))) {
          next.delete(existing.rootID);
        }
      }
      next.set(entry.rootID, entry);
      await this.persist(next);
      this.entries = next;
      this.hiddenIds = collectHiddenSessionIds(next);
      return entry;
    });
  }

  async restore(rootID: string, workspaceDirectory?: string) {
    return this.mutate(async () => {
      const entry = this.entries.get(rootID) || null;
      if (
        !entry ||
        (workspaceDirectory !== undefined &&
          !isSameWorkspacePath(entry.root.directory, workspaceDirectory))
      ) {
        return null;
      }
      const next = new Map(this.entries);
      next.delete(rootID);
      await this.persist(next);
      this.entries = next;
      this.hiddenIds = collectHiddenSessionIds(next);
      return entry;
    });
  }

  async deletePermanently(
    rootID: string,
    deleteSession: (target: SessionDeleteTarget) => Promise<unknown>,
    workspaceDirectory?: string
  ) {
    return this.mutate(async () => {
      const entry = this.entries.get(rootID) || null;
      if (
        !entry ||
        (workspaceDirectory !== undefined &&
          !isSameWorkspacePath(entry.root.directory, workspaceDirectory))
      ) {
        return null;
      }
      await deleteEntrySessions(entry, deleteSession);
      const next = new Map(this.entries);
      next.delete(rootID);
      await this.persist(next);
      this.entries = next;
      this.hiddenIds = collectHiddenSessionIds(next);
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
        this.hiddenIds = collectHiddenSessionIds(next);
      }
      return removed;
    });
  }

  async empty(
    deleteSession: (target: SessionDeleteTarget) => Promise<unknown>,
    workspaceDirectory?: string
  ) {
    return this.mutate(async () => {
      const removed: RecycleBinEntry[] = [];
      const next = new Map(this.entries);
      for (const entry of this.list(workspaceDirectory)) {
        await deleteEntrySessions(entry, deleteSession);
        next.delete(entry.rootID);
        removed.push(entry);
      }
      await this.persist(next);
      this.entries = next;
      this.hiddenIds = collectHiddenSessionIds(next);
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

  private findEntryContaining(sessionID: string) {
    return this.list().find((entry) => entry.sessions.some((session) => session.id === sessionID));
  }
}

function listEntries(entries: ReadonlyMap<string, RecycleBinEntry>) {
  return [...entries.values()].toSorted((left, right) => right.deletedAt - left.deletedAt);
}

function collectSessionTree(rootID: string, sessions: RecycleBinSession[]) {
  const tree: RecycleBinSession[] = [];
  const visited = new Set<string>();
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const children = childrenByParent.get(session.parentID) ?? [];
    children.push(session.id);
    childrenByParent.set(session.parentID, children);
  }
  const pending = [rootID];
  while (pending.length > 0) {
    const currentID = pending.pop();
    if (!currentID || visited.has(currentID)) continue;
    visited.add(currentID);
    const session = sessionsById.get(currentID);
    if (!session) continue;
    tree.push(session);
    pending.push(...(childrenByParent.get(currentID) ?? []));
  }
  return tree.toSorted((left, right) => right.time.updated - left.time.updated);
}

function collectHiddenSessionIds(entries: ReadonlyMap<string, RecycleBinEntry>) {
  const ids = new Set<string>();
  for (const entry of entries.values()) {
    for (const session of entry.sessions) ids.add(session.id);
  }
  return ids;
}

function cloneSession(session: RecycleBinSession): RecycleBinSession {
  const cloned: RecycleBinSession = {
    ...session,
    time: { ...session.time },
  };
  if (session.summary) cloned.summary = { ...session.summary };
  return cloned;
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
