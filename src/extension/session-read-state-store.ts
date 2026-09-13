/* oxlint-disable anti-slop/no-runtime-typeof -- Persisted read timestamps require runtime validation. */
import type { Persistence } from '../shared/persistence';
import { asRecord } from '../shared/type-utils';

const SESSION_READ_STATE_KEY = 'varro.sessionReadState';

export class SessionReadStateStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {}

  list() {
    const stored = asRecord(this.persistence.get<unknown>(SESSION_READ_STATE_KEY));
    const markers: Record<string, number> = {};
    for (const [sessionId, value] of Object.entries(stored ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        Object.defineProperty(markers, sessionId, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    return markers;
  }

  set(sessionId: string, seenAt: number): Promise<void> {
    const result = this.mutationQueue.then(async () => {
      const markers = this.list();
      if ((markers[sessionId] ?? -1) >= seenAt) return;
      markers[sessionId] = seenAt;
      await this.persistence.set(SESSION_READ_STATE_KEY, markers);
    });
    this.mutationQueue = result.catch(() => undefined);
    return result;
  }

  dispose(): Promise<void> {
    return this.mutationQueue;
  }
}
