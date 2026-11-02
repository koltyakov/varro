import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { DictationAction, DictationStatus } from '../shared/protocol';
import { HandyRecordingStateReader } from './handy-recording-state';

const runFile = promisify(execFile);
const PROCESS_TIMEOUT_MS = 2_000;
type HandyStatus = DictationStatus;

export class HandyIntegration {
  private pending: Promise<HandyStatus> | undefined;
  private pendingAction: DictationAction | undefined;
  private logPath: string | undefined;
  private readonly recording = new HandyRecordingStateReader(() => this.getLogPath());
  private requestedState: 'idle' | 'recording' = 'idle';
  private disposed = false;

  request(action: DictationAction, onState?: (status: HandyStatus) => void): Promise<HandyStatus> {
    if (vscode.env.remoteName || this.disposed)
      return Promise.resolve({ available: false, running: false, state: 'idle' });
    if (this.pending) {
      // A focus-triggered read must not consume a deliberate mic click.
      if (action !== 'status' && this.pendingAction === 'status')
        return this.pending.then(() => this.request(action, onState));
      return this.pending.then(({ available, running, state, revision }) => {
        const status: HandyStatus = { available, running, state, revision };
        if (action !== 'status') status.error = 'Another Handy command is still pending.';
        return status;
      });
    }
    // Claim before discovery as well, so concurrent views cannot both pass the guard.
    const operation = this.performRequest(action).then((status) => {
      if (this.disposed) return status;
      if (action !== 'status') {
        if ((status.state === 'recording' || status.state === 'processing') && onState) {
          this.recording.watch((state) => {
            if (state !== 'unknown')
              this.requestedState = state === 'recording' ? 'recording' : 'idle';
            onState(this.status(status.available, status.running));
          });
        } else if (status.state === 'idle') {
          this.recording.stopWatching();
        }
      }
      return this.status(status.available, status.running, status.error);
    });
    this.pending = operation;
    this.pendingAction = action;
    void operation.then(() => {
      if (this.pending === operation) {
        this.pending = undefined;
        this.pendingAction = undefined;
      }
    });
    return operation;
  }

  dispose(): void {
    this.disposed = true;
    this.recording.dispose();
  }

  private status(available: boolean, running: boolean, error?: string): HandyStatus {
    const result: HandyStatus = {
      available,
      running,
      state: this.recording.state === 'unknown' ? this.requestedState : this.recording.state,
      revision: this.recording.revision,
    };
    if (error) result.error = error;
    return result;
  }

  private async performRequest(action: DictationAction): Promise<HandyStatus> {
    let available = false;
    let running = false;
    try {
      const executable = await this.findExecutable();
      available = executable !== undefined;
      if (!executable) {
        this.requestedState = 'idle';
        this.recording.reset('idle');
        return this.status(available, running);
      }
      running = await this.isRunning();
      if (!running) {
        this.requestedState = 'idle';
        this.recording.reset('idle');
        return this.status(
          available,
          running,
          action === 'status'
            ? undefined
            : 'Start Handy and configure its model and permissions first.'
        );
      }
      // Preserve the existing cheap idle process check. Never read or watch
      // lifecycle logs merely because Handy is installed or already running.
      if (action === 'status') return this.status(available, running);
      await this.resolveLogPath(executable);
      await this.recording.read();
      if (this.disposed) return this.status(available, running);
      const state = this.status(available, running).state;
      // The CLI only toggles. Resolve the user's intent against Handy's own
      // lifecycle first, so finishing an externally cancelled recording is a no-op.
      if (
        (action === 'start' && state === 'recording') ||
        ((action === 'stop' || action === 'cancel') && state === 'idle')
      ) {
        this.requestedState = state === 'recording' ? 'recording' : 'idle';
        return this.status(available, running);
      }
      // Processing is advisory: Handy may omit its final idle log. A deliberate
      // new start must not be blocked forever by that stale observation.
      const observation = this.recording.observation;
      await runFile(executable, [action === 'cancel' ? '--cancel' : '--toggle-transcription'], {
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      this.requestedState = action === 'start' ? 'recording' : 'idle';
      await this.recording.read();
      // CLI completion is only delivery. Prefer any new lifecycle observation;
      // otherwise retain the requested state without waiting, retrying or failing.
      if (this.recording.observation === observation || this.recording.state === 'unknown')
        this.recording.assume(this.requestedState);
      return this.status(available, running);
    } catch (error) {
      return this.status(
        available,
        running,
        `Handy ${action} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private getLogPath(): string | undefined {
    return this.logPath ?? this.getStandardLogPath();
  }

  private getStandardLogPath(): string | undefined {
    const home = homedir();
    const directory =
      process.platform === 'darwin'
        ? join(home, 'Library/Logs/com.pais.handy')
        : process.platform === 'win32'
          ? process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'com.pais.handy/logs')
          : join(process.env.XDG_DATA_HOME || join(home, '.local/share'), 'com.pais.handy/logs');
    return directory ? join(directory, 'handy.log') : undefined;
  }

  private async resolveLogPath(executable: string): Promise<void> {
    let path = this.getStandardLogPath();
    const directory = dirname(executable);
    try {
      // Handy's portable layout is a marker and Data directory beside its
      // executable. An arbitrary custom executable still uses the standard logs.
      const [marker, data] = await Promise.all([
        stat(join(directory, 'portable')),
        stat(join(directory, 'Data')),
      ]);
      if (marker.isFile() && data.isDirectory()) path = join(directory, 'Data/logs/handy.log');
    } catch {
      // Portable discovery is optional and runs only for an explicit mic action.
    }
    if (path !== this.getLogPath()) this.recording.reset('unknown');
    this.logPath = path;
  }

  private async findExecutable(): Promise<string | undefined> {
    const deadline = AbortSignal.timeout(PROCESS_TIMEOUT_MS);
    const name = process.platform === 'win32' ? 'handy.exe' : 'handy';
    const standard =
      process.platform === 'darwin'
        ? [
            '/Applications/Handy.app/Contents/MacOS/Handy',
            join(homedir(), 'Applications/Handy.app/Contents/MacOS/Handy'),
          ]
        : process.platform === 'win32'
          ? [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
              .filter((directory): directory is string => !!directory)
              .map((directory) => join(directory, 'Handy', name))
          : [join(homedir(), '.local/bin/handy'), '/usr/bin/handy', '/usr/local/bin/handy'];
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
        // Missing or non-executable candidates are normal during optional discovery.
        continue;
      }
      // A late filesystem read must never activate dictation after discovery expired.
      deadline.throwIfAborted();
      return candidate;
    }
    deadline.throwIfAborted();
    return undefined;
  }

  private async isRunning(): Promise<boolean> {
    const options = { timeout: PROCESS_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true };
    if (process.platform === 'win32') {
      const { stdout } = await runFile(
        'tasklist.exe',
        ['/FI', 'IMAGENAME eq handy.exe', '/FO', 'CSV', '/NH'],
        options
      );
      return /^"handy\.exe",/im.test(stdout);
    }
    try {
      const { stdout } = await runFile(
        '/usr/bin/pgrep',
        ['-u', String(process.getuid!()), '-x', 'Handy|handy'],
        options
      );
      return /^\d+$/m.test(stdout.trim());
    } catch (error) {
      // pgrep exits 1 when there are no matching processes, not on inspection failure.
      if (error instanceof Error && 'code' in error && error.code === 1) return false;
      throw error;
    }
  }
}
