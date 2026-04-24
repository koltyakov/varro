import * as vscode from 'vscode';
import type { Memento } from 'vscode';
import { normalizeSessionTitle } from '../shared/session-title';
import { logger } from './logger';

export type PendingAttentionKind = 'permission' | 'question';

export type PendingAttentionEntry = {
  sessionID: string;
  kind: PendingAttentionKind;
  label: string;
  props: Record<string, unknown>;
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
};

export interface SessionStateListener {
  /** Called when pending-attention composition changes. */
  onPendingAttentionChange(sessionIds: string[]): void;
  /** Called whenever any state that the status bar renders has changed. */
  onStatusChange(): void;
}

export interface NotificationGate {
  /** Whether a user-facing toast should be shown right now. */
  shouldShow(): boolean;
}

const INTERRUPTED_SESSIONS_KEY = 'varro.interruptedSessions';
const BLOCKING_REQUESTS_KEY = 'varro.blockingRequests';

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
  private readonly pendingAttention = new Map<string, PendingAttentionEntry>();
  private lastPendingAttentionKey = '';

  constructor(
    private readonly workspaceState: Memento,
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

  clearCompleted(): void {
    if (this.completedSessions.size === 0) return;
    this.completedSessions.clear();
    this.listener.onStatusChange();
  }

  handleServerEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : undefined;
    const props = asRecord(event.properties);
    if (!type) return;
    let changed = false;

    switch (type) {
      case 'session.created':
      case 'session.updated': {
        this.rememberSessionTitle(asRecord(props?.info));
        break;
      }
      case 'session.deleted': {
        const sessionID = getString(asRecord(props?.info)?.id);
        if (!sessionID) break;
        this.busySessions.delete(sessionID);
        this.completedSessions.delete(sessionID);
        this.failedSessions.delete(sessionID);
        this.sessionAgents.delete(sessionID);
        this.sessionTitles.delete(sessionID);
        for (const [requestID, request] of this.pendingAttention.entries()) {
          if (request.sessionID === sessionID) {
            this.pendingAttention.delete(requestID);
            changed = true;
          }
        }
        changed = true;
        break;
      }
      case 'session.status': {
        const sessionID = getString(props?.sessionID);
        const statusType = getString(asRecord(props?.status)?.type);
        if (!sessionID || !statusType) break;
        if (statusType === 'busy' || statusType === 'retry') {
          this.busySessions.add(sessionID);
          this.completedSessions.delete(sessionID);
          this.failedSessions.delete(sessionID);
          changed = true;
        }
        if (statusType === 'idle') {
          this.busySessions.delete(sessionID);
          changed = true;
        }
        break;
      }
      case 'session.idle': {
        const sessionID = getString(props?.sessionID);
        if (!sessionID) break;
        const wasBusy = this.busySessions.delete(sessionID);
        if (
          wasBusy &&
          !this.hasPendingAttentionForSession(sessionID) &&
          !this.failedSessions.has(sessionID)
        ) {
          this.completedSessions.add(sessionID);
          this.showCompletionNotification(sessionID);
          changed = true;
        }
        break;
      }
      case 'message.updated': {
        const info = asRecord(props?.info);
        const sessionID = getString(info?.sessionID);
        if (!sessionID) break;

        const agent = getString(info?.agent);
        if (agent) {
          this.sessionAgents.set(sessionID, agent);
        }

        if (getString(info?.role) !== 'assistant') break;

        const error = asRecord(info?.error);
        if (error) {
          const wasFailed = this.failedSessions.has(sessionID);
          this.failedSessions.add(sessionID);
          this.completedSessions.delete(sessionID);
          if (!wasFailed) {
            this.showFailureNotification(sessionID, describeFailure(error));
          }
          changed = !wasFailed || changed;
        } else {
          changed = this.failedSessions.delete(sessionID) || changed;
        }
        break;
      }
      case 'permission.asked': {
        changed = (props ? this.trackBlockingRequest('permission', props) : false) || changed;
        break;
      }
      case 'permission.replied': {
        changed =
          this.clearBlockingRequest(
            getString(props?.permissionID) || getString(props?.requestID)
          ) || changed;
        break;
      }
      case 'question.asked': {
        changed = (props ? this.trackBlockingRequest('question', props) : false) || changed;
        break;
      }
      case 'question.replied':
      case 'question.rejected': {
        changed =
          this.clearBlockingRequest(getString(props?.requestID) || getString(props?.id)) || changed;
        break;
      }
    }

    if (changed) {
      this.listener.onStatusChange();
      this.publishPendingAttention();
      void this.persist();
    }
  }

  publishPendingAttention(): void {
    const sessionIds = [
      ...new Set([...this.pendingAttention.values()].map((item) => item.sessionID)),
    ];
    const key = sessionIds.join('\n');
    if (key === this.lastPendingAttentionKey) return;
    this.lastPendingAttentionKey = key;
    this.listener.onPendingAttentionChange(sessionIds);
  }

  resetPendingAttentionCache(): void {
    this.lastPendingAttentionKey = '';
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
      this.workspaceState.get<InterruptedSessionSnapshot[]>(INTERRUPTED_SESSIONS_KEY, []) || [];
    await this.workspaceState.update(INTERRUPTED_SESSIONS_KEY, []);
    return snapshots.filter((item) => typeof item?.id === 'string' && item.id.trim().length > 0);
  }

  async consumeBlockingRequests(): Promise<BlockingRequestSnapshot[]> {
    const snapshots =
      this.workspaceState.get<BlockingRequestSnapshot[]>(BLOCKING_REQUESTS_KEY, []) || [];
    await this.workspaceState.update(BLOCKING_REQUESTS_KEY, []);
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
   * webview reload). Does not emit notifications — those were already
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
      });
    }
    this.lastPendingAttentionKey = '';
  }

  describeSessionSuffix(sessionID: string): string {
    const title = this.sessionTitles.get(sessionID)?.trim();
    return title ? ` for "${title}"` : '';
  }

  private async persistInterruptedSessions() {
    const snapshots = [...this.busySessions]
      .toSorted()
      .map((id) => ({ id, title: this.sessionTitles.get(id)?.trim() || undefined }));
    await this.workspaceState.update(INTERRUPTED_SESSIONS_KEY, snapshots);
  }

  private async persistBlockingRequests() {
    const snapshots = [...this.pendingAttention.entries()]
      .map(([id, request]) => ({
        id,
        sessionID: request.sessionID,
        kind: request.kind,
        props: request.props,
      }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
    await this.workspaceState.update(BLOCKING_REQUESTS_KEY, snapshots);
  }

  private rememberSessionTitle(info: Record<string, unknown> | undefined) {
    const sessionID = getString(info?.id);
    const title = normalizeSessionTitle(getString(info?.title));
    if (sessionID && title) {
      this.sessionTitles.set(sessionID, title);
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
    this.busySessions.delete(sessionID);
    this.pendingAttention.set(requestID, { sessionID, kind, label, props: { ...props } });
    this.completedSessions.delete(sessionID);
    this.showBlockingNotification(kind, sessionID, label);
    return true;
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
    if (!this.notificationGate.shouldShow()) return;

    const message = this.isPlanSession(sessionID)
      ? `Varro has a plan ready for review${this.describeSessionSuffix(sessionID)}.`
      : `Varro completed a background session${this.describeSessionSuffix(sessionID)}.`;
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
  return getString(detail?.message) || getString(error.name);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
