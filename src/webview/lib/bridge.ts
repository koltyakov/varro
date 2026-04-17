import type { ExtensionMessage, WebviewMessage } from "../../shared/protocol"

type MessageHandler = (msg: ExtensionMessage) => void

const handlers = new Set<MessageHandler>()

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data as ExtensionMessage
  for (const handler of handlers) handler(msg)
})

export function onMessage(handler: MessageHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function postMessage(msg: WebviewMessage): void {
  const send = (window as any).__sendToExtension as ((m: WebviewMessage) => void) | undefined
  if (send) send(msg)
}

let reqId = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

onMessage((msg) => {
  if (msg.type === "api/response") {
    const p = pending.get(msg.payload.id)
    if (!p) return
    pending.delete(msg.payload.id)
    if (msg.payload.error) p.reject(new Error(msg.payload.error))
    else p.resolve(msg.payload.data)
  }
})

export function apiCall<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const id = ++reqId
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    postMessage({ type: "api/request", payload: { id, method, path, body } })
  })
}
