/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Server events and persisted snapshots are validated before entering session state. */
/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Snapshot assertions follow discriminant and bounded-field validation. */
import * as vscode from 'vscode';
import { friendlyErrorName, isAbortedAssistantError } from '../shared/error-classification';
import type { Persistence } from '../shared/persistence';
import type { ExtensionMessage, ServerEvent } from '../shared/protocol';
import { AUTO_APPROVE_JUDGE_TIMEOUT_MS } from '../shared/protocol';
import type {
  PermissionEventProperties,
  PermissionV2AskedProperties,
  QuestionRequest,
} from '../shared/opencode-types';
import { normalizeSessionTitle } from '../shared/session-title';
import { asRecord } from '../shared/type-utils';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import { logger } from './logger';

export type PendingAttentionKind = 'permission' | 'question';
export type SiblingSessionAlertKind = 'attention' | 'error' | 'plan-ready';
export type SiblingSessionAlertCandidate = {
  sessionID: string;
  rootSessionID: string;
  directory: string;
  kinds: SiblingSessionAlertKind[];
};
export type PermissionAskEventType = 'permission.asked' | 'permission.v2.asked';

export type PendingAttentionEntry = {
  sessionID: string;
  kind: PendingAttentionKind;
  label: string;
  props: Record<string, unknown>;
  directory?: string;
  eventType?: PermissionAskEventType;
};

export type PendingAttentionReconciliation = {
  readonly kind: PendingAttentionKind;
  readonly mutationRevision: number;
  readonly requestGeneration: number;
  readonly workspacePath?: string;
};

export type InterruptedSessionSnapshot = {
  id: string;
  title?: string;
};

export type BlockingRequestSnapshot = {
  id: string;
  sessionID: string;
  kind: PendingAttentionKind;
  props: Record<string, unknown>;
  directory?: string;
  eventType?: PermissionAskEventType;
};

export type RecoverySnapshot = {
  interruptedSessions: InterruptedSessionSnapshot[];
  blockingRequests: BlockingRequestSnapshot[];
};

interface PersistedQuestionDefinition {
  question?: string;
  header?: string;
  multiple?: boolean;
  custom?: boolean;
  options: PersistedQuestionOption[];
}

interface PersistedQuestionOption {
  label: string;
  description?: string;
}

export type SessionBusyAttempt = {
  readonly sessionID: string;
  readonly id: number;
};

export interface SessionStateListener {
  /** Called whenever any state that the status bar renders has changed. */
  onStatusChange(): void;
}

export interface NotificationGate {
  /** Whether a user-facing toast should be shown right now. */
  shouldShow(sessionID: string): boolean;
}

const INTERRUPTED_SESSIONS_KEY = 'varro.interruptedSessions';
const BLOCKING_REQUESTS_KEY = 'varro.blockingRequests';
const MAX_PERSISTED_INTERRUPTED_SESSIONS = 50;
const MAX_PERSISTED_BLOCKING_REQUESTS = 100;
const MAX_PERSISTED_METADATA_ENTRIES = 20;
const MAX_PERSISTED_STRING_LENGTH = 500;
const MAX_SESSION_METADATA_ENTRIES = 200;
const MAX_DEFERRED_PROMPT_FAILURES = 100;
const MAX_DEFERRED_PROMPT_RECONCILIATIONS = 3;
const MIN_EPOCH_MILLIS = 1_000_000_000_000;
const COMPLETION_NOTIFICATION_CLOCK_SKEW_MS = 5_000;

/**
 * Owns all per-session state derived from the OpenCode event stream:
 * busy/completed/failed markers, titles, agents, and pending-attention
 * entries (blocking permission/question prompts). Persists just enough
 * so that reopening the editor after a crash can pick up where we left
 * off.
 */
export class SessionStateManager {
  private readonly busySessions = new Set<string>();
  private readonly completedSessions = new Set<string>();
  private readonly failedSessions = new Set<string>();
  private readonly sessionAgents = new Map<string, string>();
  private readonly sessionTitles = new Map<string, string>();
  private readonly sessionDirectories = new Map<string, string>();
  private readonly sessionParentIDs = new Map<string, string>();
  private readonly sessionModes = new Map<string, string>();
  private readonly busyStartedAt = new Map<string, number>();
  private readonly pendingAttention = new Map<string, PendingAttentionEntry>();
  private readonly deferredPermissionAttention = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly trailingBusyAfterCompletion = new Set<string>();
  private readonly blockingRequestMutations = new Set<string>();
  private readonly pendingAttentionRevisions: Record<PendingAttentionKind, number> = {
    permission: 0,
    question: 0,
  };
  private readonly pendingAttentionMutationRevisions: Record<
    PendingAttentionKind,
    Map<string, number>
  > = {
    permission: new Map(),
    question: new Map(),
  };
  private readonly pendingAttentionSessionDeletionRevisions: Record<
    PendingAttentionKind,
    Map<string, number>
  > = {
    permission: new Map(),
    question: new Map(),
  };
  private readonly activePendingAttentionReconciliations: Record<
    PendingAttentionKind,
    Map<number, number>
  > = {
    permission: new Map(),
    question: new Map(),
  };
  private readonly pendingAttentionRequestGenerations: Record<PendingAttentionKind, number> = {
    permission: 0,
    question: 0,
  };
  private readonly reconciledPendingAttentionRequestGenerations: Record<
    PendingAttentionKind,
    Map<string, number>
  > = {
    permission: new Map(),
    question: new Map(),
  };
  private readonly recoveryDeletedSessionIDs = new Set<string>();
  private readonly unclaimedInterruptedSessions = new Map<string, InterruptedSessionSnapshot>();
  private readonly busyAttempts = new Map<string, Set<number>>();
  private readonly deferredPromptFailures = new Map<
    number,
    { attempt: SessionBusyAttempt; remainingReconciliations: number }
  >();
  private readonly reconcileIdleSince = new Map<string, number>();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private recoverySnapshotPromise: Promise<RecoverySnapshot> | undefined;
  private interruptedRecoveryLoaded = false;
  private blockingRecoveryCleanupPending = false;
  private nextBusyAttemptID = 0;

  constructor(
    private readonly persistence: Persistence,
    private readonly listener: SessionStateListener,
    private readonly notificationGate: NotificationGate
  ) {}

  get busy(): ReadonlySet<string> {
    return this.busySessions;
  }

  get completed(): ReadonlySet<string> {
    return this.completedSessions;
  }

  get failed(): ReadonlySet<string> {
    return this.failedSessions;
  }

  get pending(): ReadonlyMap<string, PendingAttentionEntry> {
    return this.pendingAttention;
  }

  get pendingForUser(): ReadonlyMap<string, PendingAttentionEntry> {
    return new Map(
      [...this.pendingAttention].filter(([id]) => !this.deferredPermissionAttention.has(id))
    );
  }

  rootSessionIdFor(sessionID: string): string {
    const visited = new Set<string>();
    let current = sessionID;
    while (!visited.has(current)) {
      visited.add(current);
      const parent = this.sessionParentIDs.get(current);
      if (!parent) return current;
      current = parent;
    }
    return sessionID;
  }

  claimInterruptedSessions(): InterruptedSessionSnapshot[] {
    return [...this.unclaimedInterruptedSessions.values()];
  }

  acknowledgeInterruptedSessions(sessionIDs: readonly string[]): Promise<void> {
    const acknowledgedSessionIDs = new Set(sessionIDs);
    const interruptedSessions = this.getInterruptedSessionSnapshots().filter(
      (session) => !acknowledgedSessionIDs.has(session.id) || this.busySessions.has(session.id)
    );
    return this.enqueuePersistence(async () => {
      await this.persistence.set(INTERRUPTED_SESSIONS_KEY, interruptedSessions);
      for (const sessionID of acknowledgedSessionIDs) {
        this.unclaimedInterruptedSessions.delete(sessionID);
      }
    });
  }

  revealPermission(requestID: string): void {
    const request = this.pendingAttention.get(requestID);
    if (request?.kind !== 'permission') return;
    const timer = this.deferredPermissionAttention.get(requestID);
    if (!timer) return;
    clearTimeout(timer);
    this.deferredPermissionAttention.delete(requestID);
    this.showBlockingNotification('permission', request.sessionID, request.label);
    this.listener.onStatusChange();
  }

  titleFor(sessionID: string): string | undefined {
    return this.getSessionMetadata(this.sessionTitles, sessionID);
  }

  isPlanSession(sessionID: string): boolean {
    return this.getSessionMetadata(this.sessionAgents, sessionID) === 'plan';
  }

  directoryFor(sessionID: string): string | undefined {
    const directory = this.getSessionMetadata(this.sessionDirectories, sessionID);
    if (directory) return directory;
    const rootSessionID = this.rootSessionIdFor(sessionID);
    return rootSessionID === sessionID
      ? undefined
      : this.getSessionMetadata(this.sessionDirectories, rootSessionID);
  }

  getSiblingAlertCandidates(): SiblingSessionAlertCandidate[] {
    const candidates = new Map<
      string,
      {
        sessionID: string;
        rootSessionID: string;
        directory: string;
        kinds: Set<SiblingSessionAlertKind>;
      }
    >();
    const add = (sessionID: string, kind: SiblingSessionAlertKind) => {
      const rootSessionID = this.rootSessionIdFor(sessionID);
      const directory = this.directoryFor(sessionID);
      if (!directory) return;
      const existing = candidates.get(rootSessionID);
      if (existing) {
        existing.kinds.add(kind);
        return;
      }
      candidates.set(rootSessionID, {
        sessionID,
        rootSessionID,
        directory,
        kinds: new Set([kind]),
      });
    };

    for (const request of this.pendingForUser.values()) add(request.sessionID, 'attention');
    for (const sessionID of this.failedSessions) add(sessionID, 'error');
    for (const sessionID of this.completedSessions) {
      if (this.isPlanSession(sessionID)) add(sessionID, 'plan-ready');
    }

    return [...candidates.values()]
      .map((candidate) => ({ ...candidate, kinds: [...candidate.kinds].toSorted() }))
      .toSorted(
        (left, right) =>
          left.directory.localeCompare(right.directory) ||
          left.rootSessionID.localeCompare(right.rootSessionID)
      );
  }

  isSessionInWorkspace(sessionID: string, workspacePath: string | null | undefined): boolean {
    return this.getSessionWorkspaceMatch(sessionID, workspacePath) ?? false;
  }

  getSessionWorkspaceMatch(
    sessionID: string,
    workspacePath: string | null | undefined
  ): boolean | undefined {
    const normalizedWorkspace = normalizeWorkspaceIdentity(workspacePath);
    if (!normalizedWorkspace) return true;
    const directory = this.getSessionMetadata(this.sessionDirectories, sessionID);
    return directory ? isSameWorkspacePath(directory, workspacePath) : undefined;
  }

  removeSessions(sessionIDs: Iterable<string>): void {
    let changed = false;
    for (const sessionID of sessionIDs) {
      changed = this.removeSession(sessionID) || changed;
    }
    if (changed) {
      this.listener.onStatusChange();
      void this.persist();
    }
  }

  clearCompleted(): void {
    if (this.completedSessions.size === 0) return;
    this.completedSessions.clear();
    this.listener.onStatusChange();
  }

  clearCompletedInWorkspace(workspacePath: string | null | undefined): void {
    let changed = false;
    for (const sessionID of this.completedSessions) {
      if (!this.isSessionInWorkspace(sessionID, workspacePath)) continue;
      this.completedSessions.delete(sessionID);
      changed = true;
    }
    if (changed) this.listener.onStatusChange();
  }

  acknowledgeCompletedSession(sessionID: string): void {
    const rootSessionID = this.rootSessionIdFor(sessionID);
    let changed = false;
    for (const completedSessionID of this.completedSessions) {
      if (this.rootSessionIdFor(completedSessionID) !== rootSessionID) continue;
      this.completedSessions.delete(completedSessionID);
      changed = true;
    }
    if (changed) this.listener.onStatusChange();
  }

  /**
   * Optimistically marks a session busy the moment a prompt is forwarded to
   * the server. opencode admits a prompt and only later emits the SSE
   * `session.status { busy }` event; on fast turns the finish (idle /
   * step.ended) can arrive before that busy event, leaving the session
   * untracked so `finishBusySession` drops the completion. Pre-marking here
   * guarantees the busy marker is in place before any finish event lands,
   * eliminating the missed-finish race for ping-style turns.
   */
  markSessionBusy(sessionID: string): SessionBusyAttempt | undefined {
    if (!sessionID) return undefined;
    this.touchSessionMetadata(sessionID);
    this.trailingBusyAfterCompletion.delete(sessionID);
    const attempt = { sessionID, id: ++this.nextBusyAttemptID };
    const attempts = this.busyAttempts.get(sessionID) ?? new Set<number>();
    attempts.add(attempt.id);
    this.busyAttempts.set(sessionID, attempts);
    if (this.markBusyInternal(sessionID)) {
      this.listener.onStatusChange();
      void this.persist();
    }
    return attempt;
  }

  reconcilePromptFailure(attempt: SessionBusyAttempt, serverStatus: unknown): void {
    this.deferredPromptFailures.delete(attempt.id);
    const attempts = this.busyAttempts.get(attempt.sessionID);
    if (!attempts?.delete(attempt.id)) return;
    if (attempts.size === 0) this.busyAttempts.delete(attempt.sessionID);

    const statusType = getString(asRecord(serverStatus)?.type);
    let changed = false;
    if (statusType === 'busy' || statusType === 'retry') {
      changed = this.markBusyInternal(attempt.sessionID);
    } else if ((serverStatus === undefined || statusType === 'idle') && attempts.size === 0) {
      changed = this.clearBusy(attempt.sessionID);
    }
    if (changed) {
      this.listener.onStatusChange();
      void this.persist();
    }
  }

  deferPromptFailure(attempt: SessionBusyAttempt): void {
    if (!this.busyAttempts.get(attempt.sessionID)?.has(attempt.id)) return;
    this.deferredPromptFailures.set(attempt.id, {
      attempt,
      remainingReconciliations: MAX_DEFERRED_PROMPT_RECONCILIATIONS,
    });
    while (this.deferredPromptFailures.size > MAX_DEFERRED_PROMPT_FAILURES) {
      const oldest = this.deferredPromptFailures.values().next().value?.attempt;
      if (!oldest) break;
      this.reconcilePromptFailure(oldest, undefined);
    }
  }

  handleServerEvent(event: ServerEvent): void {
    const { type, properties: props } = event;
    let changed = false;

    switch (type) {
      case 'session.created':
      case 'session.updated': {
        this.rememberSessionMetadata(
          asRecord(props?.info) ?? undefined,
          getString(props?.sessionID)
        );
        break;
      }
      case 'session.deleted': {
        const sessionID = getString(props?.sessionID) || getString(asRecord(props?.info)?.id);
        if (!sessionID) break;
        changed = this.removeSession(sessionID) || changed;
        break;
      }
      case 'session.status': {
        const sessionID = getString(props?.sessionID);
        const statusType = getString(asRecord(props?.status)?.type);
        if (!sessionID || !statusType) break;
        if (statusType === 'busy' && this.trailingBusyAfterCompletion.delete(sessionID)) break;
        if (statusType === 'busy' || statusType === 'retry') {
          this.trailingBusyAfterCompletion.delete(sessionID);
          changed = this.markBusyInternal(sessionID) || changed;
        } else if (statusType === 'idle') {
          // `session.status { idle }` is opencode's authoritative turn-finish
          // signal (emitted by the run-state Runner's onIdle). Treat it as a
          // primary completion path so a fast turn whose step.ended/message
          // events lag or are missed still settles immediately.
          changed = this.finishBusySession(sessionID, undefined) || changed;
        }
        break;
      }
      case 'session.idle': {
        // The deprecated `session.idle` event is published alongside
        // `session.status { idle }` (see opencode session/status.ts) and shares
        // the same meaning; finish on it too so either signal recovers the UI.
        const sessionID = getString(props?.sessionID);
        if (!sessionID) break;
        changed = this.finishBusySession(sessionID, undefined) || changed;
        break;
      }
      case 'session.next.step.ended': {
        const sessionID = getString(props?.sessionID);
        if (!sessionID || isContinuationFinish(getString(props?.finish))) break;
        changed = this.finishBusySession(sessionID, getNumber(props?.timestamp)) || changed;
        break;
      }
      case 'session.next.prompt.admitted': {
        const sessionID = getString(props?.sessionID);
        if (sessionID) this.trailingBusyAfterCompletion.delete(sessionID);
        break;
      }
      case 'session.error': {
        const sessionID = getString(props?.sessionID);
        if (!sessionID) break;
        this.trailingBusyAfterCompletion.delete(sessionID);
        const error = asRecord(props?.error);
        changed =
          (error && isAbortedErrorRecord(error)
            ? this.clearAbortedSession(sessionID)
            : this.markSessionFailed(sessionID, error ?? undefined)) || changed;
        break;
      }
      case 'message.updated': {
        const info = asRecord(props?.info);
        const sessionID = getString(info?.sessionID);
        if (!sessionID) break;

        const agent = getString(info?.agent);
        if (agent) {
          this.setSessionMetadata(this.sessionAgents, sessionID, agent);
        }

        const mode = getString(info?.mode);
        if (mode) {
          this.setSessionMetadata(this.sessionModes, sessionID, mode);
        }

        if (getString(info?.role) !== 'assistant') {
          if (getString(info?.role) === 'user') {
            this.trailingBusyAfterCompletion.delete(sessionID);
          }
          break;
        }

        const error = asRecord(info?.error);
        if (error) {
          changed = this.markSessionFailed(sessionID, error) || changed;
        } else {
          changed = this.failedSessions.delete(sessionID) || changed;
        }
        if (error || typeof asRecord(info?.time)?.completed === 'number') {
          if (error) {
            changed = this.clearBusy(sessionID) || changed;
          } else if (!isContinuationFinish(getString(info?.finish))) {
            changed =
              this.finishBusySession(sessionID, getNumber(asRecord(info?.time)?.completed)) ||
              changed;
          }
        }
        break;
      }
      // `permission.updated` is OpenCode's legacy name for a pending
      // permission request; the webview treats it as an ask, so track it
      // here too to keep host and webview attention state in agreement.
      case 'permission.updated':
      case 'permission.asked':
      case 'permission.v2.asked': {
        const propsRecord = asRecord(props);
        const requestProps = asRecord(propsRecord?.info) || propsRecord;
        changed =
          (requestProps
            ? this.trackBlockingRequest(
                'permission',
                requestProps,
                type === 'permission.v2.asked' ? 'permission.v2.asked' : 'permission.asked'
              )
            : false) || changed;
        break;
      }
      case 'permission.replied':
      case 'permission.v2.replied': {
        const propsRecord = asRecord(props);
        const requestProps = asRecord(propsRecord?.info) || propsRecord;
        changed =
          this.clearBlockingRequest(
            'permission',
            getString(requestProps?.id) ||
              getString(requestProps?.permissionID) ||
              getString(requestProps?.requestID)
          ) || changed;
        break;
      }
      case 'question.asked':
      case 'question.v2.asked': {
        changed = (props ? this.trackBlockingRequest('question', props) : false) || changed;
        break;
      }
      case 'question.replied':
      case 'question.rejected':
      case 'question.v2.replied':
      case 'question.v2.rejected': {
        changed =
          this.clearBlockingRequest(
            'question',
            getString(props?.requestID) || getString(props?.id)
          ) || changed;
        break;
      }
    }

    if (changed) {
      this.listener.onStatusChange();
      void this.persist();
    }
  }

  persist(): Promise<void> {
    const interruptedSessions = this.getInterruptedSessionSnapshots();
    const blockingRequests = this.getBlockingRequestSnapshots();
    return this.enqueuePersistence(async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() =>
          this.persistence.set(INTERRUPTED_SESSIONS_KEY, interruptedSessions)
        ),
        Promise.resolve().then(() => this.persistence.set(BLOCKING_REQUESTS_KEY, blockingRequests)),
      ]);
      for (const result of results) {
        if (result.status === 'rejected') {
          logger.warn(
            `Failed to persist session state: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          );
        }
      }
    });
  }

  flush(): Promise<void> {
    return this.persistenceQueue;
  }

  consumeRecoverySnapshot(): Promise<RecoverySnapshot> {
    if (this.recoverySnapshotPromise) return this.recoverySnapshotPromise;

    const operation = this.enqueuePersistence(async () => {
      if (!this.interruptedRecoveryLoaded) {
        const persistedInterruptedSessions = validateInterruptedSessionSnapshots(
          this.persistence.get<unknown>(INTERRUPTED_SESSIONS_KEY)
        );
        this.interruptedRecoveryLoaded = true;
        for (const session of persistedInterruptedSessions) {
          if (!this.unclaimedInterruptedSessions.has(session.id)) {
            this.unclaimedInterruptedSessions.set(session.id, session);
          }
        }
      }
      const rawBlockingRequests = this.persistence.get<unknown>(BLOCKING_REQUESTS_KEY);
      const blockingRequests = validateBlockingRequestSnapshots(rawBlockingRequests);
      if (rawBlockingRequests !== undefined) this.blockingRecoveryCleanupPending = true;

      // Merge before yielding so subsequent server events always win. Current
      // process state includes both request replies and session deletions.
      const recoveredSessionIDs = new Set(blockingRequests.map((item) => item.sessionID));
      for (const sessionID of this.recoveryDeletedSessionIDs) {
        if (!recoveredSessionIDs.has(sessionID)) this.recoveryDeletedSessionIDs.delete(sessionID);
      }
      this.mergeBlockingRequests(blockingRequests);
      const blockingCleanup = await Promise.resolve()
        .then(() => this.persistence.remove(BLOCKING_REQUESTS_KEY))
        .then(
          () => true,
          (reason: unknown) => {
            logger.warn(
              `Failed to clean up recovered session state (${BLOCKING_REQUESTS_KEY}): ${reason instanceof Error ? reason.message : String(reason)}`
            );
            return false;
          }
        );
      if (blockingCleanup) {
        this.blockingRequestMutations.clear();
        this.recoveryDeletedSessionIDs.clear();
        this.blockingRecoveryCleanupPending = false;
      }
      return {
        interruptedSessions: this.claimInterruptedSessions(),
        blockingRequests: this.getLiveBlockingRequestSnapshots(),
      };
    });
    this.recoverySnapshotPromise = operation;
    void operation.then(
      () => {
        if (this.recoverySnapshotPromise === operation) this.recoverySnapshotPromise = undefined;
      },
      () => {
        if (this.recoverySnapshotPromise === operation) this.recoverySnapshotPromise = undefined;
      }
    );
    return operation;
  }

  beginPendingAttentionReconciliation(
    kind: PendingAttentionKind,
    workspacePath?: string
  ): PendingAttentionReconciliation {
    const requestGeneration = this.pendingAttentionRequestGenerations[kind] + 1;
    this.pendingAttentionRequestGenerations[kind] = requestGeneration;
    const mutationRevision = this.pendingAttentionRevisions[kind];
    this.activePendingAttentionReconciliations[kind].set(requestGeneration, mutationRevision);
    return { kind, mutationRevision, requestGeneration, workspacePath };
  }

  reconcilePendingAttention(
    kind: PendingAttentionKind,
    requests: readonly unknown[],
    reconciliation: PendingAttentionReconciliation = this.beginPendingAttentionReconciliation(kind)
  ): void {
    try {
      if (reconciliation.kind !== kind) {
        throw new Error(`Pending attention reconciliation kind mismatch: ${kind}`);
      }
      const mutationRevision = this.activePendingAttentionReconciliations[kind].get(
        reconciliation.requestGeneration
      );
      if (mutationRevision === undefined) return;
      const workspaceKey = normalizeWorkspaceIdentity(reconciliation.workspacePath) ?? '*';
      const reconciledGeneration =
        this.reconciledPendingAttentionRequestGenerations[kind].get(workspaceKey) ?? 0;
      if (reconciliation.requestGeneration < reconciledGeneration) {
        return;
      }
      this.reconciledPendingAttentionRequestGenerations[kind].set(
        workspaceKey,
        reconciliation.requestGeneration
      );
      this.applyPendingAttentionSnapshot(
        kind,
        requests,
        mutationRevision,
        reconciliation.workspacePath
      );
    } finally {
      this.finishPendingAttentionReconciliation(reconciliation);
    }
  }

  finishPendingAttentionReconciliation(reconciliation: PendingAttentionReconciliation): void {
    this.activePendingAttentionReconciliations[reconciliation.kind].delete(
      reconciliation.requestGeneration
    );
    this.prunePendingAttentionMutationMetadata(reconciliation.kind);
  }

  private applyPendingAttentionSnapshot(
    kind: PendingAttentionKind,
    requests: readonly unknown[],
    startedAtRevision: number,
    workspacePath?: string
  ): void {
    const snapshots = requests
      .map((value) => {
        const props = asRecord(asRecord(value)?.info) || asRecord(value);
        if (!props) return undefined;
        const id = getBlockingRequestID(props);
        const sessionID = getString(props.sessionID);
        return id && sessionID ? { id, sessionID, props } : undefined;
      })
      .filter(
        (item): item is { id: string; sessionID: string; props: Record<string, unknown> } =>
          item !== undefined
      );
    const snapshotIDs = new Set(snapshots.map((item) => item.id));
    let changed = false;

    for (const [id, request] of this.pendingAttention) {
      if (request.kind !== kind || snapshotIDs.has(id)) continue;
      if (
        workspacePath &&
        this.getSessionWorkspaceMatch(request.sessionID, workspacePath) !== true
      ) {
        continue;
      }
      if ((this.pendingAttentionMutationRevisions[kind].get(id) ?? 0) > startedAtRevision) {
        continue;
      }
      this.blockingRequestMutations.add(id);
      this.clearDeferredPermissionAttention(id);
      this.pendingAttention.delete(id);
      changed = true;
    }

    for (const snapshot of snapshots) {
      if (
        (this.pendingAttentionMutationRevisions[kind].get(snapshot.id) ?? 0) > startedAtRevision ||
        (this.pendingAttentionSessionDeletionRevisions[kind].get(snapshot.sessionID) ?? 0) >
          startedAtRevision
      ) {
        continue;
      }
      if (this.pendingAttention.has(snapshot.id)) continue;
      changed =
        this.trackBlockingRequest(
          kind,
          snapshot.props,
          kind === 'permission' ? 'permission.asked' : undefined,
          false
        ) || changed;
    }

    if (changed) {
      this.listener.onStatusChange();
      void this.persist();
    }
  }

  private enqueuePersistence<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.persistenceQueue.then(operation);
    this.persistenceQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private mergeBlockingRequests(snapshots: BlockingRequestSnapshot[]): void {
    for (const item of snapshots) {
      if (
        this.recoveryDeletedSessionIDs.has(item.sessionID) ||
        this.pendingAttention.has(item.id) ||
        this.blockingRequestMutations.has(item.id)
      )
        continue;
      const pending: PendingAttentionEntry = {
        sessionID: item.sessionID,
        kind: item.kind,
        label:
          item.kind === 'question'
            ? describeQuestionRequest(item.props)
            : describePermissionRequest(item.props),
        props: item.props,
        directory: trimOptionalString(item.directory),
      };
      if (item.eventType) pending.eventType = item.eventType;
      this.pendingAttention.set(item.id, pending);
      if (item.kind === 'permission') this.deferPermissionAttention(item.id);
      const directory = trimOptionalString(item.directory);
      if (directory) {
        this.setSessionMetadata(this.sessionDirectories, item.sessionID, directory);
      }
    }
  }

  replayBlockingRequests(
    post: (message: ExtensionMessage) => void,
    hiddenSessionIds: ReadonlySet<string>,
    options?: {
      previousRequests?: BlockingRequestSnapshot[];
      clearResolvedEmbedded?: boolean;
      workspacePath?: string | null;
    }
  ) {
    const currentRequests = [...this.pendingAttention.entries()]
      .map(([id, request]) => ({
        id,
        sessionID: request.sessionID,
        kind: request.kind,
        props: request.props,
        eventType: request.eventType,
      }))
      .filter(
        (item) =>
          !hiddenSessionIds.has(item.sessionID) &&
          this.isSessionInWorkspace(item.sessionID, options?.workspacePath)
      );
    const currentRequestIds = new Set(currentRequests.map((item) => item.id));

    if (options?.clearResolvedEmbedded) {
      for (const item of options.previousRequests || []) {
        if (hiddenSessionIds.has(item.sessionID) || currentRequestIds.has(item.id)) continue;
        if (item.kind === 'question') {
          post({
            type: 'server/event',
            payload: {
              type: 'question.replied',
              properties: {
                id: item.id,
                requestID: item.id,
                sessionID: item.sessionID,
              },
            },
          });
          continue;
        }

        post(
          item.eventType === 'permission.v2.asked'
            ? {
                type: 'server/event',
                payload: {
                  type: 'permission.v2.replied',
                  properties: {
                    requestID: item.id,
                    sessionID: item.sessionID,
                    reply: null,
                  },
                },
              }
            : {
                type: 'server/event',
                payload: {
                  type: 'permission.replied',
                  properties: {
                    id: item.id,
                    permissionID: item.id,
                    requestID: item.id,
                    sessionID: item.sessionID,
                  },
                },
              }
        );
      }
    }

    for (const item of currentRequests) {
      if (item.kind === 'question') {
        post({
          type: 'server/event',
          payload: {
            type: 'question.asked',
            properties: item.props as QuestionRequest,
          },
        });
        continue;
      }

      post(
        item.eventType === 'permission.v2.asked'
          ? {
              type: 'server/event',
              payload: {
                type: 'permission.v2.asked',
                properties: item.props as PermissionV2AskedProperties,
              },
            }
          : {
              type: 'server/event',
              payload: {
                type: 'permission.asked',
                properties: item.props as PermissionEventProperties,
              },
            }
      );
    }
  }

  describeSessionSuffix(sessionID: string): string {
    const title = this.getSessionMetadata(this.sessionTitles, sessionID)?.trim();
    return title ? ` for "${title}"` : '';
  }

  private getInterruptedSessionSnapshots(): InterruptedSessionSnapshot[] {
    const snapshots = new Map(this.unclaimedInterruptedSessions);
    for (const id of this.busySessions) {
      if (this.isIgnoredBackgroundSession(id)) continue;
      snapshots.set(id, {
        id,
        title: trimOptionalString(
          this.getSessionMetadata(this.sessionTitles, id)?.trim() || undefined
        ),
      });
    }
    return [...snapshots.values()]
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .slice(0, MAX_PERSISTED_INTERRUPTED_SESSIONS)
      .map((session) => ({ ...session }));
  }

  private getBlockingRequestSnapshots(): BlockingRequestSnapshot[] {
    return [...this.pendingAttention.entries()]
      .map(([id, request]) => {
        const snapshot: BlockingRequestSnapshot = {
          id,
          sessionID: request.sessionID,
          kind: request.kind,
          props: this.serializeBlockingRequestProps(request.kind, request.props),
          directory: trimOptionalString(
            request.directory || this.getSessionMetadata(this.sessionDirectories, request.sessionID)
          ),
        };
        if (request.eventType) snapshot.eventType = request.eventType;
        return snapshot;
      })
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .slice(0, MAX_PERSISTED_BLOCKING_REQUESTS);
  }

  private getLiveBlockingRequestSnapshots(): BlockingRequestSnapshot[] {
    return [...this.pendingAttention.entries()]
      .map(([id, request]) => {
        const snapshot: BlockingRequestSnapshot = {
          id,
          sessionID: request.sessionID,
          kind: request.kind,
          props: this.serializeBlockingRequestProps(request.kind, request.props),
          directory: trimOptionalString(
            request.directory || this.getSessionMetadata(this.sessionDirectories, request.sessionID)
          ),
        };
        if (request.eventType) snapshot.eventType = request.eventType;
        return snapshot;
      })
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .slice(0, MAX_PERSISTED_BLOCKING_REQUESTS);
  }

  private serializeBlockingRequestProps(
    kind: PendingAttentionKind,
    props: Record<string, unknown>
  ): Record<string, unknown> {
    return kind === 'permission'
      ? serializePermissionRequestProps(props)
      : serializeQuestionRequestProps(props);
  }

  private rememberSessionMetadata(
    info: Record<string, unknown> | undefined,
    fallbackSessionID?: string
  ) {
    const sessionID = getString(info?.id) || fallbackSessionID;
    if (sessionID) this.touchSessionMetadata(sessionID);
    const title = normalizeSessionTitle(getString(info?.title));
    if (sessionID && title) {
      this.setSessionMetadata(this.sessionTitles, sessionID, title);
    }

    const directory = trimOptionalString(getString(info?.directory));
    if (sessionID && directory) {
      this.setSessionMetadata(this.sessionDirectories, sessionID, directory);
    }

    const parentID = getString(info?.parentID);
    if (sessionID && parentID) {
      this.setSessionMetadata(this.sessionParentIDs, sessionID, parentID);
    }
  }

  private getSessionMetadata(map: Map<string, string>, sessionID: string) {
    const value = map.get(sessionID);
    if (value === undefined) return undefined;
    map.delete(sessionID);
    map.set(sessionID, value);
    return value;
  }

  private touchSessionMetadata(sessionID: string) {
    this.getSessionMetadata(this.sessionAgents, sessionID);
    this.getSessionMetadata(this.sessionTitles, sessionID);
    this.getSessionMetadata(this.sessionDirectories, sessionID);
    this.getSessionMetadata(this.sessionParentIDs, sessionID);
    this.getSessionMetadata(this.sessionModes, sessionID);
  }

  private setSessionMetadata(map: Map<string, string>, sessionID: string, value: string) {
    map.delete(sessionID);
    map.set(sessionID, value);
    this.evictOldestSessionMetadata(map);
  }

  private evictOldestSessionMetadata(map: Map<string, string>) {
    while (map.size > MAX_SESSION_METADATA_ENTRIES) {
      let evicted = false;
      for (const sessionID of map.keys()) {
        if (this.isPinnedSessionMetadata(sessionID)) continue;
        map.delete(sessionID);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  private isPinnedSessionMetadata(sessionID: string) {
    return this.busySessions.has(sessionID) || this.hasPendingAttentionForSession(sessionID);
  }

  private trackBlockingRequest(
    kind: PendingAttentionKind,
    props: Record<string, unknown>,
    eventType?: PermissionAskEventType,
    recordEventMutation = true
  ): boolean {
    const requestID = getBlockingRequestID(props);
    const sessionID = getString(props.sessionID);
    if (!requestID || !sessionID) return false;
    if (recordEventMutation) this.recordBlockingRequestMutation(kind, requestID);
    else this.blockingRequestMutations.add(requestID);
    if (this.pendingAttention.has(requestID)) return false;

    const label =
      kind === 'question' ? describeQuestionRequest(props) : describePermissionRequest(props);
    this.clearBusy(sessionID);
    this.trailingBusyAfterCompletion.delete(sessionID);
    const pending: PendingAttentionEntry = {
      sessionID,
      kind,
      label,
      props: { ...props },
      directory: this.getSessionMetadata(this.sessionDirectories, sessionID),
    };
    if (eventType) pending.eventType = eventType;
    this.pendingAttention.set(requestID, pending);
    this.completedSessions.delete(sessionID);
    if (kind === 'permission') this.deferPermissionAttention(requestID);
    else this.showBlockingNotification(kind, sessionID, label);
    return true;
  }

  private removeSession(sessionID: string) {
    this.recordPendingAttentionSessionDeletion(sessionID);
    if (this.recoverySnapshotPromise || this.blockingRecoveryCleanupPending) {
      this.recoveryDeletedSessionIDs.add(sessionID);
    }
    let changed = false;
    changed = this.busySessions.delete(sessionID) || changed;
    changed = this.completedSessions.delete(sessionID) || changed;
    changed = this.failedSessions.delete(sessionID) || changed;
    changed = this.sessionAgents.delete(sessionID) || changed;
    changed = this.sessionTitles.delete(sessionID) || changed;
    changed = this.sessionDirectories.delete(sessionID) || changed;
    changed = this.sessionParentIDs.delete(sessionID) || changed;
    changed = this.sessionModes.delete(sessionID) || changed;
    changed = this.unclaimedInterruptedSessions.delete(sessionID) || changed;
    this.busyStartedAt.delete(sessionID);
    this.trailingBusyAfterCompletion.delete(sessionID);
    this.clearBusyAttempts(sessionID);
    for (const [requestID, request] of this.pendingAttention.entries()) {
      if (request.sessionID !== sessionID) continue;
      this.recordBlockingRequestMutation(request.kind, requestID);
      this.clearDeferredPermissionAttention(requestID);
      this.pendingAttention.delete(requestID);
      changed = true;
    }
    return changed;
  }

  private clearBlockingRequest(kind: PendingAttentionKind, requestID: string | undefined): boolean {
    if (!requestID) return false;
    this.recordBlockingRequestMutation(kind, requestID);
    this.clearDeferredPermissionAttention(requestID);
    return this.pendingAttention.delete(requestID);
  }

  private deferPermissionAttention(requestID: string): void {
    if (this.deferredPermissionAttention.has(requestID)) return;
    const timer = setTimeout(() => this.revealPermission(requestID), AUTO_APPROVE_JUDGE_TIMEOUT_MS);
    this.deferredPermissionAttention.set(requestID, timer);
  }

  private clearDeferredPermissionAttention(requestID: string): void {
    const timer = this.deferredPermissionAttention.get(requestID);
    if (timer) clearTimeout(timer);
    this.deferredPermissionAttention.delete(requestID);
  }

  private recordBlockingRequestMutation(kind: PendingAttentionKind, requestID: string): void {
    const revision = this.pendingAttentionRevisions[kind] + 1;
    this.pendingAttentionRevisions[kind] = revision;
    this.pendingAttentionMutationRevisions[kind].set(requestID, revision);
    this.blockingRequestMutations.add(requestID);
    this.prunePendingAttentionMutationMetadata(kind);
  }

  private recordPendingAttentionSessionDeletion(sessionID: string): void {
    for (const kind of ['permission', 'question'] as const) {
      const revision = this.pendingAttentionRevisions[kind] + 1;
      this.pendingAttentionRevisions[kind] = revision;
      this.pendingAttentionSessionDeletionRevisions[kind].set(sessionID, revision);
      this.prunePendingAttentionMutationMetadata(kind);
    }
  }

  private prunePendingAttentionMutationMetadata(kind: PendingAttentionKind): void {
    const activeRevisions = this.activePendingAttentionReconciliations[kind].values();
    let oldestActiveRevision = Number.POSITIVE_INFINITY;
    for (const revision of activeRevisions) {
      oldestActiveRevision = Math.min(oldestActiveRevision, revision);
    }
    if (!Number.isFinite(oldestActiveRevision)) {
      this.pendingAttentionMutationRevisions[kind].clear();
      this.pendingAttentionSessionDeletionRevisions[kind].clear();
      return;
    }
    for (const [requestID, revision] of this.pendingAttentionMutationRevisions[kind]) {
      if (revision <= oldestActiveRevision) {
        this.pendingAttentionMutationRevisions[kind].delete(requestID);
      }
    }
    for (const [sessionID, revision] of this.pendingAttentionSessionDeletionRevisions[kind]) {
      if (revision <= oldestActiveRevision) {
        this.pendingAttentionSessionDeletionRevisions[kind].delete(sessionID);
      }
    }
  }

  private hasPendingAttentionForSession(sessionID: string): boolean {
    for (const request of this.pendingAttention.values()) {
      if (request.sessionID === sessionID) return true;
    }
    return false;
  }

  private clearBusy(sessionID: string): boolean {
    const wasBusy = this.busySessions.delete(sessionID);
    this.clearBusyAttempts(sessionID);
    if (wasBusy) this.busyStartedAt.delete(sessionID);
    return wasBusy;
  }

  private clearBusyAttempts(sessionID: string): void {
    this.busyAttempts.delete(sessionID);
    for (const [attemptID, deferred] of this.deferredPromptFailures) {
      if (deferred.attempt.sessionID === sessionID) {
        this.deferredPromptFailures.delete(attemptID);
      }
    }
  }

  private markBusyInternal(sessionID: string): boolean {
    let changed = !this.busySessions.has(sessionID);
    if (!this.busySessions.has(sessionID)) {
      this.busyStartedAt.set(sessionID, Date.now());
    }
    this.busySessions.add(sessionID);
    changed = this.completedSessions.delete(sessionID) || changed;
    changed = this.failedSessions.delete(sessionID) || changed;
    return changed;
  }

  private finishBusySession(sessionID: string, completedAt: number | undefined): boolean {
    if (!this.busySessions.has(sessionID)) return false;

    if (
      this.isIgnoredBackgroundSession(sessionID) ||
      this.hasPendingAttentionForSession(sessionID) ||
      this.failedSessions.has(sessionID)
    ) {
      return this.clearBusy(sessionID);
    }

    if (this.isStaleCompletion(completedAt, this.busyStartedAt.get(sessionID))) return false;

    this.clearBusy(sessionID);
    this.completedSessions.add(sessionID);
    this.trailingBusyAfterCompletion.add(sessionID);
    this.showCompletionNotification(sessionID);
    return true;
  }

  private isIgnoredBackgroundSession(sessionID: string): boolean {
    return (
      this.getSessionMetadata(this.sessionParentIDs, sessionID) !== undefined ||
      this.getSessionMetadata(this.sessionModes, sessionID) === 'subagent' ||
      isSubagentSessionTitle(this.getSessionMetadata(this.sessionTitles, sessionID))
    );
  }

  private isStaleCompletion(
    completedAt: number | undefined,
    startedAt: number | undefined
  ): boolean {
    if (completedAt === undefined || completedAt < MIN_EPOCH_MILLIS) return false;
    return (
      startedAt !== undefined && completedAt + COMPLETION_NOTIFICATION_CLOCK_SKEW_MS < startedAt
    );
  }

  /**
   * Compares locally-tracked busy sessions against server-authoritative status
   * (REST `/session/status`). Returns IDs of sessions the server has reported
   * idle for at least `graceMs` while we still track them as busy - strong
   * evidence the completion event was lost (e.g. during an SSE reconnect or
   * while the webview was hidden, where the webview-side watchdog cannot run).
   * Clears those sessions locally (mirroring the normal completion path) so
   * the caller can post synthetic idle events to recover the UI.
   *
   * The grace requirement protects against transient idle gaps between
   * agentic steps: a session that briefly reports idle before the next step
   * starts must remain busy. Only a sustained disagreement is reconciled.
   */
  reconcileStaleBusySessions(
    serverStatuses: Record<string, unknown>,
    graceMs: number,
    now: number = Date.now()
  ): string[] {
    for (const deferred of this.deferredPromptFailures.values()) {
      const { attempt } = deferred;
      const serverStatus = serverStatuses[attempt.sessionID];
      const statusType = getString(asRecord(serverStatus)?.type);
      if (
        serverStatus === undefined ||
        statusType === 'idle' ||
        statusType === 'busy' ||
        statusType === 'retry'
      ) {
        this.reconcilePromptFailure(attempt, serverStatus);
      } else if (deferred.remainingReconciliations <= 1) {
        this.reconcilePromptFailure(attempt, undefined);
      } else {
        deferred.remainingReconciliations -= 1;
      }
    }
    if (this.busySessions.size === 0) {
      this.reconcileIdleSince.clear();
      return [];
    }
    const stale: string[] = [];
    for (const sessionID of this.busySessions) {
      if (this.hasPendingAttentionForSession(sessionID)) continue;
      const entry =
        serverStatuses[sessionID] && typeof serverStatuses[sessionID] === 'object'
          ? (serverStatuses[sessionID] as Record<string, unknown>)
          : null;
      const serverType = typeof entry?.type === 'string' ? entry.type : undefined;
      if (serverType === 'busy' || serverType === 'retry') {
        this.reconcileIdleSince.delete(sessionID);
        continue;
      }
      const since = this.reconcileIdleSince.get(sessionID);
      if (since === undefined) {
        this.reconcileIdleSince.set(sessionID, now);
        continue;
      }
      if (now - since < graceMs) continue;
      this.reconcileIdleSince.delete(sessionID);
      if (this.finishBusySession(sessionID, undefined)) {
        stale.push(sessionID);
      }
    }
    for (const id of this.reconcileIdleSince.keys()) {
      if (!this.busySessions.has(id)) this.reconcileIdleSince.delete(id);
    }
    if (stale.length > 0) {
      this.listener.onStatusChange();
      void this.persist();
    }
    return stale;
  }

  private markSessionFailed(
    sessionID: string,
    error: Record<string, unknown> | undefined
  ): boolean {
    if (error && isAbortedErrorRecord(error)) return this.failedSessions.delete(sessionID);

    const wasFailed = this.failedSessions.has(sessionID);
    this.failedSessions.add(sessionID);
    this.completedSessions.delete(sessionID);
    if (!wasFailed && !this.isIgnoredBackgroundSession(sessionID)) {
      this.showFailureNotification(sessionID, error ? describeFailure(error) : undefined);
    }
    return !wasFailed;
  }

  private clearAbortedSession(sessionID: string): boolean {
    let changed = this.clearBusy(sessionID);
    changed = this.failedSessions.delete(sessionID) || changed;
    changed = this.completedSessions.delete(sessionID) || changed;
    return changed;
  }

  private showBlockingNotification(
    kind: PendingAttentionKind,
    sessionID: string,
    _label: string
  ): void {
    if (!this.notificationGate.shouldShow(sessionID)) return;

    const prefix =
      kind === 'question' ? 'Varro is waiting for your input' : 'Varro needs permission approval';
    const message = `${prefix}${this.describeSessionSuffix(sessionID)}.`;

    void vscode.window.showWarningMessage(message, 'Open Chat').then((action) => {
      if (action === 'Open Chat') {
        void vscode.commands.executeCommand('varro.chat.focus');
      }
    });
  }

  private showCompletionNotification(sessionID: string): void {
    if (!this.isPlanSession(sessionID)) return;
    if (!this.notificationGate.shouldShow(sessionID)) return;

    const message = `Varro has a plan ready for review${this.describeSessionSuffix(sessionID)}.`;
    void vscode.window.showInformationMessage(message, 'Open Chat').then((action) => {
      if (action === 'Open Chat') {
        void vscode.commands.executeCommand('varro.chat.focus');
      }
    });
  }

  private showFailureNotification(sessionID: string, detail: string | undefined): void {
    if (!this.notificationGate.shouldShow(sessionID)) return;

    const suffix = this.describeSessionSuffix(sessionID);
    const message = detail?.trim()
      ? `Varro hit an error${suffix}: ${detail.trim()}`
      : `Varro hit an error${suffix}.`;
    void vscode.window.showErrorMessage(message, 'Open Chat').then((action) => {
      if (action === 'Open Chat') {
        void vscode.commands.executeCommand('varro.chat.focus');
      }
    });
  }
}

export function describeQuestionRequest(props: Record<string, unknown>): string {
  const questions = Array.isArray(props.questions) ? props.questions : [];
  const firstQuestion = asRecord(questions[0]);
  return (
    getString(firstQuestion?.header) || getString(firstQuestion?.question) || 'User input required'
  );
}

export function describePermissionRequest(props: Record<string, unknown>): string {
  const title = getString(props.title)?.trim();
  if (title) return title;

  const permission = getString(props.permission);
  const patterns = Array.isArray(props.patterns)
    ? props.patterns.map((item) => getString(item)).filter((item): item is string => Boolean(item))
    : [];
  return (
    [permission, patterns.join(', ')].filter(Boolean).join(' ').trim() || 'Permission required'
  );
}

function describeFailure(error: Record<string, unknown>): string | undefined {
  const detail = asRecord(error.data);
  return getString(detail?.message) || friendlyErrorName(getString(error.name)) || undefined;
}

function isAbortedErrorRecord(error: Record<string, unknown>): boolean {
  const data = asRecord(error.data);
  return isAbortedAssistantError({
    name: getString(error.name) || '',
    data: data ? { message: getString(data.message) } : undefined,
  });
}

function isContinuationFinish(value: string | undefined): boolean {
  const finish = value?.toLowerCase().replace(/[\s-]+/g, '_');
  return (
    finish === 'tool' ||
    finish === 'tools' ||
    finish === 'tool_call' ||
    finish === 'tool_calls' ||
    finish === 'tool_use' ||
    finish === 'tool_uses' ||
    finish === 'function_call' ||
    finish === 'function_calls'
  );
}

function isSubagentSessionTitle(title: string | undefined): boolean {
  return !!title?.trim().match(/\(@[^)]*\bsubagent\)$/i);
}

function validateInterruptedSessionSnapshots(value: unknown): InterruptedSessionSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is InterruptedSessionSnapshot =>
      typeof item?.id === 'string' &&
      item.id.trim().length > 0 &&
      !isSubagentSessionTitle(item.title)
  );
}

function validateBlockingRequestSnapshots(value: unknown): BlockingRequestSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is BlockingRequestSnapshot =>
        typeof item?.id === 'string' &&
        item.id.trim().length > 0 &&
        typeof item?.sessionID === 'string' &&
        item.sessionID.trim().length > 0 &&
        (item.kind === 'permission' || item.kind === 'question') &&
        !!item.props &&
        typeof item.props === 'object' &&
        (item.eventType === undefined ||
          item.eventType === 'permission.asked' ||
          item.eventType === 'permission.v2.asked')
    )
    .slice(0, MAX_PERSISTED_BLOCKING_REQUESTS);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getBlockingRequestID(props: Record<string, unknown>): string | undefined {
  return getString(props.id) || getString(props.permissionID) || getString(props.requestID);
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function trimOptionalString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.length > MAX_PERSISTED_STRING_LENGTH
    ? value.slice(0, MAX_PERSISTED_STRING_LENGTH)
    : value;
}

function trimRequiredString(value: string, fallback = ''): string {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return trimmed.length > MAX_PERSISTED_STRING_LENGTH
    ? trimmed.slice(0, MAX_PERSISTED_STRING_LENGTH)
    : trimmed;
}

function serializePermissionRequestProps(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: getString(props.id) || getString(props.permissionID) || getString(props.requestID) || '',
    sessionID: getString(props.sessionID) || '',
  };

  const permission = trimOptionalString(getString(props.permission));
  if (permission) result.permission = permission;

  const type = trimOptionalString(getString(props.type));
  if (type) result.type = type;

  const title = trimOptionalString(getString(props.title));
  if (title) result.title = title;

  const patterns = Array.isArray(props.patterns)
    ? props.patterns
        .map((item) => getString(item))
        .filter((item): item is string => Boolean(item))
        .slice(0, MAX_PERSISTED_METADATA_ENTRIES)
        .map((item) => trimRequiredString(item))
    : typeof props.patterns === 'string'
      ? [trimRequiredString(props.patterns)]
      : [];
  if (patterns.length > 0) result.patterns = patterns;

  const pattern = serializePersistedStringOrArray(props.pattern);
  if (pattern !== undefined) result.pattern = pattern;

  const action = trimOptionalString(getString(props.action));
  if (action) result.action = action;

  const resources = serializePersistedStringArray(props.resources);
  if (resources.length > 0) result.resources = resources;

  const save = serializePersistedStringArray(props.save);
  if (save.length > 0) result.save = save;

  const messageID =
    getString(props.messageID) || getString(asRecord(props.tool)?.messageID) || undefined;
  const callID = getString(props.callID) || getString(asRecord(props.tool)?.callID) || undefined;
  if (messageID || callID) {
    const tool: { messageID?: string; callID?: string } = {};
    if (messageID) tool.messageID = trimRequiredString(messageID);
    if (callID) tool.callID = trimRequiredString(callID);
    result.tool = tool;
  }

  const source = asRecord(props.source);
  const sourceMessageID = trimOptionalString(getString(source?.messageID));
  const sourceCallID = trimOptionalString(getString(source?.callID));
  if (source?.type === 'tool' && sourceMessageID && sourceCallID) {
    result.source = { type: 'tool', messageID: sourceMessageID, callID: sourceCallID };
  }

  const metadata = asRecord(props.metadata);
  if (metadata) {
    const persistedMetadataEntries = Object.entries(metadata)
      .filter((entry): entry is [string, string | number | boolean] =>
        isPersistableMetadataValue(entry[1])
      )
      .slice(0, MAX_PERSISTED_METADATA_ENTRIES)
      .map(([key, value]) => [trimRequiredString(key), trimMetadataValue(value)] as const);
    if (persistedMetadataEntries.length > 0) {
      result.metadata = Object.fromEntries(persistedMetadataEntries);
    }
  }

  return result;
}

function serializePersistedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => getString(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, MAX_PERSISTED_METADATA_ENTRIES)
    .map((item) => trimRequiredString(item));
}

function serializePersistedStringOrArray(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return trimRequiredString(value);
  const items = serializePersistedStringArray(value);
  return items.length > 0 ? items : undefined;
}

function serializeQuestionRequestProps(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: getString(props.id) || '',
    sessionID: getString(props.sessionID) || '',
  };

  const questions = Array.isArray(props.questions)
    ? props.questions
        .map((item) => serializeQuestionDefinition(asRecord(item) ?? undefined))
        .filter((item): item is NonNullable<typeof item> => item !== null)
    : [];
  if (Array.isArray(props.questions)) {
    result.questions = questions;
  }

  const tool = asRecord(props.tool);
  const messageID = getString(tool?.messageID);
  const callID = getString(tool?.callID);
  if (messageID && callID) {
    result.tool = {
      messageID: trimRequiredString(messageID),
      callID: trimRequiredString(callID),
    };
  }

  return result;
}

function serializeQuestionDefinition(question: Record<string, unknown> | undefined) {
  if (!question) return null;
  const prompt = trimOptionalString(getString(question.question));
  const header = trimOptionalString(getString(question.header));
  const options = Array.isArray(question.options)
    ? question.options
        .map((item) => serializeQuestionOption(asRecord(item) ?? undefined))
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, MAX_PERSISTED_METADATA_ENTRIES)
    : [];

  if (!prompt && !header && options.length === 0) return null;
  const definition: PersistedQuestionDefinition = { options };
  if (prompt) definition.question = prompt;
  if (header) definition.header = header;
  if (typeof question.multiple === 'boolean') definition.multiple = question.multiple;
  if (typeof question.custom === 'boolean') definition.custom = question.custom;
  return definition;
}

function serializeQuestionOption(option: Record<string, unknown> | undefined) {
  if (!option) return null;
  const label = trimOptionalString(getString(option.label));
  if (!label) return null;
  const description = trimOptionalString(getString(option.description));
  const result: PersistedQuestionOption = { label };
  if (description) result.description = description;
  return result;
}

function isPersistableMetadataValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function trimMetadataValue(value: string | number | boolean): string | number | boolean {
  return typeof value === 'string' ? trimRequiredString(value) : value;
}
