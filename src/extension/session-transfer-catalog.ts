/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Persisted and server session records are parsed at this boundary. */
import type { Session } from '../shared/opencode-types';
import type { Persistence } from '../shared/persistence';
import { isSafePersistedSessionId } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
import { isSameWorkspacePath } from '../shared/workspace-path';

type TransferEntry = { server: string; origins: string[]; session: Session };
const STORAGE_KEY = 'varro.sessionTransfers';
const MAX_TRANSFERS = 512;

export class SessionTransferCatalog {
  private readonly entries = new Map<string, TransferEntry>();

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(stored)) return;
    for (const value of stored.slice(-MAX_TRANSFERS)) {
      const entry = asRecord(value);
      const session = readSummary(entry?.session);
      const origins = Array.isArray(entry?.origins) ? entry.origins.filter(isDirectory) : [];
      if (session?.transfer && typeof entry?.server === 'string' && origins.length)
        this.entries.set(`${entry.server}\0${session.id}`, {
          server: entry.server,
          origins: origins.slice(0, 32),
          session,
        });
    }
  }

  async remember(server: string, value: unknown, originDirectory: string, origins: string[]) {
    const session = readSummary(value);
    if (!server || !session || !isDirectory(originDirectory) || !origins.length) return;
    const key = `${server}\0${session.id}`;
    const previous = this.entries.get(key);
    session.transfer = {
      originDirectory: previous?.session.transfer?.originDirectory ?? originDirectory,
      available: false,
    };
    if (previous) {
      previous.session = session;
      previous.origins = [...new Set([...previous.origins, ...origins.filter(isDirectory)])].slice(
        0,
        32
      );
    } else {
      this.entries.set(key, { server, origins: origins.filter(isDirectory).slice(0, 32), session });
      if (this.entries.size > MAX_TRANSFERS) this.entries.delete(this.entries.keys().next().value!);
    }
    await this.persistence.set(STORAGE_KEY, [...this.entries.values()]);
  }

  list(server: string, roots: readonly string[]): Session[] {
    return [...this.entries.values()]
      .filter(
        (entry) =>
          entry.server === server &&
          entry.origins.some((origin) => roots.some((root) => isSameWorkspacePath(origin, root)))
      )
      .map((entry) => ({
        ...entry.session,
        transfer: {
          originDirectory: entry.session.transfer!.originDirectory,
          available: roots.some((root) => isSameWorkspacePath(root, entry.session.directory)),
        },
      }));
  }

  get(server: string, roots: readonly string[], sessionId: string): Session | undefined {
    const entry = this.entries.get(`${server}\0${sessionId}`);
    return entry?.origins.some((origin) => roots.some((root) => isSameWorkspacePath(origin, root)))
      ? entry.session
      : undefined;
  }

  async remove(server: string, sessionId: string) {
    if (!this.entries.delete(`${server}\0${sessionId}`)) return;
    await this.persistence.set(STORAGE_KEY, [...this.entries.values()]);
  }
}

function isDirectory<T>(value: T): value is T & string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/\p{Cc}/u.test(value)
  );
}

function readSummary(value: unknown): Session | undefined {
  const record = asRecord(value);
  const time = asRecord(record?.time);
  if (
    !isSafePersistedSessionId(record?.id) ||
    !isDirectory(record.directory) ||
    typeof record.projectID !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.version !== 'string' ||
    typeof time?.created !== 'number' ||
    !Number.isFinite(time.created) ||
    typeof time.updated !== 'number' ||
    !Number.isFinite(time.updated) ||
    typeof time.archived === 'number'
  )
    return;
  const summary: Session = {
    id: record.id,
    projectID: record.projectID,
    directory: record.directory,
    title: record.title.slice(0, 2048),
    version: record.version,
    time: { created: time.created, updated: time.updated },
  };
  if (typeof record.parentID === 'string') summary.parentID = record.parentID;
  if (record.workspaceScope === 'workspace') summary.workspaceScope = 'workspace';
  const transfer = asRecord(record.transfer);
  if (isDirectory(transfer?.originDirectory))
    summary.transfer = { originDirectory: transfer.originDirectory, available: false };
  return summary;
}
