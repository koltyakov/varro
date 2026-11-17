import { isAbsolute } from 'node:path';
import type { Memento } from 'vscode';
import type { SessionLookup } from '../shared/protocol';
import { isSafePersistedSessionId } from '../shared/protocol';
import { asRecord, isNumber, isString } from '../shared/type-utils';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';

const MAX_AGE_MS = 120_000;

// The handoff is UI state only. Session records and the source window's catalog
// stay untouched. A newly opened project consumes its own short-lived request.
export class SessionProjectWindow {
  constructor(private readonly storage: Memento) {}

  async queue(session: SessionLookup, serverUrl: string): Promise<void> {
    if (!serverUrl || !isAbsolute(session.directory) || !isSafePersistedSessionId(session.id)) {
      throw new Error('Session project window is unavailable');
    }
    await this.storage.update(this.key(session.directory), {
      id: session.id,
      directory: session.directory,
      serverUrl,
      createdAt: Date.now(),
    });
  }

  async take(
    directories: readonly string[],
    serverUrl: string | undefined
  ): Promise<{
    id: string;
    directory: string;
  } | null> {
    for (const directory of directories) {
      const key = this.key(directory);
      const value = asRecord(this.storage.get<unknown>(key));
      if (!value) continue;
      if (
        !isSafePersistedSessionId(value.id) ||
        !isString(value.directory) ||
        !isSameWorkspacePath(value.directory, directory) ||
        !isNumber(value.createdAt) ||
        !Number.isFinite(value.createdAt) ||
        Date.now() - value.createdAt > MAX_AGE_MS ||
        value.createdAt > Date.now()
      ) {
        await this.storage.update(key, undefined);
        continue;
      }
      if (!serverUrl || value.serverUrl !== serverUrl) continue;
      await this.storage.update(key, undefined);
      return { id: value.id, directory: value.directory };
    }
    return null;
  }

  private key(directory: string): string {
    return `varro.sessionProjectWindow:${normalizeWorkspaceIdentity(directory) ?? directory}`;
  }
}
