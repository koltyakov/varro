import type { ServerStatus } from '../shared/protocol';
import { logger } from './logger';
import { getOpenCodeDirectoryHeaders, scopeOpenCodeRequest } from './util/opencode-request';
import { anySignal, asRecord, findSseChunkBoundary, getString } from './server-utils';

type EventStreamState = 'healthy' | 'degraded';

// OpenCode's v2 event stream. Current servers emit direct `{ id, type, properties }`
// events plus heartbeat messages, scoped by the `x-opencode-directory` header.
const EVENT_STREAM_PATH = '/api/event';

interface OpenCodeTransportOptions {
  getUrl: () => string;
  getWorkspaceCwd: () => string | undefined;
  getStatus: () => ServerStatus;
  isDisposing: () => boolean;
  updateEventStreamState: (eventStream: EventStreamState) => void;
  emitEvent: (event: unknown) => void;
}

export class OpenCodeTransport {
  private static readonly HEALTH_TIMEOUT_MS = 2000;
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private static readonly EVENT_CONNECT_TIMEOUT_MS = 10_000;
  private static readonly EVENT_IDLE_TIMEOUT_MS = 45_000;
  private static readonly EVENT_MAX_BUFFER_CHARS = 1_000_000;
  private static readonly EVENT_MAX_PAYLOAD_CHARS = 250_000;
  private static readonly EVENT_RECONNECT_WARNING_THRESHOLD = 10;
  private static readonly MAX_EVENT_RECONNECT_DELAY_MS = 30_000;

  private readonly options: OpenCodeTransportOptions;
  private eventController: AbortController | null = null;
  private eventReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventReconnectDelay = 1000;
  private eventReconnectCount = 0;
  private eventStreamGeneration = 0;
  private readonly requestControllers = new Set<AbortController>();
  private readonly pendingAttentionRequests = new Map<string, string>();

  constructor(options: OpenCodeTransportOptions) {
    this.options = options;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const scoped = scopeOpenCodeRequest(
      this.options.getUrl(),
      path,
      this.getWorkspaceDirectoryForRequest(method, path)
    );
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const init: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...getOpenCodeDirectoryHeaders(scoped.directory),
      },
      signal: anySignal(
        controller.signal,
        AbortSignal.timeout(OpenCodeTransport.REQUEST_TIMEOUT_MS)
      ),
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
          typeof data === 'object' &&
          data &&
          'message' in data &&
          typeof (data as { message: unknown }).message === 'string'
            ? (data as { message: string }).message
            : res.statusText;
        throw new Error(`${res.status} ${msg}`);
      }
      return data;
    } finally {
      this.requestControllers.delete(controller);
    }
  }

  private getWorkspaceDirectoryForRequest(method: string, path: string) {
    const normalizedMethod = method.toUpperCase();
    const pathname = new URL(path, 'http://localhost').pathname;
    const useUnscopedSessionReads = process.platform === 'win32';
    // Keep workspace scoping only on writes that create or continue work in the
    // current workspace. Session reads are intentionally unscoped: the webview
    // already filters them by workspace, and re-adding backend scoping has
    // repeatedly regressed Windows reload/delete flows when directory strings
    // differ in separators, casing, or other formatting. Keep this Windows-only
    // so macOS/Linux retain their narrower backend scoping.
    if (normalizedMethod === 'POST' && pathname === '/session') {
      return this.options.getWorkspaceCwd();
    }
    if (normalizedMethod === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(pathname)) {
      return this.options.getWorkspaceCwd();
    }
    if (
      useUnscopedSessionReads &&
      (pathname === '/session' ||
        pathname === '/session/status' ||
        pathname.startsWith('/session/'))
    ) {
      return undefined;
    }
    if (pathname === '/session') {
      return this.options.getWorkspaceCwd();
    }
    if (
      normalizedMethod === 'GET' &&
      (/^\/session\/[^/]+$/.test(pathname) || /^\/session\/[^/]+\/message$/.test(pathname))
    ) {
      return this.options.getWorkspaceCwd();
    }
    if (pathname === '/session/status' || pathname.startsWith('/session/')) {
      return undefined;
    }
    return this.options.getWorkspaceCwd();
  }

  async readHealthInfo(): Promise<{ healthy: boolean; version?: string }> {
    try {
      const res = await fetch(`${this.options.getUrl()}/global/health`, {
        signal: AbortSignal.timeout(OpenCodeTransport.HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return { healthy: false };
      return (await res.json()) as { healthy: boolean; version?: string };
    } catch {
      return { healthy: false };
    }
  }

  async checkHealth(): Promise<boolean> {
    const data = await this.readHealthInfo();
    return data.healthy === true;
  }

  async startEventStream() {
    this.stopEventStream();
    const generation = ++this.eventStreamGeneration;
    this.eventController = new AbortController();
    const controller = this.eventController;
    let shouldReconnect = false;
    const scoped = scopeOpenCodeRequest(
      this.options.getUrl(),
      EVENT_STREAM_PATH,
      this.options.getWorkspaceCwd()
    );
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    const isCurrentStream = () => this.isCurrentEventStream(controller, generation);
    const clearConnectTimer = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
    };

    const abortForReconnect = (message: string, reason: string) => {
      if (!isCurrentStream() || controller.signal.aborted) return;
      shouldReconnect = true;
      logger.warn(message);
      controller.abort(new Error(reason));
    };

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortForReconnect('Event stream stalled; reconnecting', 'Event stream idle timeout');
      }, OpenCodeTransport.EVENT_IDLE_TIMEOUT_MS);
    };

    connectTimer = setTimeout(() => {
      abortForReconnect(
        'Event stream connection timed out; reconnecting',
        'Event stream connect timeout'
      );
    }, OpenCodeTransport.EVENT_CONNECT_TIMEOUT_MS);

    try {
      const res = await fetch(scoped.url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          ...getOpenCodeDirectoryHeaders(scoped.directory),
        },
      });
      clearConnectTimer();
      if (!isCurrentStream()) return;
      if (!res.ok || !res.body) throw new Error(`Failed to open event stream: ${res.status}`);
      this.eventReconnectDelay = 1000;
      this.eventReconnectCount = 0;
      this.options.updateEventStreamState('healthy');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let cursor = 0;
      resetIdleTimer();
      while (true) {
        const { value, done } = await reader.read();
        if (!isCurrentStream()) return;
        if (done) {
          buffer += decoder.decode();
          const finalChunk = buffer.slice(cursor).trim();
          if (finalChunk.length > 0) {
            this.processSseChunk(finalChunk, controller, generation);
          }
          logger.warn('Event stream closed; reconnecting');
          shouldReconnect = true;
          break;
        }
        resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        let boundary: { index: number; length: number } | null;
        while ((boundary = findSseChunkBoundary(buffer, cursor))) {
          this.processSseChunk(buffer.slice(cursor, boundary.index), controller, generation);
          cursor = boundary.index + boundary.length;
        }
        if (cursor > 0) {
          buffer = buffer.slice(cursor);
          cursor = 0;
        }
        if (buffer.length > OpenCodeTransport.EVENT_MAX_BUFFER_CHARS) {
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
      clearConnectTimer();
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (
        shouldReconnect &&
        this.isCurrentEventStream(controller, generation) &&
        this.options.getStatus().state === 'running' &&
        !this.options.isDisposing()
      ) {
        this.options.updateEventStreamState('degraded');
        this.eventReconnectCount++;
        if (this.eventReconnectCount === OpenCodeTransport.EVENT_RECONNECT_WARNING_THRESHOLD) {
          logger.warn(
            `Event stream reconnect attempts reached ${OpenCodeTransport.EVENT_RECONNECT_WARNING_THRESHOLD}; continuing background retries while keeping REST requests available`
          );
        }

        const delay = this.getEventReconnectDelay();
        this.eventReconnectTimer = setTimeout(() => {
          if (this.options.isDisposing() || this.options.getStatus().state !== 'running') {
            this.eventReconnectTimer = null;
            return;
          }
          this.eventReconnectTimer = null;
          void this.startEventStream();
        }, delay);
      }
    }
  }

  stopEventStream() {
    this.eventStreamGeneration += 1;
    if (this.eventReconnectTimer) {
      clearTimeout(this.eventReconnectTimer);
      this.eventReconnectTimer = null;
    }
    if (this.eventController) {
      this.eventController.abort();
      this.eventController = null;
    }
  }

  abortRequests() {
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();
  }

  clearPendingAttentionRequests() {
    this.pendingAttentionRequests.clear();
  }

  hasPendingAttentionRequests(): boolean {
    return this.pendingAttentionRequests.size > 0;
  }

  private processSseChunk(chunk: string, controller?: AbortController, generation?: number) {
    let data = '';
    for (const line of chunk.split(/\r\n|[\r\n]/)) {
      if (!line.startsWith('data:')) continue;
      const value = line.slice(5).trimStart();
      data = data.length === 0 ? value : `${data}\n${value}`;
    }
    if (data.length === 0) return;
    if (data.length > OpenCodeTransport.EVENT_MAX_PAYLOAD_CHARS) {
      logger.warn(
        `Ignoring oversized event stream payload (${data.length} chars > ${OpenCodeTransport.EVENT_MAX_PAYLOAD_CHARS})`
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      logger.warn(
        `Ignoring malformed event stream payload: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }
    if (
      controller &&
      generation !== undefined &&
      !this.isCurrentEventStream(controller, generation)
    ) {
      return;
    }
    try {
      this.observeServerEvent(parsed);
    } catch (err) {
      logger.warn(`Event observation threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.options.emitEvent(parsed);
    } catch (err) {
      logger.warn(`Event listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private observeServerEvent(event: unknown) {
    const evt = asRecord(event);
    const envelope = asRecord(evt?.payload) || evt;
    const type = getString(envelope?.type);
    const props = asRecord(envelope?.properties) || asRecord(envelope?.data);
    if (!type) return;
    const requestProps = asRecord(props?.info) || props;

    switch (type) {
      case 'permission.asked':
      case 'permission.v2.asked':
      case 'question.asked':
      case 'question.v2.asked': {
        const requestID =
          getString(requestProps?.id) ||
          getString(requestProps?.permissionID) ||
          getString(requestProps?.requestID);
        const sessionID = getString(requestProps?.sessionID);
        if (requestID && sessionID) {
          this.pendingAttentionRequests.set(requestID, sessionID);
        }
        break;
      }
      case 'permission.replied':
      case 'permission.v2.replied':
      case 'question.replied':
      case 'question.rejected':
      case 'question.v2.replied':
      case 'question.v2.rejected': {
        const requestID =
          getString(requestProps?.id) ||
          getString(requestProps?.permissionID) ||
          getString(requestProps?.requestID);
        if (requestID) {
          this.pendingAttentionRequests.delete(requestID);
        }
        break;
      }
      case 'session.deleted': {
        const sessionID = getString(props?.sessionID) || getString(asRecord(props?.info)?.id);
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

  private getEventReconnectDelay() {
    const delay = this.eventReconnectDelay;
    this.eventReconnectDelay = Math.min(delay * 2, OpenCodeTransport.MAX_EVENT_RECONNECT_DELAY_MS);
    const minDelay = Math.round(delay * 0.8);
    const maxDelay = Math.round(
      Math.min(delay * 1.2, OpenCodeTransport.MAX_EVENT_RECONNECT_DELAY_MS)
    );
    const jitterWindow = Math.max(maxDelay - minDelay, 0);
    return minDelay + Math.round(Math.random() * jitterWindow);
  }

  private isCurrentEventStream(controller: AbortController, generation: number) {
    return this.eventController === controller && this.eventStreamGeneration === generation;
  }
}
