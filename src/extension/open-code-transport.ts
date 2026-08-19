import { parseHealthResponse } from '../shared/health';
import { CURRENT_OPENCODE_ENDPOINTS } from '../shared/opencode-endpoints';
import { parseServerEvent, type ServerStatus } from '../shared/protocol';
import { isSameWorkspacePath } from '../shared/workspace-path';
import { logger } from './logger';
import { getOpenCodeDirectoryHeaders, scopeOpenCodeRequest } from './util/opencode-request';
import { anySignal, asRecord, findSseChunkBoundary, getString } from './server-utils';

type EventStreamState = 'healthy' | 'degraded';

export type OpenCodeResponseMetadata = {
  data: unknown;
  nextCursor?: string;
};

export type OpenCodeRequestOptions = {
  captureNextCursor?: boolean;
  maxResponseBytes?: number;
  maxProjectedResponseBytes?: number;
  stripSummaryDiffs?: boolean;
  unscoped?: boolean;
  signal?: AbortSignal;
};

export class OpenCodeResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`OpenCode response exceeded the ${maxBytes}-byte safety limit`);
    this.name = 'OpenCodeResponseTooLargeError';
  }
}

export type OpenCodeRescopeResult = {
  state: 'connected' | 'degraded' | 'unchanged' | 'inactive' | 'cancelled' | 'superseded';
  directory: string | undefined;
};

// The global stream survives per-workspace instance disposal. Its envelopes retain
// the event directory so Varro can filter them to the active workspace locally.
const EVENT_STREAM_PATH = CURRENT_OPENCODE_ENDPOINTS.eventStream;

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
  private static readonly RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
  private static readonly MCP_AUTH_TIMEOUT_MS = 5 * 60_000 + 10_000;
  private static readonly EVENT_CONNECT_TIMEOUT_MS = 10_000;
  private static readonly EVENT_STABILITY_WINDOW_MS = 15_000;
  private static readonly EVENT_IDLE_TIMEOUT_MS = 45_000;
  private static readonly EVENT_MAX_BUFFER_CHARS = 8_000_000;
  private static readonly EVENT_MAX_PAYLOAD_CHARS = 8_000_000;
  private static readonly EVENT_RECONNECT_WARNING_THRESHOLD = 10;
  private static readonly EVENT_PROCESSING_YIELD_MS = 8;
  private static readonly MAX_EVENT_RECONNECT_DELAY_MS = 30_000;
  private readonly options: OpenCodeTransportOptions;
  private eventController: AbortController | null = null;
  private eventReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private eventReconnectDelay = 1000;
  private eventReconnectCount = 0;
  private eventStreamGeneration = 0;
  private requestWorkspaceDirectory: string | undefined;
  private eventStreamDirectory: string | undefined;
  private readonly requestControllers = new Set<AbortController>();
  private readonly requestSettlementWaiters = new Set<() => void>();
  private readonly pendingAttentionRequests = new Map<string, string>();

  constructor(options: OpenCodeTransportOptions) {
    this.options = options;
    this.requestWorkspaceDirectory = options.getWorkspaceCwd();
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    options?: OpenCodeRequestOptions
  ): Promise<unknown> {
    const scoped = scopeOpenCodeRequest(
      this.options.getUrl(),
      path,
      options?.unscoped ? undefined : this.getWorkspaceDirectoryForRequest(method, path)
    );
    const controller = new AbortController();
    const timeoutSignal = AbortSignal.timeout(this.getRequestTimeoutMs(method, path));
    this.requestControllers.add(controller);
    const headers: Record<string, string> = {
      ...getOpenCodeDirectoryHeaders(scoped.directory),
    };
    const init: RequestInit = {
      method,
      headers,
      signal: options?.signal
        ? anySignal(controller.signal, timeoutSignal, options.signal)
        : anySignal(controller.signal, timeoutSignal),
    };
    try {
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(scoped.url, init);
      const text = await readResponseText(
        res,
        options?.maxResponseBytes ?? OpenCodeTransport.RESPONSE_MAX_BYTES,
        options?.stripSummaryDiffs === true,
        options?.maxProjectedResponseBytes
      );
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        const msg = getResponseErrorMessage(data, res.statusText);
        throw new Error(`${res.status} ${msg}`);
      }
      if (options?.captureNextCursor) {
        const nextCursor = res.headers.get('x-next-cursor')?.trim();
        return { data, ...(nextCursor ? { nextCursor } : {}) } satisfies OpenCodeResponseMetadata;
      }
      return data;
    } catch (err) {
      if (timeoutSignal.aborted && !controller.signal.aborted) {
        throw new Error(`OpenCode request timed out: ${method} ${path}`, { cause: err });
      }
      throw err;
    } finally {
      this.requestControllers.delete(controller);
      if (this.requestControllers.size === 0) {
        for (const resolve of this.requestSettlementWaiters) resolve();
        this.requestSettlementWaiters.clear();
      }
    }
  }

  private getRequestTimeoutMs(method: string, path: string): number {
    const pathname = new URL(path, 'http://localhost').pathname;
    if (method.toUpperCase() === 'POST' && /^\/mcp\/[^/]+\/auth\/authenticate$/.test(pathname)) {
      return OpenCodeTransport.MCP_AUTH_TIMEOUT_MS;
    }
    return OpenCodeTransport.REQUEST_TIMEOUT_MS;
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
      return this.requestWorkspaceDirectory;
    }
    if (normalizedMethod === 'POST' && /^\/session\/[^/]+\/prompt_async$/.test(pathname)) {
      return this.requestWorkspaceDirectory;
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
      return this.requestWorkspaceDirectory;
    }
    if (
      normalizedMethod === 'GET' &&
      (/^\/session\/[^/]+$/.test(pathname) || /^\/session\/[^/]+\/message$/.test(pathname))
    ) {
      return this.requestWorkspaceDirectory;
    }
    if (pathname === '/session/status' || pathname.startsWith('/session/')) {
      return undefined;
    }
    return this.requestWorkspaceDirectory;
  }

  async readHealthInfo(): Promise<{ healthy: boolean; version?: string }> {
    try {
      const res = await fetch(`${this.options.getUrl()}${CURRENT_OPENCODE_ENDPOINTS.health}`, {
        signal: AbortSignal.timeout(OpenCodeTransport.HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) return { healthy: false };
      return parseHealthResponse(await res.json()) ?? { healthy: false };
    } catch {
      return { healthy: false };
    }
  }

  async checkHealth(): Promise<boolean> {
    const data = await this.readHealthInfo();
    return data.healthy === true;
  }

  async startEventStream(
    eventStreamDirectory = this.requestWorkspaceDirectory,
    promoteDirectoryImmediately = true
  ) {
    this.resetEventStream();
    this.eventStreamDirectory = eventStreamDirectory;
    if (promoteDirectoryImmediately) {
      this.requestWorkspaceDirectory = eventStreamDirectory;
    }
    const generation = ++this.eventStreamGeneration;
    this.eventController = new AbortController();
    const controller = this.eventController;
    let shouldReconnect = false;
    let continuityEstablished = false;
    const eventStreamRequest = scopeOpenCodeRequest(
      this.options.getUrl(),
      EVENT_STREAM_PATH,
      undefined
    );
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;
    let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
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
      const res = await fetch(eventStreamRequest.url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          ...getOpenCodeDirectoryHeaders(eventStreamRequest.directory),
        },
      });
      clearConnectTimer();
      if (!isCurrentStream()) return;
      if (!res.ok || !res.body) throw new Error(`Failed to open event stream: ${res.status}`);
      continuityEstablished = true;
      this.options.updateEventStreamState('healthy');
      stabilityTimer = setTimeout(() => {
        if (!isCurrentStream() || controller.signal.aborted) return;
        this.eventReconnectDelay = 1000;
        this.eventReconnectCount = 0;
      }, OpenCodeTransport.EVENT_STABILITY_WINDOW_MS);
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
        let yieldedAt = Date.now();
        while ((boundary = findSseChunkBoundary(buffer, cursor))) {
          this.processSseChunk(buffer.slice(cursor, boundary.index), controller, generation);
          cursor = boundary.index + boundary.length;
          if (Date.now() - yieldedAt >= OpenCodeTransport.EVENT_PROCESSING_YIELD_MS) {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (!isCurrentStream()) return;
            yieldedAt = Date.now();
          }
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
      if (stabilityTimer) {
        clearTimeout(stabilityTimer);
        stabilityTimer = null;
      }
      if (
        shouldReconnect &&
        this.isCurrentEventStream(controller, generation) &&
        this.options.getStatus().state === 'running' &&
        !this.options.isDisposing()
      ) {
        if (continuityEstablished) this.clearPendingAttentionRequests();
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
          void this.startEventStream(this.eventStreamDirectory, false);
        }, delay);
      }
    }
  }

  rescopeEventStream(directory: string | undefined): Promise<OpenCodeRescopeResult> {
    if (this.requestWorkspaceDirectory === directory && this.eventStreamDirectory === directory) {
      return Promise.resolve({ state: 'unchanged', directory });
    }

    this.requestWorkspaceDirectory = directory;
    this.eventStreamDirectory = directory;
    return Promise.resolve({ state: 'connected', directory });
  }

  getWorkspaceDirectory() {
    return this.requestWorkspaceDirectory;
  }

  stopEventStream() {
    this.resetEventStream();
  }

  private resetEventStream() {
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
  }

  waitForRequestsToSettle(): Promise<void> {
    if (this.requestControllers.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.requestSettlementWaiters.add(resolve));
  }

  clearPendingAttentionRequests() {
    this.pendingAttentionRequests.clear();
  }

  hasPendingAttentionRequests(): boolean {
    return this.pendingAttentionRequests.size > 0;
  }

  getPendingAttentionSessionIDs(): string[] {
    return [...new Set(this.pendingAttentionRequests.values())];
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
    if (!this.isEventInCurrentDirectory(parsed)) return;
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
    const parsed = parseServerEvent(event);
    if (!parsed) return;
    const type = parsed.type;
    const props = asRecord(parsed.properties);
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

  private isEventInCurrentDirectory(event: unknown) {
    const evt = asRecord(event);
    const location = asRecord(evt?.location);
    const directory = getString(evt?.directory) || getString(location?.directory);
    return (
      !directory ||
      !this.eventStreamDirectory ||
      isSameWorkspacePath(directory, this.eventStreamDirectory)
    );
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

async function readResponseText(
  response: Response,
  maxBytes?: number,
  stripSummaryDiffs = false,
  maxProjectedBytes = maxBytes
): Promise<string> {
  if (!maxBytes) return response.text();

  const contentLength = Number(response.headers?.get('content-length'));
  if (!stripSummaryDiffs && Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new OpenCodeResponseTooLargeError(maxBytes);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new OpenCodeResponseTooLargeError(maxBytes);
    }
    const projected = stripSummaryDiffs ? stripDiffArrays(text) : text;
    if (maxProjectedBytes && new TextEncoder().encode(projected).byteLength > maxProjectedBytes) {
      throw new OpenCodeResponseTooLargeError(maxProjectedBytes);
    }
    return projected;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const projector = stripSummaryDiffs ? new DiffArrayProjector() : null;
  let bytes = 0;
  let projectedBytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new OpenCodeResponseTooLargeError(maxBytes);
      }
      const chunk = projector
        ? projector.write(decoder.decode(value, { stream: true }))
        : decoder.decode(value, { stream: true });
      projectedBytes += new TextEncoder().encode(chunk).byteLength;
      if (maxProjectedBytes && projectedBytes > maxProjectedBytes) {
        await reader.cancel();
        throw new OpenCodeResponseTooLargeError(maxProjectedBytes);
      }
      text += chunk;
    }
    const finalChunk = projector
      ? projector.write(decoder.decode()) + projector.finish()
      : decoder.decode();
    projectedBytes += new TextEncoder().encode(finalChunk).byteLength;
    if (maxProjectedBytes && projectedBytes > maxProjectedBytes) {
      throw new OpenCodeResponseTooLargeError(maxProjectedBytes);
    }
    return text + finalChunk;
  } finally {
    reader.releaseLock();
  }
}

function stripDiffArrays(text: string): string {
  const projector = new DiffArrayProjector();
  return projector.write(text) + projector.finish();
}

type JsonContainer = { type: 'array' } | { type: 'object'; expectingKey: boolean };

class DiffArrayProjector {
  private readonly stack: JsonContainer[] = [];
  private inString = false;
  private escaped = false;
  private key = '';
  private collectingKey = false;
  private pendingDiffsKey = false;
  private stripNextArray = false;
  private stripping = false;
  private stripDepth = 0;
  private stripInString = false;
  private stripEscaped = false;

  write(chunk: string): string {
    let output = '';
    let index = 0;
    while (index < chunk.length) {
      if (this.stripping) {
        const nextIndex = this.consumeStrippedChunk(chunk, index);
        if (nextIndex < 0) return output;
        output += '[],"diffsOmitted":true,"diffsTruncated":true';
        index = nextIndex;
        continue;
      }

      const char = chunk[index]!;
      index += 1;
      if (this.inString) {
        output += char;
        if (this.escaped) {
          this.escaped = false;
          if (this.collectingKey && this.key.length < 32) this.key += char;
          continue;
        }
        if (char === '\\') {
          this.escaped = true;
          continue;
        }
        if (char === '"') {
          this.inString = false;
          if (this.collectingKey) this.pendingDiffsKey = this.key === 'diffs';
          continue;
        }
        if (this.collectingKey && this.key.length < 32) this.key += char;
        continue;
      }

      if (this.pendingDiffsKey && char === ':') {
        output += char;
        this.stripNextArray = true;
        this.pendingDiffsKey = false;
        const object = this.currentObject();
        if (object) object.expectingKey = false;
        continue;
      }
      if (this.pendingDiffsKey && !/\s/.test(char)) this.pendingDiffsKey = false;
      if (this.stripNextArray && char === '[') {
        this.stripNextArray = false;
        this.stripping = true;
        this.stripDepth = 1;
        continue;
      }
      if (this.stripNextArray && !/\s/.test(char)) this.stripNextArray = false;

      output += char;
      if (char === '"') {
        this.inString = true;
        this.escaped = false;
        this.collectingKey = this.currentObject()?.expectingKey === true;
        this.key = '';
      } else if (char === '{') {
        this.stack.push({ type: 'object', expectingKey: true });
      } else if (char === '[') {
        this.stack.push({ type: 'array' });
      } else if (char === '}' || char === ']') {
        this.stack.pop();
      } else if (char === ',') {
        const object = this.currentObject();
        if (object) object.expectingKey = true;
      } else if (char === ':') {
        const object = this.currentObject();
        if (object) object.expectingKey = false;
      }
    }
    return output;
  }

  finish(): string {
    if (this.stripping || this.inString) throw new Error('Malformed JSON response');
    return '';
  }

  private currentObject(): Extract<JsonContainer, { type: 'object' }> | undefined {
    const current = this.stack[this.stack.length - 1];
    return current?.type === 'object' ? current : undefined;
  }

  private consumeStrippedChunk(chunk: string, start: number): number {
    for (let index = start; index < chunk.length; index += 1) {
      const code = chunk.charCodeAt(index);
      if (this.stripInString) {
        if (this.stripEscaped) this.stripEscaped = false;
        else if (code === 92) this.stripEscaped = true;
        else if (code === 34) this.stripInString = false;
        continue;
      }
      if (code === 34) this.stripInString = true;
      else if (code === 91 || code === 123) this.stripDepth += 1;
      else if (code === 93 || code === 125) this.stripDepth -= 1;
      if (this.stripDepth !== 0) continue;
      this.stripping = false;
      return index + 1;
    }
    return -1;
  }
}

function getResponseErrorMessage(data: unknown, fallback: string) {
  const record = asRecord(data);
  const direct =
    getString(record?.message) || getString(record?.detail) || getString(record?.error);
  if (direct) return direct;

  const nestedData = asRecord(record?.data);
  const nested = getString(nestedData?.message) || getString(nestedData?.detail);
  if (nested) return nested;

  return fallback;
}
