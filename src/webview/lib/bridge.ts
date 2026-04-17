import type { ExtensionMessage, WebviewMessage } from "../../shared/protocol"

type MessageHandler = (msg: ExtensionMessage) => void

const handlers = new Set<MessageHandler>()

function deliver(msg: ExtensionMessage) {
  for (const handler of handlers) {
    handler(msg)
  }
}

window.addEventListener("message", (event: MessageEvent) => {
  deliver(event.data as ExtensionMessage)
})

export function onMessage(handler: MessageHandler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}

export function postMessage(msg: WebviewMessage): void {
  ;(window as any).__sendToExtension(msg)
}

let reqId = 0
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

onMessage((msg) => {
  if (msg.type === "api/response") {
    const p = pending.get(msg.payload.id)
    if (p) {
      pending.delete(msg.payload.id)
      if (msg.payload.error) {
        p.reject(new Error(msg.payload.error))
      } else {
        p.resolve(msg.payload.data)
      }
    }
  }
})

export function apiCall(method: string, path: string, body?: unknown): Promise<any> {
  const id = ++reqId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    postMessage({ type: "api/request" as any, payload: { id, method, path, body } } as any)
  })
}
