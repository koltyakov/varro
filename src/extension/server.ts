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
  private static readonly CLI_UPGRADE_COMMAND = 'opencode upgrade';
  private static readonly CLI_UPGRADE_ACTION = 'Run Upgrade';
  private static readonly START_DISPOSED_MESSAGE = 'Server start was cancelled';
  private static readonly HEALTH_TIMEOUT_MS = 2000;
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly CLI_COMMAND_TIMEOUT_MS = 5000;
  private static readonly VERSION_CHECK_INTERVAL_MS = 5 * 60_000;
  private static readonly CLI_UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60_000;
  private static readonly CLI_REGISTRY_TIMEOUT_MS = 10_000;
  private static readonly EVENT_CONNECT_TIMEOUT_MS = 10_000;
  private static readonly EVENT_IDLE_TIMEOUT_MS = 45_000;
  private static readonly EVENT_MAX_BUFFER_CHARS = 1_000_000;
  private static readonly PORT_FALLBACK_MAX_OFFSET = 10;
  private process: ChildProcess | null = null;
  private _status: ServerStatus = { state: 'stopped' };
  private port: number;
  private readonly originalPort: number;
  private retries = 0;
  private maxRetries = 3;
  private portFallbackAttempts = 0;
  private portInUseDetected = false;
  private autoStart: boolean;
  private command: string;
  private simulateMissingCli: boolean;
  private eventController: AbortController | null = null;
  private eventReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private eventReconnectDelay = 1000;
  private eventReconnectCount = 0;
  private static readonly EVENT_RECONNECT_WARNING_THRESHOLD = 10;
  private static readonly MAX_EVENT_RECONNECT_DELAY_MS = 30_000;
  private startAttemptId = 0;
  private disposeGeneration = 0;
  private isDisposing = false;
  private startPromise: Promise<string> | null = null;
  private requestControllers = new Set<AbortController>();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceInFlight = false;
  private automaticRestartInFlight = false;
  private managedProcess = false;
  private lastCliUpdateCheckAt = 0;
  private lastSuggestedCliVersion = '';
  private lastLoggedUnmanagedRestartKey = '';
  private readonly pendingAttentionRequests = new Map<string, string>();

  constructor(port: number, autoStart: boolean, command?: string, simulateMissingCli = false) {
    super();
    this.port = port;
    this.originalPort = port;
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
    const previousStatus = this._status;
    const nextStatus = normalizeRunningStatus(s, this._status);
    this._status = nextStatus;
    if (nextStatus.state === 'running') {
      this.startMaintenanceLoop();
    } else if (previousStatus.state === 'running') {
      this.stopMaintenanceLoop();
    }
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
      this.clearRestartTimer();
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
        this.managedProcess = false;
        this.portFallbackAttempts = 0;
        this.portInUseDetected = false;
        this.setRunningStatus(this.url, 'healthy');
        this.startEventStream();
        this.requestMaintenanceCheck();
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

          if (this.portInUseDetected && this.tryAdvancePort()) {
            logger.warn(
              `Port ${this.port - 1} in use by another process; retrying on ${this.port}`
            );
            this.portInUseDetected = false;
            this.clearStartPromise();
            this.restartTimer = setTimeout(() => {
              this.restartTimer = null;
              if (isStaleAttempt()) return;
              this.start().then(resolve).catch(reject);
            }, 100);
            return;
          }

          if (this.retries < this.maxRetries) {
            this.retries += 1;
            const delay = this.getRestartDelay(this.retries);
            logger.warn(`Retrying server startup in ${delay}ms (attempt ${this.retries})`);
            this.clearStartPromise();
            this.restartTimer = setTimeout(() => {
              this.restartTimer = null;
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
          this.managedProcess = true;

          this.process.stdout?.on('data', (data: Buffer) => {
            logger.info(`[server] ${data.toString().trim()}`);
          });

          this.process.stderr?.on('data', (data: Buffer) => {
            const text = data.toString().trim();
            rememberStderr(text);
            if (isPortInUseMessage(text)) {
              this.portInUseDetected = true;
            }
            logger.error(`[server] ${text}`);
          });

          this.process.on('exit', (code, signal) => {
            logger.info(`Server process exited with code ${code}`);
            this.process = null;
            this.managedProcess = false;
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
                this.restartTimer = setTimeout(() => {
                  this.restartTimer = null;
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
        this.portFallbackAttempts = 0;
        this.portInUseDetected = false;
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
    const data = await this.readHealthInfo();
    return data.healthy === true;
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
      let cursor = 0;
      resetIdleTimer();
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const finalChunk = buffer.slice(cursor).trim();
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
        while ((boundary = findSseChunkBoundary(buffer, cursor))) {
          this.processSseChunk(buffer.slice(cursor, boundary.index));
          cursor = boundary.index + boundary.length;
        }
        if (cursor > 0) {
          buffer = buffer.slice(cursor);
          cursor = 0;
        }
        if (buffer.length > OpenCodeServer.EVENT_MAX_BUFFER_CHARS) {
          abortForReconnect(
            'Event stream buffer exceeded safety limit; reconnecting',
            'Event stream buffer overflow'
          );
          break;
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
        if (this.eventReconnectCount === OpenCodeServer.EVENT_RECONNECT_WARNING_THRESHOLD) {
          logger.warn(
            `Event stream reconnect attempts reached ${OpenCodeServer.EVENT_RECONNECT_WARNING_THRESHOLD}; continuing background retries while keeping REST requests available`
          );
        }

        const delay = this.eventReconnectDelay;
        this.eventReconnectDelay = Math.min(delay * 2, OpenCodeServer.MAX_EVENT_RECONNECT_DELAY_MS);
        this.eventReconnectTimer = setTimeout(() => this.startEventStream(), delay);
      }
    }
  }

  private processSseChunk(chunk: string) {
    let data = '';
    for (const line of chunk.split(/\r\n|[\r\n]/)) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trimStart();
      data = data.length === 0 ? value : `${data}\n${value}`;
    }
    if (data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      logger.warn(
        `Ignoring malformed event stream payload: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    try {
      this.observeServerEvent(parsed);
    } catch (err) {
      logger.warn(`Event observation threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.emit('event', parsed);
    } catch (err) {
      logger.warn(`Event listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private observeServerEvent(event: unknown) {
    const evt = asRecord(event);
    const type = getString(evt?.type);
    const props = asRecord(evt?.properties);
    if (!type) return;

    switch (type) {
      case 'permission.asked':
      case 'question.asked': {
        const requestID =
          getString(props?.id) || getString(props?.permissionID) || getString(props?.requestID);
        const sessionID = getString(props?.sessionID);
        if (requestID && sessionID) {
          this.pendingAttentionRequests.set(requestID, sessionID);
        }
        break;
      }
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected': {
        const requestID =
          getString(props?.id) || getString(props?.permissionID) || getString(props?.requestID);
        if (requestID) {
          this.pendingAttentionRequests.delete(requestID);
        }
        break;
      }
      case 'session.deleted': {
        const sessionID = getString(asRecord(props?.info)?.id);
        if (!sessionID) break;
        for (const [requestID, requestSessionID] of this.pendingAttentionRequests.entries()) {
          if (requestSessionID === sessionID) {
            this.pendingAttentionRequests.delete(requestID);
          }
        }
        break;
      }
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

  private clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private startMaintenanceLoop() {
    if (this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenanceTick();
    }, OpenCodeServer.VERSION_CHECK_INTERVAL_MS);
  }

  private stopMaintenanceLoop() {
    if (!this.maintenanceTimer) return;
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  private requestMaintenanceCheck() {
    void this.runMaintenanceTick();
  }

  private async runMaintenanceTick() {
    if (this.maintenanceInFlight || this.isDisposing) return;
    this.maintenanceInFlight = true;
    try {
      const installedCliVersion = await this.readInstalledCliVersion();
      await this.maybeSuggestCliUpdate(installedCliVersion);

      if (this._status.state !== 'running' || !installedCliVersion) {
        return;
      }

      const health = await this.readHealthInfo();
      const serverVersion = typeof health.version === 'string' ? health.version.trim() : '';
      if (!health.healthy || !serverVersion) {
        return;
      }

      if (compareVersions(installedCliVersion, serverVersion) <= 0) {
        this.lastLoggedUnmanagedRestartKey = '';
        return;
      }

      if (await this.hasActiveSessions()) {
        return;
      }

      if (!this.process || !this.managedProcess) {
        const key = `${serverVersion}->${installedCliVersion}`;
        if (this.lastLoggedUnmanagedRestartKey !== key) {
          this.lastLoggedUnmanagedRestartKey = key;
          logger.info(
            `OpenCode CLI ${installedCliVersion} is newer than running server ${serverVersion}, but the server is not managed by Varro; skipping automatic restart`
          );
        }
        return;
      }

      this.lastLoggedUnmanagedRestartKey = '';
      await this.restartManagedServer(serverVersion, installedCliVersion);
    } catch (err) {
      logger.warn(
        `OpenCode background maintenance failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.maintenanceInFlight = false;
    }
  }

  private async restartManagedServer(serverVersion: string, installedCliVersion: string) {
    if (this.automaticRestartInFlight) return;
    this.automaticRestartInFlight = true;
    try {
      logger.info(
        `Restarting managed OpenCode server to use CLI ${installedCliVersion} instead of server ${serverVersion}`
      );
      await this.stopManagedProcessForRestart();
      await this.start();
    } finally {
      this.automaticRestartInFlight = false;
    }
  }

  private async stopManagedProcessForRestart() {
    this.isDisposing = true;
    this.disposeGeneration += 1;
    this.clearStartPromise();
    this.clearRestartTimer();
    this.cancelPollHealth();
    this.stopEventStream();
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();

    const proc = this.process;
    this.process = null;
    this.managedProcess = false;
    if (!proc) return;

    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM');
    }
    const exited = await waitForProcessExit(proc, 5000);
    if (!exited && proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
    }
  }

  private async hasActiveSessions(): Promise<boolean> {
    const [statuses, questions] = await Promise.allSettled([
      this.request('GET', '/session/status'),
      this.request('GET', '/question'),
    ]);

    if (statuses.status === 'rejected') {
      throw statuses.reason;
    }

    const sessionStatuses = asRecord(statuses.value) || {};
    for (const value of Object.values(sessionStatuses)) {
      const type = getString(asRecord(value)?.type);
      if (type === 'busy' || type === 'retry') {
        return true;
      }
    }

    if (
      questions.status === 'fulfilled' &&
      Array.isArray(questions.value) &&
      questions.value.length > 0
    ) {
      return true;
    }

    return this.pendingAttentionRequests.size > 0;
  }

  private async maybeSuggestCliUpdate(installedCliVersion: string | null) {
    if (!installedCliVersion) return;

    const now = Date.now();
    if (now - this.lastCliUpdateCheckAt < OpenCodeServer.CLI_UPDATE_CHECK_INTERVAL_MS) {
      return;
    }
    this.lastCliUpdateCheckAt = now;

    const latestCliVersion = await this.readLatestCliVersion();
    if (!latestCliVersion || compareVersions(latestCliVersion, installedCliVersion) <= 0) {
      return;
    }

    if (this.lastSuggestedCliVersion === latestCliVersion) {
      return;
    }
    this.lastSuggestedCliVersion = latestCliVersion;

    const message = `OpenCode CLI ${latestCliVersion} is available (installed: ${installedCliVersion}). Update with: ${OpenCodeServer.CLI_UPGRADE_COMMAND}`;
    logger.info(message);
    void vscode.window
      .showInformationMessage(message, OpenCodeServer.CLI_UPGRADE_ACTION)
      .then((action) => {
        if (action === OpenCodeServer.CLI_UPGRADE_ACTION) {
          this.runInTerminal(OpenCodeServer.CLI_UPGRADE_COMMAND, 'OpenCode Upgrade');
        }
      });
  }

  private async readInstalledCliVersion(): Promise<string | null> {
    if (this.simulateMissingCli) {
      return null;
    }

    try {
      const output = await this.runCliCommand(['--version']);
      return extractVersion(output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('ENOENT') || message.includes(OpenCodeServer.MISSING_CLI_MESSAGE)) {
        return null;
      }
      throw err;
    }
  }

  private async readLatestCliVersion(): Promise<string | null> {
    try {
      const res = await fetch('https://registry.npmjs.org/opencode-ai/latest', {
        signal: AbortSignal.timeout(OpenCodeServer.CLI_REGISTRY_TIMEOUT_MS),
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch latest OpenCode CLI version: ${res.status}`);
      }
      const data = (await res.json()) as { version?: unknown };
      return typeof data.version === 'string' ? extractVersion(data.version) : null;
    } catch (err) {
      logger.warn(
        `Failed to check for OpenCode CLI updates: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  private async readHealthInfo(): Promise<{ healthy: boolean; version?: string }> {
    try {
      const res = await fetch(`${this.url}/global/health`, {
        signal: AbortSignal.timeout(OpenCodeServer.HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return { healthy: false };
      return (await res.json()) as { healthy: boolean; version?: string };
    } catch {
      return { healthy: false };
    }
  }

  private async runCliCommand(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (result: { output?: string; error?: Error }) => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (result.error) {
          reject(result.error);
          return;
        }
        resolve(result.output || '');
      };

      try {
        const command = this.resolveCommand();
        const launch = resolveServerLaunch(command, args);
        const proc = spawn(launch.command, launch.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: this.getWorkspaceCwd(),
          env: this.buildServerEnv(),
          windowsHide: true,
          ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        });

        proc.stdout?.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        proc.stderr?.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        proc.once('error', (err) => {
          finish({
            error: err.message.includes('ENOENT')
              ? new Error(OpenCodeServer.MISSING_CLI_MESSAGE)
              : err,
          });
        });
        proc.once('exit', (code, signal) => {
          if (code === 0) {
            finish({ output: stdout.trim() });
            return;
          }
          const message =
            stderr.trim() ||
            stdout.trim() ||
            `OpenCode CLI command failed${signal ? ` (${signal})` : code !== null ? ` (code ${code})` : ''}`;
          finish({ error: new Error(message) });
        });

        timer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
          finish({ error: new Error('OpenCode CLI command timed out') });
        }, OpenCodeServer.CLI_COMMAND_TIMEOUT_MS);
      } catch (err) {
        finish({ error: err instanceof Error ? err : new Error(String(err)) });
      }
    });
  }

  async dispose() {
    await this.disposeResources({ stopProcess: true });
  }

  async disconnect() {
    await this.disposeResources({ stopProcess: false });
  }

  private async disposeResources(options: { stopProcess: boolean }) {
    this.isDisposing = true;
    this.disposeGeneration += 1;
    this.clearStartPromise();
    this.clearRestartTimer();
    this.stopMaintenanceLoop();
    this.cancelPollHealth();
    this.stopEventStream();
    this.pendingAttentionRequests.clear();
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();
    if (options.stopProcess) {
      this.port = this.originalPort;
      this.portFallbackAttempts = 0;
      this.portInUseDetected = false;
    }
    if (options.stopProcess && this.process) {
      const proc = this.process;
      this.process = null;
      this.managedProcess = false;
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

  private runInTerminal(command: string, title: string) {
    const text = command.trim();
    if (!text) return;

    const terminal = vscode.window.createTerminal({
      name: title,
      cwd: this.getWorkspaceCwd(),
    });
    terminal.show(false);
    terminal.sendText(text, true);
  }

  private scopedUrl(path: string): { url: string; directory?: string } {
    const url = new URL(path, this.url);
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== this.url) {
      throw new Error('Unsupported OpenCode API path');
    }
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

  private tryAdvancePort(): boolean {
    if (this.portFallbackAttempts >= OpenCodeServer.PORT_FALLBACK_MAX_OFFSET) return false;
    this.portFallbackAttempts += 1;
    this.port = this.originalPort + this.portFallbackAttempts;
    return true;
  }
}

function isPortInUseMessage(text: string): boolean {
  return /\bEADDRINUSE\b|address already in use|port .* (already )?in use/i.test(text);
}

function normalizeRunningStatus(next: ServerStatus, previous: ServerStatus): ServerStatus {
  if (next.state !== 'running') return next;
  if (next.eventStream) return next;
  if (previous.state !== 'running') return { ...next, eventStream: 'healthy' };
  return { ...next, eventStream: previous.eventStream || 'healthy' };
}

const SSE_CHUNK_BOUNDARY_RE = /\r\n\r\n|\n\n|\r\r|\r\n\n|\n\r\n/g;

function findSseChunkBoundary(
  buffer: string,
  fromIndex: number
): { index: number; length: number } | null {
  SSE_CHUNK_BOUNDARY_RE.lastIndex = fromIndex;
  const match = SSE_CHUNK_BOUNDARY_RE.exec(buffer);
  if (!match) return null;
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

function extractVersion(value: string): string | null {
  const match = value.trim().match(/\d+(?:\.\d+)+/);
  return match ? match[0] : null;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
