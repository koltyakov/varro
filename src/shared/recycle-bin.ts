import type { RecycleBinEntry, RecycleBinSession } from './protocol';
import { isSameWorkspacePath } from './workspace-path';

export function normalizeRecycleBinEntries(value: unknown): RecycleBinEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = value
    .map(normalizeRecycleBinEntry)
    .filter((entry): entry is RecycleBinEntry => !!entry);
  const sessionIDCounts = new Map<string, number>();
  for (const entry of entries) {
    for (const session of entry.sessions) {
      sessionIDCounts.set(session.id, (sessionIDCounts.get(session.id) ?? 0) + 1);
    }
  }
  return entries.filter((entry) =>
    entry.sessions.every((session) => sessionIDCounts.get(session.id) === 1)
  );
}

export function normalizeRecycleBinEntry(value: unknown): RecycleBinEntry | null {
  const record = asRecord(value);
  if (!record) return null;

  const rootID = isNonEmptyString(record.rootID) ? record.rootID : null;
  const deletedAt = isSaneTimestamp(record.deletedAt) ? record.deletedAt : null;
  const expiresAt = isSaneTimestamp(record.expiresAt) ? record.expiresAt : null;
  const root = normalizeRecycleBinSession(record.root);
  if (!Array.isArray(record.sessions)) return null;
  const normalizedSessions = record.sessions.map(normalizeRecycleBinSession);

  if (
    !rootID ||
    deletedAt === null ||
    expiresAt === null ||
    expiresAt < deletedAt ||
    !root ||
    root.id !== rootID ||
    normalizedSessions.length === 0 ||
    normalizedSessions.some((session) => !session)
  ) {
    return null;
  }

  const sessions = normalizedSessions as RecycleBinSession[];
  const sessionsByID = new Map<string, RecycleBinSession>();
  for (const session of sessions) {
    if (sessionsByID.has(session.id)) return null;
    sessionsByID.set(session.id, session);
  }
  const listedRoot = sessionsByID.get(rootID);
  if (!listedRoot) return null;
  if (!areRecycleBinSessionsEqual(root, listedRoot)) return null;
  if (listedRoot.parentID && sessionsByID.has(listedRoot.parentID)) return null;
  if (!sessions.every((session) => isRootOrDescendant(session, rootID, sessionsByID))) return null;
  if (
    !sessions.every(
      (session) =>
        session.projectID === root.projectID &&
        isSameWorkspacePath(session.directory, root.directory)
    )
  ) {
    return null;
  }

  return { rootID, deletedAt, expiresAt, root, sessions };
}

export function normalizeRecycleBinSession(value: unknown): RecycleBinSession | null {
  const record = asRecord(value);
  const time = asRecord(record?.time);
  if (
    !record ||
    !isNonEmptyString(record.id) ||
    !isNonEmptyString(record.projectID) ||
    !isNonEmptyString(record.directory) ||
    typeof record.title !== 'string' ||
    !isNonEmptyString(record.version) ||
    !isSaneTimestamp(time?.created) ||
    !isSaneTimestamp(time.updated) ||
    time.updated < time.created ||
    (time.compacting !== undefined && !isSaneTimestamp(time.compacting)) ||
    (record.parentID !== undefined && !isNonEmptyString(record.parentID))
  ) {
    return null;
  }

  const summary = asRecord(record.summary);
  if (record.summary !== undefined && !isRecycleBinSummary(summary)) return null;
  return {
    id: record.id,
    projectID: record.projectID,
    directory: record.directory,
    ...(typeof record.parentID === 'string' ? { parentID: record.parentID } : {}),
    ...(isRecycleBinSummary(summary)
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

function areRecycleBinSessionsEqual(left: RecycleBinSession, right: RecycleBinSession) {
  return (
    left.id === right.id &&
    left.projectID === right.projectID &&
    left.directory === right.directory &&
    left.parentID === right.parentID &&
    left.title === right.title &&
    left.version === right.version &&
    left.time.created === right.time.created &&
    left.time.updated === right.time.updated &&
    left.time.compacting === right.time.compacting &&
    left.summary?.additions === right.summary?.additions &&
    left.summary?.deletions === right.summary?.deletions &&
    left.summary?.files === right.summary?.files
  );
}

function isRecycleBinSummary(
  value: Record<string, unknown> | null
): value is { additions: number; deletions: number; files: number } {
  return (
    !!value &&
    isSaneCount(value.additions) &&
    isSaneCount(value.deletions) &&
    isSaneCount(value.files)
  );
}

function isSaneCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRootOrDescendant(
  session: RecycleBinSession,
  rootID: string,
  sessionsByID: ReadonlyMap<string, RecycleBinSession>
) {
  if (session.id === rootID) return true;

  const visited = new Set([session.id]);
  let current = session;
  while (current.parentID) {
    if (current.parentID === rootID) return true;
    if (visited.has(current.parentID)) return false;
    visited.add(current.parentID);
    const parent = sessionsByID.get(current.parentID);
    if (!parent) return false;
    current = parent;
  }
  return false;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSaneTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
