import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import { delimiter, join } from 'path';
import { existsSync } from 'fs';
import * as vscode from 'vscode';
import { logger } from './logger';
import { EventEmitter } from 'events';
import type { ServerStatus } from '../shared/protocol';

export class OpenCodeServer extends EventEmitter {
  private process: ChildProcess | null = null;
  private _status: ServerStatus = { state: 'stopped' };
  private port: number;
  private retries = 0;
  private maxRetries = 3;
  private autoStart: boolean;
  private command: string;
  private eventController: AbortController | null = null;
  private eventReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventReconnectDelay = 1000;
  private eventReconnectCount = 0;
  private static readonly MAX_EVENT_RECONNECTS = 10;
  private startAttemptId = 0;
  private isDisposing = false;

  constructor(port: number, autoStart: boolean, command?: string) {
    super();
    this.port = port;
    this.autoStart = autoStart;
    this.command = command?.trim() || '';
  }

  get status(): ServerStatus {
    return this._status;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private setStatus(s: ServerStatus) {
    this._status = s;
    this.emit('status', s);
  }

  async start(): Promise<string> {
    this.isDisposing = false;
    const healthy = await this.checkHealth();
    if (healthy) {
      logger.info(`Found existing OpenCode server at ${this.url}`);
      this.setStatus({ state: 'running', url: this.url });
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
        if (settled || attemptId !== this.startAttemptId) return;
        settled = true;
        this.cancelPollHealth();
        this.setStatus({ state: 'error', message });
        reject(err || new Error(message));
      };

      const finishStartup = (url: string) => {
        if (settled || attemptId !== this.startAttemptId) return;
        settled = true;
        this.cancelPollHealth();
        resolve(url);
      };

      const recoverOrFailStartup = async (fallback: string) => {
        const healthyNow = await this.checkHealth();
        if (healthyNow) {
          this.setStatus({ state: 'running', url: this.url });
          this.retries = 0;
          this.startEventStream();
          finishStartup(this.url);
          return;
        }

        failStartup(describeStartupFailure(fallback));
      };

      try {
        const command = this.resolveCommand();
        logger.info(`Starting OpenCode server with command: ${command}`);

        this.process = spawn(command, ['serve', '--port', String(this.port)], {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          cwd: this.getWorkspaceCwd(),
          env: this.buildServerEnv(),
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
          if (attemptId !== this.startAttemptId) return;
          if (this._status.state === 'running') {
            this.setStatus({ state: 'stopped' });
            if (this.retries < this.maxRetries) {
              this.retries++;
              logger.info(`Restarting server (attempt ${this.retries})`);
              this.start().then(resolve).catch(reject);
              return;
            }
            reject(new Error(`Server exited and max retries (${this.maxRetries}) exhausted`));
            return;
          }

          void recoverOrFailStartup(
            `OpenCode server exited during startup${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}`
          );
        });

        this.process.on('error', (err) => {
          logger.error(`Server process error: ${err.message}`);
          if (err.message.includes('ENOENT')) {
            failStartup('OpenCode CLI not found. Install it with: npm install -g opencode-ai');
            return;
          }

          void recoverOrFailStartup(`OpenCode server failed to spawn: ${err.message}`);
        });
      } catch (err) {
        failStartup(String(err), err instanceof Error ? err : new Error(String(err)));
        return;
      }

      this.pollHealth(
        (url) => {
          this.retries = 0;
          finishStartup(url);
        },
        (err) => {
          failStartup(describeStartupFailure(err.message), err);
        }
      );
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

  private pollHealth(resolve: (url: string) => void, reject: (err: Error) => void, attempt = 0) {
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
      if (!this.pollHealthResolve || !this.pollHealthReject) return;
      const healthy = await this.checkHealth();
      if (!this.pollHealthResolve || !this.pollHealthReject) return;
      if (healthy) {
        this.cancelPollHealth();
        this.setStatus({ state: 'running', url: this.url });
        this.retries = 0;
        this.startEventStream();
        this.pollHealthResolve(this.url);
      } else {
        this.pollHealth(this.pollHealthResolve, this.pollHealthReject, attempt + 1);
      }
    }, 200);
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/global/health`, {
        signal: AbortSignal.timeout(2000),
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
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...this.directoryHeaders(scoped.directory),
      },
      signal: AbortSignal.timeout(30_000),
    };
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
  }

  private async startEventStream() {
    this.stopEventStream();
    this.eventController = new AbortController();
    const controller = this.eventController;
    let shouldReconnect = false;
    const scoped = this.scopedUrl('/event');

    try {
      const res = await fetch(scoped.url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          ...this.directoryHeaders(scoped.directory),
        },
      });
      if (!res.ok || !res.body) throw new Error(`Failed to open event stream: ${res.status}`);
      this.eventReconnectDelay = 1000;
      this.eventReconnectCount = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          logger.warn('Event stream closed; reconnecting');
          shouldReconnect = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary: { index: number; length: number } | null;
        while ((boundary = findSseChunkBoundary(buffer))) {
          const chunk = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary.length);
          this.processSseChunk(chunk);
        }
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Event stream error: ${message}`);
      shouldReconnect = true;
    } finally {
      if (shouldReconnect && !controller.signal.aborted && this._status.state === 'running') {
        this.eventReconnectCount++;
        if (this.eventReconnectCount > OpenCodeServer.MAX_EVENT_RECONNECTS) {
          logger.warn(`Event stream reconnect limit (${OpenCodeServer.MAX_EVENT_RECONNECTS}) reached`);
          this.setStatus({ state: 'error', message: 'Event stream connection lost' });
        } else {
          const delay = this.eventReconnectDelay;
          this.eventReconnectDelay = Math.min(delay * 2, 30_000);
          this.eventReconnectTimer = setTimeout(() => this.startEventStream(), delay);
        }
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
    this.cancelPollHealth();
    this.stopEventStream();
    if (this.process) {
      const proc = this.process;
      this.process = null;
      proc.kill('SIGTERM');
      const exitPromise = new Promise<boolean>((resolve) => {
        proc.on('exit', () => resolve(true));
      });
      const timeoutPromise = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000));
      const exited = await Promise.race([exitPromise, timeoutPromise]);
      if (!exited) {
        proc.kill('SIGKILL');
      }
    }
    this.setStatus({ state: 'stopped' });
  }

  private getWorkspaceCwd(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      return folders[0].uri.fsPath;
    }
    return undefined;
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
    return {
      ...process.env,
      PATH: this.serverPathEntries().join(delimiter),
    };
  }

  private serverPathEntries(): string[] {
    const home = process.env.HOME;
    const pathEntries = (process.env.PATH || '').split(delimiter).filter(Boolean);
    const extras =
      process.platform === 'win32'
        ? []
        : [
            ...(home ? [join(home, '.opencode', 'bin')] : []),
            ...(home ? [join(home, '.npm-global', 'bin')] : []),
            ...(home ? [join(home, '.local', 'bin')] : []),
            ...(home ? [join(home, '.bun', 'bin')] : []),
            ...(home ? [join(home, 'Library', 'pnpm')] : []),
            '/opt/homebrew/bin',
            '/usr/local/bin',
          ];

    return [...new Set([...pathEntries, ...extras].filter(Boolean))];
  }
}

const SSE_CHUNK_BOUNDARY_RE = /\r\n\r\n|\n\n|\r\r|\r\n\n|\n\r\n/;

function findSseChunkBoundary(buffer: string): { index: number; length: number } | null {
  const match = SSE_CHUNK_BOUNDARY_RE.exec(buffer);
  if (!match || match.index === undefined) return null;
  return { index: match.index, length: match[0].length };
}
