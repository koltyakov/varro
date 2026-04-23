import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { join } from 'path';
import { existsSync } from 'fs';
import * as vscode from 'vscode';
import { logger } from './logger';
import { EventEmitter } from 'events';
import type { ServerStatus } from '../shared/protocol';
import { resolveServerLaunch } from './util/server-launch';
import { buildServerEnv, getServerPathEntries } from './util/server-path';

export class OpenCodeServer extends EventEmitter {
  private static readonly MISSING_CLI_MESSAGE =
    'OpenCode CLI not found. Install it with: npm install -g opencode-ai';
  private static readonly START_DISPOSED_MESSAGE = 'Server start was cancelled';
  private static readonly HEALTH_TIMEOUT_MS = 2000;
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly EVENT_CONNECT_TIMEOUT_MS = 10_000;
  private static readonly EVENT_IDLE_TIMEOUT_MS = 45_000;
  private process: ChildProcess | null = null;
  private _status: ServerStatus = { state: 'stopped' };
  private port: number;
  private retries = 0;
  private maxRetries = 3;
  private autoStart: boolean;
  private command: string;
  private simulateMissingCli: boolean;
  private eventController: AbortController | null = null;
  private eventReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventReconnectDelay = 1000;
  private eventReconnectCount = 0;
  private static readonly MAX_EVENT_RECONNECTS = 10;
  private static readonly MAX_EVENT_RECONNECT_DELAY_MS = 30_000;
  private startAttemptId = 0;
  private disposeGeneration = 0;
  private isDisposing = false;
  private startPromise: Promise<string> | null = null;
  private requestControllers = new Set<AbortController>();

  constructor(port: number, autoStart: boolean, command?: string, simulateMissingCli = false) {
    super();
    this.port = port;
    this.autoStart = autoStart;
    this.command = command?.trim() || '';
    this.simulateMissingCli = simulateMissingCli;
  }

  get status(): ServerStatus {
    return this._status;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private setStatus(s: ServerStatus) {
    const nextStatus = normalizeRunningStatus(s, this._status);
    this._status = nextStatus;
    this.emit('status', nextStatus);
  }

  private setRunningStatus(url = this.url, eventStream?: 'healthy' | 'degraded') {
    this.setStatus({ state: 'running', url, ...(eventStream ? { eventStream } : {}) });
  }

  private updateEventStreamState(eventStream: 'healthy' | 'degraded') {
    if (this._status.state !== 'running') return;
    if (this._status.eventStream === eventStream) return;
    this.setRunningStatus(this._status.url, eventStream);
  }

  private setStartPromise(factory: () => Promise<string>): Promise<string> {
    if (this.startPromise) return this.startPromise;
    const promise = factory().finally(() => {
      if (this.startPromise === promise) {
        this.startPromise = null;
      }
    });
    this.startPromise = promise;
    return promise;
  }

  private clearStartPromise() {
    this.startPromise = null;
  }

  async start(): Promise<string> {
    return this.setStartPromise(async () => {
      const disposeGeneration = this.disposeGeneration;
      this.isDisposing = false;
      if (this.simulateMissingCli) {
        this.stopEventStream();
        this.cancelPollHealth();
        this.setStatus({ state: 'error', message: OpenCodeServer.MISSING_CLI_MESSAGE });
        throw new Error(OpenCodeServer.MISSING_CLI_MESSAGE);
      }

      const healthy = await this.checkHealth();
      this.throwIfStartCancelled(disposeGeneration);
      if (healthy) {
        logger.info(`Found existing OpenCode server at ${this.url}`);
        this.setRunningStatus(this.url, 'healthy');
        this.startEventStream();
        return this.url;
      }

      if (!this.autoStart) {
        this.setStatus({
          state: 'error',
          message: `No server at ${this.url}. Start one with "opencode serve --port ${this.port}" or enable varro.server.autoStart.`,
        });
        throw new Error(
          this._status.state === 'error'
            ? (this._status as { message: string }).message
            : 'server not running'
        );
      }

      return new Promise((resolve, reject) => {
        this.setStatus({ state: 'starting' });
        const attemptId = ++this.startAttemptId;
        const stderrLines: string[] = [];
        let settled = false;

        const isStaleAttempt = () =>
          settled ||
          attemptId !== this.startAttemptId ||
          this.disposeGeneration !== disposeGeneration;

        const rememberStderr = (text: string) => {
          for (const line of text
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)) {
            stderrLines.push(line);
          }
          if (stderrLines.length > 8) {
            stderrLines.splice(0, stderrLines.length - 8);
          }
        };

        const describeStartupFailure = (fallback: string) => {
          const recent = stderrLines[stderrLines.length - 1];
          return recent ? `${fallback}: ${recent}` : fallback;
        };

        const failStartup = (message: string, err?: Error) => {
          if (isStaleAttempt()) return;
          settled = true;
          this.cancelPollHealth();
          this.setStatus({ state: 'error', message });
          reject(err || new Error(message));
        };

        const finishStartup = (url: string) => {
          if (isStaleAttempt()) return;
          settled = true;
          this.cancelPollHealth();
          resolve(url);
        };

        const recoverOrFailStartup = async (fallback: string) => {
          if (isStaleAttempt()) return;
          const healthyNow = await this.checkHealth();
          if (isStaleAttempt()) return;
          if (healthyNow) {
            this.setRunningStatus(this.url, 'healthy');
            this.retries = 0;
            this.startEventStream();
            finishStartup(this.url);
            return;
          }

          if (this.retries < this.maxRetries) {
            this.retries += 1;
            const delay = this.getRestartDelay(this.retries);
            logger.warn(`Retrying server startup in ${delay}ms (attempt ${this.retries})`);
            this.clearStartPromise();
            setTimeout(() => {
              if (isStaleAttempt()) return;
              this.start().then(resolve).catch(reject);
            }, delay);
            return;
          }

          failStartup(describeStartupFailure(fallback));
        };

        try {
          const command = this.resolveCommand();
          const args = ['serve', '--port', String(this.port)];
          const launch = resolveServerLaunch(command, args);
          logger.info(`Starting OpenCode server with command: ${command}`);

          this.process = spawn(launch.command, launch.args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
            cwd: this.getWorkspaceCwd(),
            env: this.buildServerEnv(),
            windowsHide: true,
            ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
          });

          this.process.stdout?.on('data', (data: Buffer) => {
            logger.info(`[server] ${data.toString().trim()}`);
          });

          this.process.stderr?.on('data', (data: Buffer) => {
            const text = data.toString().trim();
            rememberStderr(text);
            logger.error(`[server] ${text}`);
          });

          this.process.on('exit', (code, signal) => {
            logger.info(`Server process exited with code ${code}`);
            this.process = null;
            this.stopEventStream();
            if (this.isDisposing) {
              return;
            }
            if (isStaleAttempt()) return;
            if (this._status.state === 'running') {
              this.setStatus({ state: 'stopped' });
              if (this.retries < this.maxRetries) {
                this.retries++;
                const delay = this.getRestartDelay(this.retries);
                logger.info(`Restarting server in ${delay}ms (attempt ${this.retries})`);
                this.clearStartPromise();
                setTimeout(() => {
                  if (isStaleAttempt()) return;
                  this.start().then(resolve).catch(reject);
                }, delay);
                return;
              }
              const runtimeFailure = `OpenCode server stopped unexpectedly${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}. Restart attempts (${this.maxRetries}) were exhausted.`;
              this.setStatus({ state: 'error', message: runtimeFailure });
              return;
            }

            void recoverOrFailStartup(
              `OpenCode server exited during startup${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}`
            );
          });

          this.process.on('error', (err) => {
            logger.error(`Server process error: ${err.message}`);
            if (err.message.includes('ENOENT')) {
              failStartup(OpenCodeServer.MISSING_CLI_MESSAGE);
              return;
            }

            void recoverOrFailStartup(`OpenCode server failed to spawn: ${err.message}`);
          });
        } catch (err) {
          failStartup(String(err), err instanceof Error ? err : new Error(String(err)));
          return;
        }

        this.pollHealth(
          attemptId,
          disposeGeneration,
          (url) => {
            this.retries = 0;
            finishStartup(url);
          },
          (err) => {
            failStartup(describeStartupFailure(err.message), err);
          }
        );
      });
    });
  }

  private pollHealthResolve: ((url: string) => void) | null = null;
  private pollHealthReject: ((err: Error) => void) | null = null;
  private pollHealthTimer: ReturnType<typeof setTimeout> | null = null;

  private cancelPollHealth() {
    this.pollHealthResolve = null;
    this.pollHealthReject = null;
    if (this.pollHealthTimer) {
      clearTimeout(this.pollHealthTimer);
      this.pollHealthTimer = null;
    }
  }

  private pollHealth(
    startAttemptId: number,
    disposeGeneration: number,
    resolve: (url: string) => void,
    reject: (err: Error) => void,
    attempt = 0
  ) {
    if (attempt > 50) {
      this.cancelPollHealth();
      this.setStatus({ state: 'error', message: 'Server failed to start within timeout' });
      reject(new Error('Server health check timeout'));
      return;
    }

    this.pollHealthResolve = resolve;
    this.pollHealthReject = reject;

    this.pollHealthTimer = setTimeout(async () => {
      this.pollHealthTimer = null;
      if (
        !this.pollHealthResolve ||
        !this.pollHealthReject ||
        startAttemptId !== this.startAttemptId ||
        disposeGeneration !== this.disposeGeneration
      )
        return;
      const healthy = await this.checkHealth();
      if (
        !this.pollHealthResolve ||
        !this.pollHealthReject ||
        startAttemptId !== this.startAttemptId ||
        disposeGeneration !== this.disposeGeneration
      )
        return;
      if (healthy) {
        this.cancelPollHealth();
        this.setRunningStatus(this.url, 'healthy');
        this.retries = 0;
        this.startEventStream();
        this.pollHealthResolve(this.url);
      } else {
        this.pollHealth(
          startAttemptId,
          disposeGeneration,
          this.pollHealthResolve,
          this.pollHealthReject,
          attempt + 1
        );
      }
    }, 200);
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/global/health`, {
        signal: AbortSignal.timeout(OpenCodeServer.HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { healthy?: boolean };
      return data.healthy === true;
    } catch {
      return false;
    }
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const scoped = this.scopedUrl(path);
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...this.directoryHeaders(scoped.directory),
      },
      signal: anySignal(controller.signal, AbortSignal.timeout(OpenCodeServer.REQUEST_TIMEOUT_MS)),
    };
    try {
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        init.body = JSON.stringify(body);
      }
      const res = await fetch(scoped.url, init);
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        const msg =
          typeof data === 'object' && data && 'message' in data ? data.message : res.statusText;
        throw new Error(`${res.status} ${msg}`);
      }
      return data;
    } finally {
      controller.abort();
      this.requestControllers.delete(controller);
    }
  }

  private async startEventStream() {
    this.stopEventStream();
    this.eventController = new AbortController();
    const controller = this.eventController;
    let shouldReconnect = false;
    const scoped = this.scopedUrl('/event');
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const abortForReconnect = (message: string, reason: string) => {
      if (controller.signal.aborted) return;
      shouldReconnect = true;
      logger.warn(message);
      controller.abort(new Error(reason));
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortForReconnect('Event stream stalled; reconnecting', 'Event stream idle timeout');
      }, OpenCodeServer.EVENT_IDLE_TIMEOUT_MS);
    };

    connectTimer = setTimeout(() => {
      abortForReconnect(
        'Event stream connection timed out; reconnecting',
        'Event stream connect timeout'
      );
    }, OpenCodeServer.EVENT_CONNECT_TIMEOUT_MS);

    try {
      const res = await fetch(scoped.url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          ...this.directoryHeaders(scoped.directory),
        },
      });
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (!res.ok || !res.body) throw new Error(`Failed to open event stream: ${res.status}`);
      this.eventReconnectDelay = 1000;
      this.eventReconnectCount = 0;
      this.updateEventStreamState('healthy');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      resetIdleTimer();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const finalChunk = buffer.trim();
          if (finalChunk.length > 0) {
            this.processSseChunk(finalChunk);
          }
          logger.warn('Event stream closed; reconnecting');
          shouldReconnect = true;
          break;
        }
        resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        let boundary: { index: number; length: number } | null;
        while ((boundary = findSseChunkBoundary(buffer))) {
          const chunk = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          this.processSseChunk(chunk);
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted && !shouldReconnect) return;
      const message = err instanceof Error ? err.message : String(err);
      if (!shouldReconnect) {
        logger.warn(`Event stream error: ${message}`);
      }
      shouldReconnect = true;
    } finally {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (
        shouldReconnect &&
        this.eventController === controller &&
        this._status.state === 'running'
      ) {
        this.updateEventStreamState('degraded');
        this.eventReconnectCount++;
        if (this.eventReconnectCount === OpenCodeServer.MAX_EVENT_RECONNECTS) {
          logger.warn(
            `Event stream reconnect attempts reached ${OpenCodeServer.MAX_EVENT_RECONNECTS}; continuing background retries while keeping REST requests available`
          );
        }

        const delay = this.eventReconnectDelay;
        this.eventReconnectDelay = Math.min(delay * 2, OpenCodeServer.MAX_EVENT_RECONNECT_DELAY_MS);
        this.eventReconnectTimer = setTimeout(() => this.startEventStream(), delay);
      }
    }
  }

  private processSseChunk(chunk: string) {
    const dataLines: string[] = [];
    for (const line of chunk.split(/\r\n|[\r\n]/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    try {
      const parsed = JSON.parse(data);
      this.emit('event', parsed);
    } catch {
      // ignore
    }
  }

  private stopEventStream() {
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer);
      this.eventReconnectTimer = null;
    }
    if (this.eventController) {
      this.eventController.abort();
      this.eventController = null;
    }
  }

  async dispose() {
    this.isDisposing = true;
    this.disposeGeneration += 1;
    this.clearStartPromise();
    this.cancelPollHealth();
    this.stopEventStream();
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();
    if (this.process) {
      const proc = this.process;
      this.process = null;
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
      }
      const exited = await waitForProcessExit(proc, 5000);
      if (!exited && proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGKILL');
      }
    }
    this.setStatus({ state: 'stopped' });
  }

  private getWorkspaceCwd(): string | undefined {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder) {
      return activeFolder.uri.fsPath;
    }

    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  private scopedUrl(path: string): { url: string; directory?: string } {
    const url = new URL(path, this.url);
    const directory = this.getWorkspaceCwd();

    if (directory && !url.pathname.startsWith('/global/') && !url.searchParams.has('directory')) {
      url.searchParams.set('directory', directory);
    }

    return { url: url.toString(), directory };
  }

  private directoryHeaders(directory?: string): Record<string, string> {
    if (!directory) return {};
    return { 'x-opencode-directory': encodeURIComponent(directory) };
  }

  private resolveCommand(): string {
    if (this.command) return this.command;

    const candidates =
      process.platform === 'win32'
        ? ['opencode.exe', 'opencode.cmd', 'opencode.bat']
        : ['opencode'];

    for (const dir of this.serverPathEntries()) {
      for (const candidate of candidates) {
        const fullPath = join(dir, candidate);
        if (existsSync(fullPath)) return fullPath;
      }
    }

    return process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
  }

  private buildServerEnv(): NodeJS.ProcessEnv {
    return buildServerEnv();
  }

  private serverPathEntries(): string[] {
    return getServerPathEntries();
  }

  private throwIfStartCancelled(disposeGeneration: number) {
    if (this.isDisposing || this.disposeGeneration !== disposeGeneration) {
      throw new Error(OpenCodeServer.START_DISPOSED_MESSAGE);
    }
  }

  private getRestartDelay(attempt: number) {
    return Math.min(
      1000 * 2 ** Math.max(0, attempt - 1),
      OpenCodeServer.MAX_EVENT_RECONNECT_DELAY_MS
    );
  }
}

function normalizeRunningStatus(next: ServerStatus, previous: ServerStatus): ServerStatus {
  if (next.state !== 'running') return next;
  if (next.eventStream) return next;
  if (previous.state !== 'running') return { ...next, eventStream: 'healthy' };
  return { ...next, eventStream: previous.eventStream || 'healthy' };
}

const SSE_CHUNK_BOUNDARY_RE = /\r\n\r\n|\n\n|\r\r|\r\n\n|\n\r\n/;

function findSseChunkBoundary(buffer: string): { index: number; length: number } | null {
  const match = SSE_CHUNK_BOUNDARY_RE.exec(buffer);
  if (!match || match.index === undefined) return null;
  return { index: match.index, length: match[0].length };
}

function waitForProcessExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      proc.off('exit', handleExit);
      resolve(result);
    };

    const handleExit = () => finish(true);
    proc.once('exit', handleExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const onAbort = (event: Event) => {
    controller.abort((event.target as AbortSignal | null)?.reason);
    for (const signal of signals) {
      signal.removeEventListener('abort', onAbort);
    }
  };

  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  return controller.signal;
}
