import type { Persistence } from '../shared/persistence';
import type { QueuedMessageSnapshot } from '../shared/protocol';

const QUEUED_MESSAGES_KEY = 'varro.queuedMessages';

export class QueuedMessageStore {
  private messages: QueuedMessageSnapshot[] | undefined;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(QUEUED_MESSAGES_KEY);
    this.messages = stored === undefined ? undefined : Array.isArray(stored) ? stored : [];
  }

  list(): QueuedMessageSnapshot[] | undefined {
    return this.messages;
  }

  update(messages: QueuedMessageSnapshot[]): Promise<void> {
    this.messages = messages;
    const operation = this.persistenceQueue.then(() =>
      this.persistence.set(QUEUED_MESSAGES_KEY, messages)
    );
    this.persistenceQueue = operation.then(
      () => {},
      () => {}
    );
    return operation;
  }

  dispose(): Promise<void> {
    return this.persistenceQueue;
  }
}
