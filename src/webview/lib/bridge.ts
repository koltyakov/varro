import type { ExtensionMessage, WebviewMessage } from '../../shared/protocol';
import { parseExtensionMessage } from '../../shared/extension-message';

type MessageHandler = (msg: ExtensionMessage) => void;
export type SlowApiRequest = {
  id: number;
  method: string;
  path: string;
  startedAt: number;
};
type SlowApiRequestHandler = (requests: readonly SlowApiRequest[]) => void;
type ApiCallOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  retries?: number;
};

const handlers = new Set<MessageHandler>();
const slowApiRequestHandlers = new Set<SlowApiRequestHandler>();
const slowApiRequests = new Map<number, SlowApiRequest>();
let disposed = false;
const BRIDGE_CLEANUP_KEY = '__cleanupVarroBridge';
const bridgeWindow = window as unknown as Record<string, unknown>;

const messageListener = (event: MessageEvent) => {
  const msg = parseExtensionMessage(event.data);
  if (!msg) return;
  for (const handler of handlers) handler(msg);
};

window.addEventListener('message', messageListener);

export function cleanupBridge() {
  disposed = true;
  window.removeEventListener('message', messageListener);
  handlers.clear();
  for (const p of pending.values()) {
    p.reject(new Error('Bridge cleaned up'));
  }
  pending.clear();
  slowApiRequests.clear();
  notifySlowApiRequestsChanged();
  slowApiRequestHandlers.clear();
  for (const retry of pendingRetries) {
    clearTimeout(retry.timer);
    pendingRetries.delete(retry);
    retry.reject(new Error('Bridge cleaned up'));
  }
  if (bridgeWindow[BRIDGE_CLEANUP_KEY] === cleanupBridge) {
    delete bridgeWindow[BRIDGE_CLEANUP_KEY];
  }
}

export function onMessage(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function onSlowApiRequestsChange(handler: SlowApiRequestHandler): () => void {
  slowApiRequestHandlers.add(handler);
  handler([...slowApiRequests.values()]);
  return () => slowApiRequestHandlers.delete(handler);
}

export function postMessage(msg: WebviewMessage): boolean {
  if (disposed) return false;
  const send = (window as unknown as Record<string, unknown>).__sendToExtension as
    | ((m: WebviewMessage) => void)
    | undefined;
  if (!send) return false;
  send(msg);
  return true;
}

let reqId = 0;
const pending = new Map<
  number,
  {
    resolve(v: unknown): void;
    reject(e: unknown): void;
    timer: ReturnType<typeof setTimeout>;
    slowTimer: ReturnType<typeof setTimeout>;
    cleanupAbort?: () => void;
  }
>();
type PendingRetry = {
  timer: number;
  reject(error: Error): void;
};
const pendingRetries = new Set<PendingRetry>();
const API_CALL_TIMEOUT_MS = 35_000;
const API_CALL_LONG_TIMEOUT_MS = 40_000;
const API_CALL_RETRY_DELAY_MS = 150;
export const SLOW_API_REQUEST_THRESHOLD_MS = 15_000;

onMessage((msg) => {
  if (msg.type === 'api/response') {
    const p = pending.get(msg.payload.id);
    if (!p) return;
    if (msg.payload.error) p.reject(new Error(msg.payload.error));
    else p.resolve(msg.payload.data);
  }
});
bridgeWindow[BRIDGE_CLEANUP_KEY] = cleanupBridge;

export function apiCall<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options?: ApiCallOptions
): Promise<T> {
  return sendApiCall(method, path, body, {
    timeoutMs: options?.timeoutMs ?? defaultTimeoutForPath(path),
    signal: options?.signal,
    retries: options?.retries ?? 1,
  });
}

function sendApiCall<T>(
  method: string,
  path: string,
  body: unknown,
  options: { timeoutMs: number; signal?: AbortSignal; retries: number }
): Promise<T> {
  if (disposed) return Promise.reject(new Error('Bridge cleaned up'));
  const id = ++reqId;
  const startedAt = Date.now();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      const entry = pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        clearTimeout(entry.slowTimer);
        entry.cleanupAbort?.();
        pending.delete(id);
      }
      if (slowApiRequests.delete(id)) notifySlowApiRequestsChanged();
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`API call timed out: ${method} ${path}`)));
    }, options.timeoutMs);
    const slowTimer = setTimeout(() => {
      if (!pending.has(id)) return;
      slowApiRequests.set(id, {
        id,
        method: method.toUpperCase(),
        path: sanitizeDiagnosticPath(path),
        startedAt,
      });
      notifySlowApiRequestsChanged();
    }, SLOW_API_REQUEST_THRESHOLD_MS);

    let cleanupAbort: (() => void) | undefined;
    pending.set(id, {
      resolve: (value) => finish(() => resolve(value as T)),
      reject: (error) => finish(() => reject(error)),
      timer,
      slowTimer,
      cleanupAbort,
    });

    if (options.signal) {
      const abort = () => {
        finish(() => {
          reject(
            options.signal?.reason instanceof Error
              ? options.signal.reason
              : new Error('API call aborted')
          );
        });
      };

      if (options.signal.aborted) {
        abort();
        return;
      }

      options.signal.addEventListener('abort', abort, { once: true });
      cleanupAbort = () => options.signal?.removeEventListener('abort', abort);
      pending.get(id)!.cleanupAbort = cleanupAbort;
    }

    let sendError: unknown;
    let sent = false;
    try {
      sent = postMessage({
        type: 'api/request',
        payload: {
          id,
          method,
          path,
          body,
        },
      });
    } catch (err) {
      sendError = err;
    }

    if (sent) return;

    finish(() => {
      if (options.retries > 0 && !options.signal?.aborted) {
        const retry: PendingRetry = {
          timer: 0,
          reject: (error: Error) => reject(error),
        };
        retry.timer = window.setTimeout(() => {
          pendingRetries.delete(retry);
          if (disposed) {
            reject(new Error('Bridge cleaned up'));
            return;
          }
          void sendApiCall<T>(method, path, body, {
            ...options,
            retries: options.retries - 1,
          }).then(resolve, reject);
        }, API_CALL_RETRY_DELAY_MS);
        pendingRetries.add(retry);
        return;
      }
      // sendError may cross the webview host realm boundary (e.g. a
      // DataCloneError from structured clone), where instanceof Error fails;
      // any thrown value is a send failure, not a missing transport.
      reject(
        sendError !== undefined
          ? new Error(
              `Extension transport failed: ${method} ${path}: ${describeSendError(sendError)}`
            )
          : new Error(`Extension transport unavailable: ${method} ${path}`)
      );
    });
  });
}

function describeSendError(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) {
    const message = (value as { message: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(value);
}

function sanitizeDiagnosticPath(path: string): string {
  try {
    return new URL(path, 'http://varro.local').pathname;
  } catch {
    return path.split('?')[0] || '/';
  }
}

function notifySlowApiRequestsChanged() {
  const snapshot = [...slowApiRequests.values()];
  for (const handler of slowApiRequestHandlers) handler(snapshot);
}

function defaultTimeoutForPath(path: string) {
  return /\/prompt_async$|\/summarize$/.test(path) ? API_CALL_LONG_TIMEOUT_MS : API_CALL_TIMEOUT_MS;
}
