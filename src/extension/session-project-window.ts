import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { SessionLookup } from '../shared/protocol';
import { isSafePersistedSessionId } from '../shared/protocol';
import { asRecord, isNumber, isString } from '../shared/type-utils';
import { isSameWorkspacePath } from '../shared/workspace-path';

const MAX_AGE_MS = 120_000;
const MAX_REQUEST_BYTES = 16_384;
const REQUEST_NAME = /^[a-f0-9-]{36}\.varro-session$/;

type ProjectOpenRequest = {
  id: string;
  directory: string;
  serverUrl: string;
  createdAt: number;
};

// Opening this real, read-only document activates only the destination window.
// The custom editor consumes it, opens a normal chat editor, and closes itself.
export class SessionProjectWindow {
  static readonly viewType = 'varro.sessionLookup';

  constructor(private readonly storageDirectory?: string) {}

  async queue(session: SessionLookup, serverUrl: string): Promise<string> {
    if (!serverUrl || !isAbsolute(session.directory) || !isSafePersistedSessionId(session.id)) {
      throw new Error('Session project window is unavailable');
    }
    const directory = this.requestDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.requirePrivateDirectory();
    await this.pruneExpired();
    const filename = join(directory, `${randomUUID()}.varro-session`);
    await writeFile(
      filename,
      JSON.stringify({
        id: session.id,
        directory: session.directory,
        serverUrl,
        createdAt: Date.now(),
      }),
      { flag: 'wx', mode: 0o600 }
    );
    return filename;
  }

  async read(filename: string, directories: readonly string[]): Promise<ProjectOpenRequest> {
    this.requireRequestPath(filename);
    await this.requirePrivateDirectory();
    const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text: string;
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > MAX_REQUEST_BYTES ||
        (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
      ) {
        throw new Error('Session lookup request is not a private regular file');
      }
      const bytes = Buffer.alloc(MAX_REQUEST_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_REQUEST_BYTES) throw new Error('Session lookup request is too large');
      text = bytes.toString('utf8', 0, bytesRead);
    } finally {
      await file.close();
    }
    const value = asRecord(JSON.parse(text));
    const directory = value?.directory;
    if (
      !value ||
      !isSafePersistedSessionId(value.id) ||
      !isString(directory) ||
      !isAbsolute(directory) ||
      !directories.some((root) => isSameWorkspacePath(root, directory)) ||
      !isString(value.serverUrl) ||
      !value.serverUrl ||
      !isNumber(value.createdAt) ||
      !Number.isFinite(value.createdAt) ||
      Date.now() - value.createdAt > MAX_AGE_MS ||
      value.createdAt > Date.now()
    ) {
      throw new Error('Session lookup expired or does not belong to this project window');
    }
    return {
      id: value.id,
      directory,
      serverUrl: value.serverUrl,
      createdAt: value.createdAt,
    };
  }

  async consume(
    filename: string,
    expected: ProjectOpenRequest,
    serverUrl: string
  ): Promise<ProjectOpenRequest> {
    this.requireRequestPath(filename);
    await this.requirePrivateDirectory();
    const claimPath = `${filename}.claim`;
    const claim = await open(claimPath, 'wx', 0o600);
    try {
      const current = await this.read(filename, [expected.directory]);
      if (
        current.serverUrl !== serverUrl ||
        current.id !== expected.id ||
        current.createdAt !== expected.createdAt
      ) {
        throw new Error(
          'Session lookup belongs to a different OpenCode server or changed while opening'
        );
      }
      await unlink(filename);
      return current;
    } finally {
      await claim.close();
      await unlink(claimPath);
    }
  }

  async discard(filename: string): Promise<void> {
    this.requireRequestPath(filename);
    try {
      await unlink(filename);
    } catch (error) {
      // A destination may already have consumed the one-shot request.
      if (asRecord(error)?.code !== 'ENOENT') throw error;
    }
  }

  private requireRequestPath(filename: string): void {
    if (
      !isAbsolute(filename) ||
      !isSameWorkspacePath(dirname(filename), this.requestDirectory()) ||
      !REQUEST_NAME.test(basename(filename))
    ) {
      throw new Error('Invalid session lookup request');
    }
  }

  private async requirePrivateDirectory(): Promise<void> {
    const info = await lstat(this.requestDirectory());
    if (
      !info.isDirectory() ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    ) {
      throw new Error('Session lookup directory is not private');
    }
  }

  private async pruneExpired(): Promise<void> {
    const directory = this.requestDirectory();
    for (const name of await readdir(directory)) {
      const requestName = name.endsWith('.claim') ? name.slice(0, -6) : name;
      if (!REQUEST_NAME.test(requestName)) continue;
      const filename = join(directory, name);
      try {
        const info = await lstat(filename);
        if (info.isFile() && Date.now() - info.mtimeMs > MAX_AGE_MS) {
          if (name.endsWith('.claim')) await unlink(filename);
          else await this.discard(filename);
        }
      } catch (error) {
        // A destination may consume its marker while another source prunes.
        if (asRecord(error)?.code !== 'ENOENT') throw error;
      }
    }
  }

  private requestDirectory(): string {
    if (!this.storageDirectory || !isAbsolute(this.storageDirectory)) {
      throw new Error('Session lookup storage is unavailable');
    }
    return join(this.storageDirectory, 'session-lookups');
  }
}
