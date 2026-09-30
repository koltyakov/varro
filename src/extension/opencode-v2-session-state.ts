import { mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { asRecord, type UnknownRecord } from '../shared/type-utils';

/** V2 cannot patch metadata or archive timestamps. These are Varro-owned annotations. */
export class OpenCodeV2SessionState {
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(
    readonly directory = join(
      process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
      'varro',
      'opencode-v2'
    )
  ) {}

  async read(sessionID: string): Promise<UnknownRecord> {
    try {
      return asRecord(JSON.parse(await readFile(this.path(sessionID), 'utf8'))) ?? {};
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return {};
      throw new Error('Could not read Varro OpenCode v2 session annotations', { cause: error });
    }
  }

  async update(sessionID: string, patch: UnknownRecord, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return this.mutate(
      sessionID,
      async () => {
        signal?.throwIfAborted();
        const current = await this.read(sessionID);
        signal?.throwIfAborted();
        const next = {
          ...current,
          ...patch,
          time: { ...asRecord(current.time), ...asRecord(patch.time) },
        };
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const path = this.path(sessionID);
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next), { mode: 0o600, signal });
          signal?.throwIfAborted();
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true });
        }
      },
      signal
    );
  }

  async remove(sessionID: string): Promise<void> {
    return this.mutate(sessionID, () => rm(this.path(sessionID), { force: true }));
  }

  private async mutate(
    sessionID: string,
    run: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    const previous = this.operations.get(sessionID);
    const operation = (async () => {
      // A failed operation must not block a later update or cleanup.
      await previous?.catch(() => {});
      const release = await this.acquireLock(sessionID, signal);
      try {
        signal?.throwIfAborted();
        await run();
      } finally {
        await release();
      }
    })();
    this.operations.set(sessionID, operation);
    try {
      await operation;
    } finally {
      if (this.operations.get(sessionID) === operation) this.operations.delete(sessionID);
    }
  }

  private async acquireLock(sessionID: string, signal?: AbortSignal): Promise<() => Promise<void>> {
    const lock = `${this.path(sessionID)}.lock`;
    const owner = `${process.pid}-${randomUUID()}`;
    const candidate = `${lock}.${owner}`;
    const deadline = Date.now() + 10_000;
    let contentionError: unknown;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    while (true) {
      signal?.throwIfAborted();
      let publishing = false;
      try {
        // Publish a nonempty directory atomically, so contenders always see its owner.
        await mkdir(candidate, { mode: 0o700 });
        await writeFile(join(candidate, owner), '', { flag: 'wx', mode: 0o600 });
        publishing = true;
        await rename(candidate, lock);
        return async () => {
          await unlink(join(lock, owner));
          // A contender can replace the empty directory after we remove our owner.
          await removeEmptyLock(lock);
        };
      } catch (error) {
        const code = asRecord(error)?.code;
        if (code === 'EPERM' && publishing) {
          // Windows reports an existing destination directory as EPERM on rename.
          // Confirm that it is a readable lock, or has just been released.
          try {
            await readdir(lock);
          } catch (inspectionError) {
            if (asRecord(inspectionError)?.code !== 'ENOENT') throw error;
          }
        } else if (!['EEXIST', 'ENOTEMPTY'].includes(String(code))) throw error;
        contentionError = error;
      } finally {
        await rm(candidate, { recursive: true, force: true });
      }
      try {
        const owners = await readdir(lock);
        if (owners.length === 0) {
          await removeEmptyLock(lock);
        }
        const oldOwner = owners[0];
        if (owners.length === 1 && oldOwner && /^\d+-[a-f0-9-]{36}$/.test(oldOwner)) {
          const pid = Number(oldOwner.split('-')[0]);
          if (Number.isSafeInteger(pid) && pid > 0 && isDeadProcess(pid)) {
            // Remove only this dead owner's marker. Never delete a replacement lock.
            await unlink(join(lock, oldOwner));
            await removeEmptyLock(lock);
          }
        }
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(asRecord(error)?.code))) throw error;
      }
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting to update Varro session annotations', {
          cause: contentionError,
        });
      await delay(25, undefined, { signal });
    }
  }

  private path(sessionID: string): string {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(sessionID)) throw new Error('Invalid OpenCode session ID');
    return join(this.directory, `${sessionID}.json`);
  }
}

function isDeadProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return asRecord(error)?.code === 'ESRCH';
  }
}

async function removeEmptyLock(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    // Another contender may already have replaced or removed the empty directory.
    if (asRecord(error)?.code === 'EPERM') {
      try {
        if ((await readdir(path)).length > 0) return;
      } catch (inspectionError) {
        if (asRecord(inspectionError)?.code === 'ENOENT') return;
      }
    }
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(asRecord(error)?.code))) throw error;
  }
}
