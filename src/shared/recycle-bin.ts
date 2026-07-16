import type { RecycleBinEntry, RecycleBinSession } from './protocol';

export function normalizeRecycleBinEntries(value: unknown): RecycleBinEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeRecycleBinEntry).filter((entry): entry is RecycleBinEntry => !!entry);
}

export function normalizeRecycleBinEntry(value: unknown): RecycleBinEntry | null {
  const record = asRecord(value);
  if (!record) return null;

  const rootID = typeof record.rootID === 'string' ? record.rootID : null;
  const deletedAt = typeof record.deletedAt === 'number' ? record.deletedAt : null;
  const expiresAt = typeof record.expiresAt === 'number' ? record.expiresAt : null;
  const root = normalizeRecycleBinSession(record.root);
  const sessions = Array.isArray(record.sessions)
    ? record.sessions
        .map(normalizeRecycleBinSession)
        .filter((session): session is RecycleBinSession => !!session)
    : [];

  if (!rootID || deletedAt === null || expiresAt === null || !root || sessions.length === 0) {
    return null;
  }

  return { rootID, deletedAt, expiresAt, root, sessions };
}

export function normalizeRecycleBinSession(value: unknown): RecycleBinSession | null {
  const record = asRecord(value);
  const time = asRecord(record?.time);
  if (
    !record ||
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

  const summary = asRecord(record.summary);
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}
