import type { Persistence } from '../shared/persistence';
import type { QueuedMessageSnapshot } from '../shared/protocol';
import { isString } from '../shared/type-utils';
import { sanitizeQueuedMessages } from './util/webview-message';

const QUEUED_MESSAGES_KEY = 'varro.queuedMessages';
const QUEUED_MESSAGE_REMOVALS_KEY = 'varro.queuedMessageRemovals';
const COMPLETION_PERSIST_ATTEMPTS = 3;
const MAX_COMPLETED_DISPATCHES = 512;

type PendingPersistence = {
  attempts: number;
  messages: QueuedMessageSnapshot[];
  persistRemovals: boolean;
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
};

export class QueuedMessageStore {
  private messages: QueuedMessageSnapshot[] | undefined;
  private durableMessages: QueuedMessageSnapshot[] | undefined;
  private readonly removalTombstones: Set<string>;
  private pendingPersistence: PendingPersistence | undefined;
  private persistenceDrain: Promise<void> | undefined;
  private persistenceDraining = false;
  private readonly dispatchClaims = new Map<
    string,
    { activeRequestId?: number; itemId: string; lease: number; viewId: string }
  >();
  private readonly completedDispatches = new Set<string>();
  private nextDispatchLease = 0;

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(QUEUED_MESSAGES_KEY);
    const storedRemovals = persistence.get<unknown>(QUEUED_MESSAGE_REMOVALS_KEY);
    this.removalTombstones = new Set(
      Array.isArray(storedRemovals) ? storedRemovals.filter(isString) : []
    );
    const messages = stored === undefined ? undefined : (sanitizeQueuedMessages(stored) ?? []);
    this.messages = messages?.filter(
      (message) => !this.removalTombstones.has(dispatchKey(message.sessionId, message.id))
    );
    this.durableMessages = this.messages;
  }

  list(): QueuedMessageSnapshot[] | undefined {
    return this.messages;
  }

  has(sessionId: string, itemId: string): boolean {
    return (this.messages ?? []).some(
      (message) => message.sessionId === sessionId && message.id === itemId
    );
  }

  update(messages: QueuedMessageSnapshot[]): Promise<void> {
    this.messages = messages;
    return this.persist(messages);
  }

  updateOwned(viewId: string, messages: QueuedMessageSnapshot[]): Promise<void> {
    const current = this.messages ?? [];
    const replacements: QueuedMessageSnapshot[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (this.completedDispatches.has(dispatchKey(message.sessionId, message.id))) continue;
      const existing = current.find((item) => item.id === message.id);
      if (existing && ownerViewId(existing) !== viewId) continue;
      replacements.push({
        ...message,
        messageId: message.messageId ?? existing?.messageId,
        ownerViewId: viewId,
      });
    }
    let replacementIndex = 0;
    const next = current.flatMap((message) => {
      if (ownerViewId(message) !== viewId) return [message];
      const replacement = replacements[replacementIndex++];
      return replacement ? [replacement] : [];
    });
    next.push(...replacements.slice(replacementIndex));

    this.messages = next;
    const removedKeys = current
      .filter(
        (message) =>
          ownerViewId(message) === viewId &&
          !next.some(
            (candidate) => candidate.id === message.id && candidate.sessionId === message.sessionId
          )
      )
      .map((message) => dispatchKey(message.sessionId, message.id));
    return removedKeys.length > 0 ? this.persistRemoval(next) : this.persist(next);
  }

  transferOwner(fromViewId: string, toViewId: string): Promise<void> {
    const current = this.messages ?? [];
    const next = current.map((message) =>
      ownerViewId(message) === fromViewId
        ? { ...message, ownerViewId: toViewId === 'sidebar' ? undefined : toViewId }
        : message
    );
    if (next.every((message, index) => message === current[index])) return Promise.resolve();
    this.messages = next;
    this.releaseDispatchClaimsForView(fromViewId);
    this.reconcileDispatchClaims();
    return this.persist(next);
  }

  reassignOwners(resolveOwner: (message: QueuedMessageSnapshot) => string): Promise<void> | null {
    const current = this.messages ?? [];
    const previousOwners = new Set<string>();
    const next = current.map((message) => {
      const currentOwner = ownerViewId(message);
      const nextOwner = resolveOwner(message);
      if (nextOwner === currentOwner) return message;
      previousOwners.add(currentOwner);
      return { ...message, ownerViewId: nextOwner === 'sidebar' ? undefined : nextOwner };
    });
    if (previousOwners.size === 0) return null;
    this.messages = next;
    for (const viewId of previousOwners) this.releaseDispatchClaimsForView(viewId);
    this.reconcileDispatchClaims();
    return this.persist(next);
  }

  claimDispatch(
    viewId: string,
    sessionId: string,
    itemId: string,
    isViewEligible: (candidateViewId: string) => boolean,
    mode: 'next' | 'steer' = 'next'
  ): { lease: number } | null {
    this.reconcileDispatchClaims(isViewEligible);
    const existing = this.dispatchClaims.get(sessionId);
    if (existing) {
      return existing.viewId === viewId && existing.itemId === itemId
        ? { lease: existing.lease }
        : null;
    }

    const canonical =
      mode === 'steer'
        ? (this.messages ?? []).find(
            (message) => message.sessionId === sessionId && message.id === itemId
          )
        : (this.messages ?? []).find(
            (message) => message.sessionId === sessionId && !message.paused
          );
    if (
      !canonical ||
      canonical.id !== itemId ||
      ownerViewId(canonical) !== viewId ||
      !isViewEligible(ownerViewId(canonical))
    ) {
      return null;
    }

    const claim = { itemId, lease: ++this.nextDispatchLease, viewId };
    this.dispatchClaims.set(sessionId, claim);
    return { lease: claim.lease };
  }

  isDispatchClaimCurrent(viewId: string, sessionId: string, itemId: string, lease: number) {
    const claim = this.dispatchClaims.get(sessionId);
    return claim?.viewId === viewId && claim.itemId === itemId && claim.lease === lease;
  }

  beginDispatchAdmission(
    viewId: string,
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number,
    messageId: string
  ): Promise<boolean> {
    if (!this.isDispatchClaimCurrent(viewId, sessionId, itemId, lease)) {
      return Promise.resolve(false);
    }
    const claim = this.dispatchClaims.get(sessionId)!;
    if (claim.activeRequestId !== undefined) return Promise.resolve(false);
    const current = this.messages ?? [];
    const message = current.find((item) => item.id === itemId && item.sessionId === sessionId);
    if (!message || (message.messageId !== undefined && message.messageId !== messageId))
      return Promise.resolve(false);
    if (message.messageId === undefined) {
      this.messages = current.map((item) => (item === message ? { ...item, messageId } : item));
    }
    claim.activeRequestId = requestId;
    return this.persist(this.messages ?? [], COMPLETION_PERSIST_ATTEMPTS)
      .then(() => this.isDispatchAdmissionCurrent(viewId, sessionId, itemId, lease, requestId))
      .catch((err) => {
        this.releaseDispatchAdmission(viewId, sessionId, itemId, lease, requestId);
        throw err;
      });
  }

  isDispatchAdmissionCurrent(
    viewId: string,
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number
  ) {
    const claim = this.dispatchClaims.get(sessionId);
    return (
      claim?.viewId === viewId &&
      claim.itemId === itemId &&
      claim.lease === lease &&
      claim.activeRequestId === requestId
    );
  }

  completeDispatchAdmission(
    viewId: string,
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number
  ): Promise<void> | null {
    if (!this.isDispatchAdmissionCurrent(viewId, sessionId, itemId, lease, requestId)) return null;
    this.dispatchClaims.delete(sessionId);
    this.completedDispatches.add(dispatchKey(sessionId, itemId));
    if (this.completedDispatches.size > MAX_COMPLETED_DISPATCHES) {
      this.completedDispatches.delete(this.completedDispatches.values().next().value!);
    }
    const current = this.messages ?? [];
    const next = current.filter(
      (message) => message.id !== itemId || message.sessionId !== sessionId
    );
    this.messages = next;
    return next.length === current.length
      ? Promise.resolve()
      : this.persistRemoval(next, COMPLETION_PERSIST_ATTEMPTS);
  }

  releaseDispatchAdmission(
    viewId: string,
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number
  ) {
    if (this.isDispatchAdmissionCurrent(viewId, sessionId, itemId, lease, requestId)) {
      this.dispatchClaims.delete(sessionId);
    }
  }

  releaseDispatchClaim(viewId: string, sessionId: string, itemId: string, lease: number) {
    const claim = this.dispatchClaims.get(sessionId);
    if (
      claim?.viewId === viewId &&
      claim.itemId === itemId &&
      claim.lease === lease &&
      claim.activeRequestId === undefined
    ) {
      this.dispatchClaims.delete(sessionId);
    }
  }

  releaseDispatchClaimsForView(viewId: string) {
    for (const [sessionId, claim] of this.dispatchClaims) {
      if (claim.viewId === viewId && claim.activeRequestId === undefined) {
        this.dispatchClaims.delete(sessionId);
      }
    }
  }

  private reconcileDispatchClaims(isViewEligible?: (viewId: string) => boolean) {
    for (const [sessionId, claim] of this.dispatchClaims) {
      if (claim.activeRequestId !== undefined) continue;
      const message = (this.messages ?? []).find((item) => item.id === claim.itemId);
      if (
        !message ||
        message.sessionId !== sessionId ||
        message.paused ||
        ownerViewId(message) !== claim.viewId ||
        (isViewEligible && !isViewEligible(claim.viewId))
      ) {
        this.dispatchClaims.delete(sessionId);
      }
    }
  }

  private persist(messages: QueuedMessageSnapshot[], attempts = 1): Promise<void> {
    return this.enqueuePersistence(messages, false, attempts);
  }

  private persistRemoval(messages: QueuedMessageSnapshot[], attempts = 1): Promise<void> {
    return this.enqueuePersistence(messages, true, attempts);
  }

  private enqueuePersistence(
    messages: QueuedMessageSnapshot[],
    persistRemovals: boolean,
    attempts: number
  ): Promise<void> {
    if (this.pendingPersistence) {
      this.pendingPersistence.messages = messages;
      this.pendingPersistence.attempts = Math.max(this.pendingPersistence.attempts, attempts);
      this.pendingPersistence.persistRemovals ||= persistRemovals;
      return this.pendingPersistence.promise;
    }

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pendingPersistence = {
      attempts,
      messages,
      persistRemovals,
      promise,
      reject,
      resolve,
    };
    this.startPersistenceDrain();
    return promise;
  }

  private startPersistenceDrain() {
    if (this.persistenceDraining) return;
    this.persistenceDraining = true;
    const drain = this.drainPersistence();
    this.persistenceDrain = drain;
    const finish = () => {
      if (this.persistenceDrain !== drain) return;
      this.persistenceDrain = undefined;
      this.persistenceDraining = false;
      if (this.pendingPersistence) this.startPersistenceDrain();
    };
    void drain.then(finish, finish);
  }

  private async drainPersistence() {
    while (this.pendingPersistence) {
      const pending = this.pendingPersistence;
      this.pendingPersistence = undefined;
      try {
        await this.writePendingPersistence(pending);
        pending.resolve();
      } catch (error) {
        if (this.messages === pending.messages) this.messages = this.durableMessages;
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async writePendingPersistence(pending: PendingPersistence) {
    const pendingKeys = new Set(
      pending.messages.map((message) => dispatchKey(message.sessionId, message.id))
    );
    const removedKeys = pending.persistRemovals
      ? (this.durableMessages ?? [])
          .map((message) => dispatchKey(message.sessionId, message.id))
          .filter((key) => !pendingKeys.has(key))
      : [];
    if (removedKeys.length > 0) {
      const addedKeys = removedKeys.filter((key) => !this.removalTombstones.has(key));
      for (const key of addedKeys) this.removalTombstones.add(key);
      try {
        await this.persistence.set(QUEUED_MESSAGE_REMOVALS_KEY, [...this.removalTombstones]);
      } catch (error) {
        for (const key of addedKeys) this.removalTombstones.delete(key);
        throw error;
      }
      this.durableMessages = (this.durableMessages ?? []).filter(
        (message) => !this.removalTombstones.has(dispatchKey(message.sessionId, message.id))
      );
    }
    const snapshotIsDurable = snapshotsMatch(pending.messages, this.durableMessages ?? []);

    let failure: unknown;
    for (let attempt = 0; attempt < pending.attempts; attempt += 1) {
      try {
        await this.persistence.set(QUEUED_MESSAGES_KEY, pending.messages);
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
      }
    }
    if (failure !== undefined) {
      if (snapshotIsDurable) {
        if (this.messages === pending.messages) this.messages = this.durableMessages;
        return;
      }
      throw failure;
    }

    if (this.removalTombstones.size === 0) {
      this.durableMessages = pending.messages;
      return;
    }

    const tombstonesAffectSnapshot = pending.messages.some((message) =>
      this.removalTombstones.has(dispatchKey(message.sessionId, message.id))
    );
    try {
      await this.persistence.set(QUEUED_MESSAGE_REMOVALS_KEY, []);
      this.removalTombstones.clear();
      this.durableMessages = pending.messages;
    } catch (error) {
      this.durableMessages = pending.messages.filter(
        (message) => !this.removalTombstones.has(dispatchKey(message.sessionId, message.id))
      );
      if (tombstonesAffectSnapshot) throw error;
    }
  }

  async whenIdle(): Promise<void> {
    while (this.persistenceDrain || this.pendingPersistence) {
      if (!this.persistenceDrain) this.startPersistenceDrain();
      await this.persistenceDrain;
    }
  }

  dispose(): Promise<void> {
    return this.whenIdle();
  }
}

function ownerViewId(message: QueuedMessageSnapshot) {
  return message.ownerViewId ?? 'sidebar';
}

function dispatchKey(sessionId: string, itemId: string) {
  return `${sessionId}\0${itemId}`;
}

function snapshotsMatch(left: QueuedMessageSnapshot[], right: QueuedMessageSnapshot[]) {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}
