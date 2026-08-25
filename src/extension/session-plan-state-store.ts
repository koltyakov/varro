import type { Persistence } from '../shared/persistence';
import { isSafePersistedSessionId } from '../shared/protocol';
import { asRecord, isNumber, isString } from '../shared/type-utils';

const SESSION_PLAN_STATE_KEY = 'varro.sessionPlanState';
const SESSION_PLAN_AGENT_STATE_KEY = 'varro.sessionPlanAgentState';

export type SessionPlanState = Record<string, number | null>;

export class SessionPlanStateStore {
  private state: SessionPlanState;
  private agents: Record<string, string>;
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
    const storedAgents = asRecord(persistence.get<unknown>(SESSION_PLAN_AGENT_STATE_KEY));
    this.agents = storedAgents
      ? Object.fromEntries(
          Object.entries(storedAgents).filter(
            (entry): entry is [string, string] =>
              isSafePersistedSessionId(entry[0]) && isString(entry[1]) && entry[1].trim().length > 0
          )
        )
      : {};
  }

  list() {
    return { ...this.state };
  }

  listAgents() {
    return { ...this.agents };
  }

  set(sessionId: string, skippedAt: number | null): Promise<SessionPlanState> {
    if (
      !isSafePersistedSessionId(sessionId) ||
      (skippedAt !== null && !Number.isFinite(skippedAt))
    ) {
      return Promise.reject(new Error('Invalid session plan state'));
    }
    return this.update(sessionId, { skippedAt }).then((result) => result.state);
  }

  setAgent(sessionId: string, agent: string): Promise<Record<string, string>> {
    if (!isSafePersistedSessionId(sessionId) || !agent.trim()) {
      return Promise.reject(new Error('Invalid session plan agent state'));
    }
    return this.update(sessionId, { agent }).then((result) => result.agents);
  }

  update(
    sessionId: string,
    update: { skippedAt?: number | null; agent?: string }
  ): Promise<{ state: SessionPlanState; agents: Record<string, string> }> {
    if (
      !isSafePersistedSessionId(sessionId) ||
      (update.skippedAt !== undefined &&
        update.skippedAt !== null &&
        !Number.isFinite(update.skippedAt)) ||
      (update.agent !== undefined && !update.agent.trim())
    ) {
      return Promise.reject(new Error('Invalid session plan state update'));
    }
    return this.mutate(async () => {
      if (update.skippedAt !== undefined) {
        this.state = { ...this.state, [sessionId]: update.skippedAt };
        await this.persistence.set(SESSION_PLAN_STATE_KEY, this.state);
      }
      if (update.agent !== undefined) {
        this.agents = { ...this.agents, [sessionId]: update.agent };
        await this.persistence.set(SESSION_PLAN_AGENT_STATE_KEY, this.agents);
      }
      return { state: this.list(), agents: this.listAgents() };
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
