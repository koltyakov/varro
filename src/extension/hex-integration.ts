import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { DictationAction, DictationStatus } from '../shared/protocol';
import { asRecord, isBoolean, isNumber, isString } from '../shared/type-utils';

const runFile = promisify(execFile);
const CLI_TIMEOUT_MS = 12_000;
const DISCOVERY_TIMEOUT_MS = 2_000;
const WATCH_INTERVAL_MS = 1_000;

type HexReply =
  | { status: 'done' }
  | { status: 'error'; code: string; message: string }
  | { status: 'status'; running: boolean; state: DictationStatus['state'] };

function parseHexReply(stdout: string): HexReply {
  const reply = asRecord(JSON.parse(stdout));
  if (
    !reply ||
    !isNumber(reply.version) ||
    !Number.isSafeInteger(reply.version) ||
    reply.version < 1
  ) {
    throw new Error('Invalid Hex CLI reply. Update Hex to a build with control CLI support.');
  }
  if (reply.status === 'done') return { status: 'done' };
  if (reply.status === 'error' && isString(reply.code) && isString(reply.message)) {
    return { status: 'error', code: reply.code, message: reply.message };
  }
  const listener = asRecord(reply.listener);
  const capture = asRecord(reply.capture);
  if (reply.status === 'status' && isBoolean(listener?.running)) {
    const state = capture?.state;
    if (
      state === 'idle' ||
      state === 'recording' ||
      state === 'transcribing' ||
      state === 'unknown'
    ) {
      return {
        status: 'status',
        running: listener.running,
        state: state === 'transcribing' ? 'processing' : state,
      };
    }
  }
  throw new Error('Invalid Hex status reply. Update Hex to a build with control CLI support.');
}

export class HexIntegration {
  private disposed = false;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private watchGeneration = 0;
  private revision = 0;

  async request(
    action: DictationAction,
    onState?: (status: DictationStatus) => void
  ): Promise<DictationStatus> {
    const status: DictationStatus = { available: false, running: false, state: 'idle' };
    if (vscode.env.remoteName || this.disposed) return status;
    if (action !== 'status') this.stopWatching();
    try {
      const executable = await this.findExecutable();
      if (!executable || this.disposed) return status;
      status.available = true;
      Object.assign(status, await this.readStatus(executable));
      if (action === 'status' || this.disposed) return status;
      if (!status.running) {
        status.error = 'Start Hex and configure its model and permissions first.';
        return status;
      }
      const reply = await this.runCli(executable, ['dictation', action, '--json']);
      if (reply.status === 'error' && reply.code !== 'discarded') {
        throw new Error(reply.message);
      }
      if (reply.status !== 'done' && reply.status !== 'error') {
        throw new Error(
          'Unexpected Hex dictation reply. Update Hex to a build with control CLI support.'
        );
      }
      // Hex's commands are idempotent. Never replace start/stop with toggle,
      // and never retry a command whose delivery may already have succeeded.
      status.state = action === 'start' ? 'recording' : 'idle';
      const observed = await this.readStatus(executable);
      Object.assign(status, observed);
      if (
        onState &&
        status.running &&
        (observed.state === 'recording' || observed.state === 'processing')
      ) {
        this.watch(executable, onState);
      }
      return status;
    } catch (error) {
      return {
        ...status,
        error: `Hex ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching();
  }

  private stopWatching(): void {
    this.watchGeneration++;
    clearTimeout(this.watchTimer);
    this.watchTimer = undefined;
  }

  private watch(executable: string, onState: (status: DictationStatus) => void): void {
    const generation = this.watchGeneration;
    const schedule = () => {
      if (this.disposed || generation !== this.watchGeneration) return;
      this.watchTimer = setTimeout(() => void poll(), WATCH_INTERVAL_MS);
    };
    const poll = async () => {
      let status: DictationStatus;
      try {
        status = { available: true, ...(await this.readStatus(executable)) };
      } catch {
        // A failed observation is not evidence that recording ended. The next
        // focus probe or explicit command can recover without replaying work.
        return;
      }
      if (this.disposed || generation !== this.watchGeneration) return;
      onState(status);
      if (status.running && (status.state === 'recording' || status.state === 'processing'))
        schedule();
    };
    schedule();
  }

  private async readStatus(executable: string): Promise<Omit<DictationStatus, 'available'>> {
    const revision = ++this.revision;
    const reply = await this.runCli(executable, ['status', '--json']);
    if (reply.status === 'error') {
      if (reply.code === 'not-running') return { running: false, state: 'idle', revision };
      throw new Error(reply.message);
    }
    if (reply.status !== 'status') {
      throw new Error('Invalid Hex status reply. Update Hex to a build with control CLI support.');
    }
    return {
      running: reply.running,
      state: reply.state,
      revision,
    };
  }

  private async runCli(executable: string, args: string[]): Promise<HexReply> {
    let stdout: string;
    let failure: unknown;
    try {
      ({ stdout } = await runFile(executable, args, {
        timeout: args[0] === 'status' ? DISCOVERY_TIMEOUT_MS : CLI_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }));
    } catch (error) {
      // Refusals and not-running use nonzero exits but still print typed JSON.
      if (!(error instanceof Error) || !('stdout' in error) || !isString(error.stdout)) throw error;
      stdout = error.stdout;
      failure = error;
    }
    let reply: HexReply;
    try {
      reply = parseHexReply(stdout);
    } catch (error) {
      if (failure) throw failure;
      throw error;
    }
    if (failure && reply.status !== 'error') throw failure;
    return reply;
  }

  private async findExecutable(): Promise<string | undefined> {
    const deadline = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    const name = process.platform === 'win32' ? 'hex.exe' : 'hex';
    const standard =
      process.platform === 'darwin'
        ? [
            '/Applications/Hex.app/Contents/MacOS/hex',
            join(homedir(), 'Applications/Hex.app/Contents/MacOS/hex'),
          ]
        : process.platform === 'win32'
          ? await this.windowsExecutables()
          : [join(homedir(), '.local/bin/hex'), '/usr/bin/hex', '/usr/local/bin/hex'];
    const candidates = [
      ...standard,
      ...(process.env.PATH ?? '')
        .split(delimiter)
        .filter(isAbsolute)
        .map((directory) => join(directory, name)),
    ];
    for (const candidate of new Set(candidates)) {
      deadline.throwIfAborted();
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      } catch {
        // Optional installation candidates may be absent or not executable.
        continue;
      }
      deadline.throwIfAborted();
      return candidate;
    }
    deadline.throwIfAborted();
    return undefined;
  }

  private async windowsExecutables(): Promise<string[]> {
    if (!process.env.APPDATA) return [];
    const directory = join(process.env.APPDATA, 'hex');
    try {
      const version = (await readFile(join(directory, 'current-version'), 'utf8')).trim();
      // The installer owns this pointer. Never let it escape the versions folder.
      if (
        version.length <= 128 &&
        /^[\w.-]+$/.test(version) &&
        version !== '.' &&
        version !== '..'
      ) {
        return [join(directory, 'versions', version, 'hex.exe')];
      }
    } catch {
      // Non-managed installs can still be found on PATH.
    }
    return [];
  }
}
