import type { ExtensionMessage, WebviewMessage } from '../../shared/protocol';
import { parseExtensionMessage } from '../../shared/extension-message';

type MessageHandler = (msg: ExtensionMessage) => void;
type ApiCallOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  retries?: number;
};

const handlers = new Set<MessageHandler>();

const messageListener = (event: MessageEvent) => {
  const msg = parseExtensionMessage(event.data);
  if (!msg) return;
  for (const handler of handlers) handler(msg);
};

window.addEventListener('message', messageListener);

export function cleanupBridge() {
  window.removeEventListener('message', messageListener);
  handlers.clear();
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('Bridge cleaned up'));
  }
  pending.clear();
}

export function onMessage(handler: MessageHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function postMessage(msg: WebviewMessage): boolean {
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
    cleanupAbort?: () => void;
  }
>();
const API_CALL_TIMEOUT_MS = 35_000;
const API_CALL_LONG_TIMEOUT_MS = 40_000;
const API_CALL_RETRY_DELAY_MS = 150;

onMessage((msg) => {
  if (msg.type === 'api/response') {
    const p = pending.get(msg.payload.id);
    if (!p) return;
    clearTimeout(p.timer);
    p.cleanupAbort?.();
    pending.delete(msg.payload.id);
    if (msg.payload.error) p.reject(new Error(msg.payload.error));
    else p.resolve(msg.payload.data);
  }
});

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
  const id = ++reqId;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      const entry = pending.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        entry.cleanupAbort?.();
        pending.delete(id);
      }
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`API call timed out: ${method} ${path}`)));
    }, options.timeoutMs);

    let cleanupAbort: (() => void) | undefined;
    pending.set(id, {
      resolve: (value) => finish(() => resolve(value as T)),
      reject: (error) => finish(() => reject(error)),
      timer,
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

    const sent = postMessage({
      type: 'api/request',
      payload: {
        id,
        method,
        path,
        body,
      },
    });

    if (sent) return;

    finish(() => {
      if (options.retries > 0 && !options.signal?.aborted) {
        window.setTimeout(() => {
          void sendApiCall<T>(method, path, body, {
            ...options,
            retries: options.retries - 1,
          }).then(resolve, reject);
        }, API_CALL_RETRY_DELAY_MS);
        return;
      }
      reject(new Error(`Extension transport unavailable: ${method} ${path}`));
    });
  });
}

function defaultTimeoutForPath(path: string) {
  return /\/prompt_async$|\/summarize$/.test(path) ? API_CALL_LONG_TIMEOUT_MS : API_CALL_TIMEOUT_MS;
}
