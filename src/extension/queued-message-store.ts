import type { Persistence } from '../shared/persistence';
import type { QueuedMessageSnapshot } from '../shared/protocol';

const QUEUED_MESSAGES_KEY = 'varro.queuedMessages';
const COMPLETION_PERSIST_ATTEMPTS = 3;
const MAX_COMPLETED_DISPATCHES = 512;

export class QueuedMessageStore {
  private messages: QueuedMessageSnapshot[] | undefined;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private readonly dispatchClaims = new Map<
    string,
    { activeRequestId?: number; itemId: string; lease: number; viewId: string }
  >();
  private readonly completedDispatches = new Set<string>();
  private nextDispatchLease = 0;

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(QUEUED_MESSAGES_KEY);
    this.messages = stored === undefined ? undefined : Array.isArray(stored) ? stored : [];
  }

  list(): QueuedMessageSnapshot[] | undefined {
    return this.messages;
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
    return this.persist(next);
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

  claimDispatch(
    viewId: string,
    sessionId: string,
    itemId: string,
    isViewEligible: (candidateViewId: string) => boolean
  ): { lease: number } | null {
    this.reconcileDispatchClaims(isViewEligible);
    const existing = this.dispatchClaims.get(sessionId);
    if (existing) {
      return existing.viewId === viewId && existing.itemId === itemId
        ? { lease: existing.lease }
        : null;
    }

    const canonical = (this.messages ?? []).find(
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

  async beginDispatchAdmission(
    viewId: string,
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number,
    messageId: string
  ) {
    if (!this.isDispatchClaimCurrent(viewId, sessionId, itemId, lease)) return false;
    const claim = this.dispatchClaims.get(sessionId)!;
    if (claim.activeRequestId !== undefined) return false;
    const current = this.messages ?? [];
    const message = current.find((item) => item.id === itemId && item.sessionId === sessionId);
    if (!message || (message.messageId !== undefined && message.messageId !== messageId))
      return false;
    if (message.messageId === undefined) {
      this.messages = current.map((item) => (item === message ? { ...item, messageId } : item));
    }
    claim.activeRequestId = requestId;
    try {
      await this.persist(this.messages ?? [], COMPLETION_PERSIST_ATTEMPTS);
      return this.isDispatchAdmissionCurrent(viewId, sessionId, itemId, lease, requestId);
    } catch (err) {
      this.releaseDispatchAdmission(viewId, sessionId, itemId, lease, requestId);
      throw err;
    }
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
      : this.persist(next, COMPLETION_PERSIST_ATTEMPTS);
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
    const operation = this.persistenceQueue.then(async () => {
      let failure: unknown;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await this.persistence.set(QUEUED_MESSAGES_KEY, messages);
          return;
        } catch (err) {
          failure = err;
        }
      }
      throw failure;
    });
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

function ownerViewId(message: QueuedMessageSnapshot) {
  return message.ownerViewId ?? 'sidebar';
}

function dispatchKey(sessionId: string, itemId: string) {
  return `${sessionId}\0${itemId}`;
}
