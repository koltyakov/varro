import type { Persistence } from '../shared/persistence';
import { isSafePersistedSessionId } from '../shared/protocol';
import { asRecord, isNumber } from '../shared/type-utils';

const SESSION_PLAN_STATE_KEY = 'varro.sessionPlanState';

export type SessionPlanState = Record<string, number | null>;

export class SessionPlanStateStore {
  private state: SessionPlanState;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = asRecord(persistence.get<unknown>(SESSION_PLAN_STATE_KEY));
    this.state = stored
      ? Object.fromEntries(
          Object.entries(stored).filter(
            (entry): entry is [string, number | null] =>
              isSafePersistedSessionId(entry[0]) &&
              (entry[1] === null || (isNumber(entry[1]) && Number.isFinite(entry[1])))
          )
        )
      : {};
  }

  list() {
    return { ...this.state };
  }

  set(sessionId: string, skippedAt: number | null): Promise<SessionPlanState> {
    if (
      !isSafePersistedSessionId(sessionId) ||
      (skippedAt !== null && !Number.isFinite(skippedAt))
    ) {
      return Promise.reject(new Error('Invalid session plan state'));
    }
    return this.mutate(async () => {
      this.state = { ...this.state, [sessionId]: skippedAt };
      await this.persistence.set(SESSION_PLAN_STATE_KEY, this.state);
      return this.list();
    });
  }

  dispose(): Promise<void> {
    return this.mutationQueue;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
