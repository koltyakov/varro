import type { ExtensionMessage, WebviewMessage } from '../../shared/protocol';

type MessageHandler = (msg: ExtensionMessage) => void;

const handlers = new Set<MessageHandler>();

const messageListener = (event: MessageEvent) => {
  const msg = event.data as ExtensionMessage;
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

export function postMessage(msg: WebviewMessage): void {
  const send = (window as unknown as Record<string, unknown>).__sendToExtension as
    | ((m: WebviewMessage) => void)
    | undefined;
  if (send) send(msg);
}

let reqId = 0;
const pending = new Map<
  number,
  { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout> }
>();
const API_CALL_TIMEOUT_MS = 30_000;

onMessage((msg) => {
  if (msg.type === 'api/response') {
    const p = pending.get(msg.payload.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(msg.payload.id);
    if (msg.payload.error) p.reject(new Error(msg.payload.error));
    else p.resolve(msg.payload.data);
  }
});

export function apiCall<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const id = ++reqId;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`API call timed out: ${method} ${path}`));
    }, API_CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    postMessage({
      type: 'api/request',
      payload: {
        id,
        method,
        path,
        body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)),
      },
    });
  });
}
