import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { asRecord, type UnknownRecord } from '../shared/type-utils';

/** V2 cannot patch metadata or archive timestamps. These are Varro-owned annotations. */
export class OpenCodeV2SessionState {
  private readonly operations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly directory = join(
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

  async update(sessionID: string, patch: UnknownRecord): Promise<void> {
    const previous = this.operations.get(sessionID);
    const operation = (async () => {
      await previous?.catch(() => {});
      const current = await this.read(sessionID);
      const next = {
        ...current,
        ...patch,
        time: { ...asRecord(current.time), ...asRecord(patch.time) },
      };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const path = this.path(sessionID);
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    })();
    this.operations.set(sessionID, operation);
    try {
      await operation;
    } finally {
      if (this.operations.get(sessionID) === operation) this.operations.delete(sessionID);
    }
  }

  async remove(sessionID: string): Promise<void> {
    await this.operations.get(sessionID);
    await rm(this.path(sessionID), { force: true });
  }

  private path(sessionID: string): string {
    if (!/^[a-zA-Z0-9_-]{1,256}$/.test(sessionID)) throw new Error('Invalid OpenCode session ID');
    return join(this.directory, `${sessionID}.json`);
  }
}
