import * as vscode from 'vscode';
import type { Persistence } from '../shared/persistence';
import type { ExtensionMessage, ServerEvent } from '../shared/protocol';
import type { PermissionEventProperties, QuestionRequest } from '../shared/opencode-types';
import { normalizeSessionTitle } from '../shared/session-title';
import { logger } from './logger';
import { friendlyErrorName, isAbortedAssistantError } from '../webview/lib/aborted';

export type PendingAttentionKind = 'permission' | 'question';

export type PendingAttentionEntry = {
  sessionID: string;
  kind: PendingAttentionKind;
  label: string;
  props: Record<string, unknown>;
  directory?: string;
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
};

export interface SessionStateListener {
  /** Called whenever any state that the status bar renders has changed. */
  onStatusChange(): void;
}

export interface NotificationGate {
  /** Whether a user-facing toast should be shown right now. */
  shouldShow(): boolean;
}

const INTERRUPTED_SESSIONS_KEY = 'varro.interruptedSessions';
const BLOCKING_REQUESTS_KEY = 'varro.blockingRequests';
const MAX_PERSISTED_INTERRUPTED_SESSIONS = 50;
const MAX_PERSISTED_BLOCKING_REQUESTS = 100;
const MAX_PERSISTED_METADATA_ENTRIES = 20;
const MAX_PERSISTED_STRING_LENGTH = 500;
const MAX_SESSION_METADATA_ENTRIES = 200;
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
  private readonly reconcileIdleSince = new Map<string, number>();

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

  get pending(): ReadonlyMap<string, PendingAttentionEntry> {
    return this.pendingAttention;
  }

  titleFor(sessionID: string): string | undefined {
    return this.sessionTitles.get(sessionID);
  }

  isPlanSession(sessionID: string): boolean {
    return this.sessionAgents.get(sessionID) === 'plan';
  }

  isSessionInWorkspace(sessionID: string, workspacePath: string | null | undefined): boolean {
    const normalizedWorkspace = normalizeWorkspacePath(workspacePath);
    if (!normalizedWorkspace) return true;
    const normalizedDirectory = normalizeWorkspacePath(this.sessionDirectories.get(sessionID));
    return normalizedDirectory === normalizedWorkspace;
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

  /**
   * Optimistically marks a session busy the moment a prompt is forwarded to
   * the server. opencode admits a prompt and only later emits the SSE
   * `session.status { busy }` event; on fast turns the finish (idle /
   * step.ended) can arrive before that busy event, leaving the session
   * untracked so `finishBusySession` drops the completion. Pre-marking here
   * guarantees the busy marker is in place before any finish event lands,
   * eliminating the missed-finish race for ping-style turns.
   */
  markSessionBusy(sessionID: string): void {
    if (!sessionID) return;
    this.markBusyInternal(sessionID);
    this.listener.onStatusChange();
    void this.persist();
  }

  handleServerEvent(event: ServerEvent): void {
    const { type, properties: props } = event;
    let changed = false;

    switch (type) {
      case 'session.created':
      case 'session.updated': {
        this.rememberSessionMetadata(asRecord(props?.info), getString(props?.sessionID));
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
        if (statusType === 'busy' || statusType === 'retry') {
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
        if (!sessionID || !props || isContinuationStepEnd(props)) break;
        changed = this.finishBusySession(sessionID, getNumber(props.timestamp)) || changed;
        break;
      }
      case 'session.error': {
        const sessionID = getString(props?.sessionID);
        if (!sessionID) break;
        changed = this.markSessionFailed(sessionID, asRecord(props?.error)) || changed;
        break;
      }
      case 'message.updated': {
        const info = asRecord(props?.info);
        const sessionID = getString(info?.sessionID);
        if (!sessionID) break;

        const agent = getString(info?.agent);
        if (agent) {
          this.sessionAgents.set(sessionID, agent);
          this.evictOldestSessionMetadata(this.sessionAgents);
        }

        const mode = getString(info?.mode);
        if (mode) {
          this.sessionModes.set(sessionID, mode);
          this.evictOldestSessionMetadata(this.sessionModes);
        }

        if (getString(info?.role) !== 'assistant') break;

        const error = asRecord(info?.error);
        if (error) {
          changed = this.markSessionFailed(sessionID, error) || changed;
        } else {
          changed = this.failedSessions.delete(sessionID) || changed;
        }
        if (error || typeof asRecord(info?.time)?.completed === 'number') {
          if (error) {
            changed = this.clearBusy(sessionID) || changed;
          } else {
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
          (requestProps ? this.trackBlockingRequest('permission', requestProps) : false) || changed;
        break;
      }
      case 'permission.replied':
      case 'permission.v2.replied': {
        const propsRecord = asRecord(props);
        const requestProps = asRecord(propsRecord?.info) || propsRecord;
        changed =
          this.clearBlockingRequest(
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
          this.clearBlockingRequest(getString(props?.requestID) || getString(props?.id)) || changed;
        break;
      }
    }

    if (changed) {
      this.listener.onStatusChange();
      void this.persist();
    }
  }

  async persist(): Promise<void> {
    const results = await Promise.allSettled([
      this.persistInterruptedSessions(),
      this.persistBlockingRequests(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn(
          `Failed to persist session state: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
    }
  }

  async consumeInterruptedSessions(): Promise<InterruptedSessionSnapshot[]> {
    const snapshots =
      this.persistence.get<InterruptedSessionSnapshot[]>(INTERRUPTED_SESSIONS_KEY) || [];
    await this.persistence.remove(INTERRUPTED_SESSIONS_KEY);
    return snapshots.filter(
      (item) =>
        typeof item?.id === 'string' &&
        item.id.trim().length > 0 &&
        !isSubagentSessionTitle(item.title)
    );
  }

  async consumeBlockingRequests(): Promise<BlockingRequestSnapshot[]> {
    const snapshots = this.persistence.get<BlockingRequestSnapshot[]>(BLOCKING_REQUESTS_KEY) || [];
    await this.persistence.remove(BLOCKING_REQUESTS_KEY);
    return snapshots.filter(
      (item) =>
        typeof item?.id === 'string' &&
        item.id.trim().length > 0 &&
        typeof item?.sessionID === 'string' &&
        item.sessionID.trim().length > 0 &&
        (item.kind === 'permission' || item.kind === 'question') &&
        item.props &&
        typeof item.props === 'object'
    );
  }

  /**
   * Reinstate pending-attention entries from a previous session (after
   * webview reload). Does not emit notifications - those were already
   * shown in the prior run.
   */
  restoreBlockingRequests(snapshots: BlockingRequestSnapshot[]): void {
    this.pendingAttention.clear();
    for (const item of snapshots) {
      this.pendingAttention.set(item.id, {
        sessionID: item.sessionID,
        kind: item.kind,
        label:
          item.kind === 'question'
            ? describeQuestionRequest(item.props)
            : describePermissionRequest(item.props),
        props: item.props,
        directory: trimOptionalString(item.directory),
      });
      const directory = trimOptionalString(item.directory);
      if (directory) {
        this.sessionDirectories.set(item.sessionID, directory);
        this.evictOldestSessionMetadata(this.sessionDirectories);
      }
    }
  }

  replayBlockingRequests(
    post: (message: ExtensionMessage) => void,
    hiddenSessionIds: ReadonlySet<string>,
    options?: {
      previousRequests?: BlockingRequestSnapshot[];
      clearResolvedEmbedded?: boolean;
    }
  ) {
    const currentRequests = [...this.pendingAttention.entries()]
      .map(([id, request]) => ({
        id,
        sessionID: request.sessionID,
        kind: request.kind,
        props: request.props,
      }))
      .filter((item) => !hiddenSessionIds.has(item.sessionID));
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

        post({
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
        });
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

      post({
        type: 'server/event',
        payload: {
          type: 'permission.asked',
          properties: item.props as PermissionEventProperties,
        },
      });
    }
  }

  describeSessionSuffix(sessionID: string): string {
    const title = this.sessionTitles.get(sessionID)?.trim();
    return title ? ` for "${title}"` : '';
  }

  private async persistInterruptedSessions() {
    const snapshots = [...this.busySessions]
      .filter((id) => !this.isIgnoredBackgroundSession(id))
      .toSorted()
      .slice(0, MAX_PERSISTED_INTERRUPTED_SESSIONS)
      .map((id) => ({
        id,
        title: trimOptionalString(this.sessionTitles.get(id)?.trim() || undefined),
      }));
    await this.persistence.set(INTERRUPTED_SESSIONS_KEY, snapshots);
  }

  private async persistBlockingRequests() {
    const snapshots = [...this.pendingAttention.entries()]
      .map(([id, request]) => ({
        id,
        sessionID: request.sessionID,
        kind: request.kind,
        props: this.serializeBlockingRequestProps(request.kind, request.props),
        directory: trimOptionalString(
          request.directory || this.sessionDirectories.get(request.sessionID)
        ),
      }))
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .slice(0, MAX_PERSISTED_BLOCKING_REQUESTS);
    await this.persistence.set(BLOCKING_REQUESTS_KEY, snapshots);
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
    const title = normalizeSessionTitle(getString(info?.title));
    if (sessionID && title) {
      this.sessionTitles.set(sessionID, title);
      this.evictOldestSessionMetadata(this.sessionTitles);
    }

    const directory = trimOptionalString(getString(info?.directory));
    if (sessionID && directory) {
      this.sessionDirectories.set(sessionID, directory);
      this.evictOldestSessionMetadata(this.sessionDirectories);
    }

    const parentID = getString(info?.parentID);
    if (sessionID && parentID) {
      this.sessionParentIDs.set(sessionID, parentID);
      this.evictOldestSessionMetadata(this.sessionParentIDs);
    }
  }

  private evictOldestSessionMetadata(map: Map<string, string>) {
    while (map.size > MAX_SESSION_METADATA_ENTRIES) {
      const oldestKey = map.keys().next().value;
      if (!oldestKey) break;
      map.delete(oldestKey);
    }
  }

  private trackBlockingRequest(
    kind: PendingAttentionKind,
    props: Record<string, unknown>
  ): boolean {
    const requestID =
      getString(props.id) || getString(props.permissionID) || getString(props.requestID);
    const sessionID = getString(props.sessionID);
    if (!requestID || !sessionID || this.pendingAttention.has(requestID)) return false;

    const label =
      kind === 'question' ? describeQuestionRequest(props) : describePermissionRequest(props);
    this.clearBusy(sessionID);
    this.pendingAttention.set(requestID, {
      sessionID,
      kind,
      label,
      props: { ...props },
      directory: this.sessionDirectories.get(sessionID),
    });
    this.completedSessions.delete(sessionID);
    this.showBlockingNotification(kind, sessionID, label);
    return true;
  }

  private removeSession(sessionID: string) {
    let changed = false;
    changed = this.busySessions.delete(sessionID) || changed;
    changed = this.completedSessions.delete(sessionID) || changed;
    changed = this.failedSessions.delete(sessionID) || changed;
    changed = this.sessionAgents.delete(sessionID) || changed;
    changed = this.sessionTitles.delete(sessionID) || changed;
    changed = this.sessionDirectories.delete(sessionID) || changed;
    changed = this.sessionParentIDs.delete(sessionID) || changed;
    changed = this.sessionModes.delete(sessionID) || changed;
    this.busyStartedAt.delete(sessionID);
    for (const [requestID, request] of this.pendingAttention.entries()) {
      if (request.sessionID !== sessionID) continue;
      this.pendingAttention.delete(requestID);
      changed = true;
    }
    return changed;
  }

  private clearBlockingRequest(requestID: string | undefined): boolean {
    if (!requestID) return false;
    return this.pendingAttention.delete(requestID);
  }

  private hasPendingAttentionForSession(sessionID: string): boolean {
    for (const request of this.pendingAttention.values()) {
      if (request.sessionID === sessionID) return true;
    }
    return false;
  }

  private clearBusy(sessionID: string): boolean {
    const wasBusy = this.busySessions.delete(sessionID);
    if (wasBusy) this.busyStartedAt.delete(sessionID);
    return wasBusy;
  }

  private markBusyInternal(sessionID: string): boolean {
    if (!this.busySessions.has(sessionID)) {
      this.busyStartedAt.set(sessionID, Date.now());
    }
    this.busySessions.add(sessionID);
    this.completedSessions.delete(sessionID);
    this.failedSessions.delete(sessionID);
    return true;
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
    this.showCompletionNotification(sessionID);
    return true;
  }

  private isIgnoredBackgroundSession(sessionID: string): boolean {
    return (
      this.sessionParentIDs.has(sessionID) ||
      this.sessionModes.get(sessionID) === 'subagent' ||
      isSubagentSessionTitle(this.sessionTitles.get(sessionID))
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
   * idle for at least `graceMs` while we still track them as busy — strong
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

  private showBlockingNotification(
    kind: PendingAttentionKind,
    sessionID: string,
    _label: string
  ): void {
    if (!this.notificationGate.shouldShow()) return;

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
    if (!this.notificationGate.shouldShow()) return;

    const message = `Varro has a plan ready for review${this.describeSessionSuffix(sessionID)}.`;
    void vscode.window.showInformationMessage(message, 'Open Chat').then((action) => {
      if (action === 'Open Chat') {
        void vscode.commands.executeCommand('varro.chat.focus');
      }
    });
  }

  private showFailureNotification(sessionID: string, detail: string | undefined): void {
    if (!this.notificationGate.shouldShow()) return;

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

function isContinuationStepEnd(props: Record<string, unknown>): boolean {
  const finish = getString(props.finish)
    ?.toLowerCase()
    .replace(/[\s-]+/g, '_');
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

  const messageID =
    getString(props.messageID) || getString(asRecord(props.tool)?.messageID) || undefined;
  const callID = getString(props.callID) || getString(asRecord(props.tool)?.callID) || undefined;
  if (messageID || callID) {
    result.tool = {
      ...(messageID ? { messageID: trimRequiredString(messageID) } : {}),
      ...(callID ? { callID: trimRequiredString(callID) } : {}),
    };
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

function serializeQuestionRequestProps(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: getString(props.id) || '',
    sessionID: getString(props.sessionID) || '',
  };

  const questions = Array.isArray(props.questions)
    ? props.questions
        .map((item) => serializeQuestionDefinition(asRecord(item)))
        .filter((item): item is NonNullable<typeof item> => item !== null)
    : [];
  if (questions.length > 0) {
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
        .map((item) => serializeQuestionOption(asRecord(item)))
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .slice(0, MAX_PERSISTED_METADATA_ENTRIES)
    : [];

  if (!prompt && !header && options.length === 0) return null;
  return {
    ...(prompt ? { question: prompt } : {}),
    ...(header ? { header } : {}),
    ...(typeof question.multiple === 'boolean' ? { multiple: question.multiple } : {}),
    ...(typeof question.custom === 'boolean' ? { custom: question.custom } : {}),
    options,
  };
}

function serializeQuestionOption(option: Record<string, unknown> | undefined) {
  if (!option) return null;
  const label = trimOptionalString(getString(option.label));
  if (!label) return null;
  const description = trimOptionalString(getString(option.description));
  return {
    label,
    ...(description ? { description } : {}),
  };
}

function isPersistableMetadataValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function trimMetadataValue(value: string | number | boolean): string | number | boolean {
  return typeof value === 'string' ? trimRequiredString(value) : value;
}

function normalizeWorkspacePath(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}
