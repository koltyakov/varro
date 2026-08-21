type QueuedMessageRemovalHandler = (queuedMessageId: string) => void;

let queuedMessageRemovalHandler: QueuedMessageRemovalHandler | null = null;

export function registerQueuedMessageRemovalHandler(handler: QueuedMessageRemovalHandler) {
  queuedMessageRemovalHandler = handler;
  return () => {
    if (queuedMessageRemovalHandler === handler) queuedMessageRemovalHandler = null;
  };
}

export function prepareForQueuedMessageRemoval(queuedMessageId: string) {
  queuedMessageRemovalHandler?.(queuedMessageId);
}
