/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- OpenCode server events are decoded before bridge state is updated. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Event assertions follow protocol parsing and workspace checks. */
import * as vscode from 'vscode';
import type { ExtensionMessage, ServerEvent, ServerStatus } from '../shared/protocol';
import { parseServerEvent } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from '../shared/workspace-path';
import type { OpenCodeServer } from './server';
import type { HiddenSessionManager } from './hidden-session-manager';
import { logger } from './logger';
import type { SessionStateManager } from './session-state-manager';
import { getSessionIdsForEvent } from './sidebar-provider-utils';
import {
  projectFileDiffs,
  projectPartFileLists,
  projectSummaryDiffs,
} from './util/summary-projection';

type PostMessage = (message: ExtensionMessage) => void;

const UNKNOWN_EVENT_LOG_INTERVAL_MS = 60_000;
const MAX_TRACKED_UNKNOWN_EVENT_TYPES = 100;
const MAX_TRACKED_EVENT_IDS = 1_024;
const DELTA_BATCH_INTERVAL_MS = 16;
const MAX_BATCHED_DELTA_FRAGMENTS = 256;
const MAX_BATCHED_DELTA_CHARACTERS = 64 * 1024;

type CoalescableDelta = {
  key: string;
  fragmentField: 'delta' | 'text';
  fragment: string;
};

type PendingDelta = CoalescableDelta & {
  event: ServerEvent;
  fragmentCount: number;
};

type RecentEventState = {
  sequenceObserved: boolean;
  forwarded: boolean;
};

export class ServerEventBridge {
  private readonly attentionStatusBarItem: vscode.StatusBarItem;
  private readonly openCodeStatusBarItem: vscode.StatusBarItem;
  private status: ServerStatus = { state: 'stopped' };
  private serverStatusHandler: ((status: ServerStatus) => void) | undefined;
  private serverEventHandler: ((event: unknown) => void) | undefined;
  private readonly unknownEventLoggedAt = new Map<string, number>();
  private readonly recentEvents = new Map<string, RecentEventState>();
  private pendingDelta: PendingDelta | undefined;
  private pendingDeltaTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly server: Pick<OpenCodeServer, 'on' | 'off'>,
    private readonly sessionState: Pick<
      SessionStateManager,
      'getSessionWorkspaceMatch' | 'handleServerEvent' | 'persist' | 'flush'
    >,
    private readonly hiddenSessions: Pick<HiddenSessionManager, 'isHidden' | 'observeEvent'>,
    private readonly providerLimitService: {
      shouldClearCache(previousStatus: ServerStatus, nextStatus: ServerStatus): boolean;
      clearCache(): void;
    },
    private readonly post: PostMessage,
    private readonly updateStatusBarItem: () => void,
    private readonly workspace?: { getPath(): string | null | undefined }
  ) {
    this.openCodeStatusBarItem = vscode.window.createStatusBarItem(
      'varro.opencode-version',
      vscode.StatusBarAlignment.Right,
      1000
    );
    this.openCodeStatusBarItem.name = 'OpenCode Version';

    this.attentionStatusBarItem = vscode.window.createStatusBarItem(
      'varro.session-status',
      vscode.StatusBarAlignment.Left,
      1000
    );
    this.attentionStatusBarItem.name = 'Varro Attention';
    this.attentionStatusBarItem.command = 'varro.chat.statusBarClick';
  }

  getStatus() {
    return this.status;
  }

  getStatusBarItem() {
    return this.attentionStatusBarItem;
  }

  getOpenCodeStatusBarItem() {
    return this.openCodeStatusBarItem;
  }

  flushPendingEvents() {
    this.flushPendingDelta();
  }

  attach() {
    if (this.serverStatusHandler || this.serverEventHandler) return;
    this.serverStatusHandler = (status: ServerStatus) => {
      this.flushPendingDelta();
      const previousStatus = this.status;
      this.status = status;
      if (this.providerLimitService.shouldClearCache(previousStatus, status)) {
        this.providerLimitService.clearCache();
      }
      this.post({ type: 'server/status', payload: status });
      this.updateStatusBarItem();
    };

    this.serverEventHandler = (event: unknown) => {
      const parsed = parseServerEvent(event);
      if (!parsed) {
        this.flushPendingDelta();
        this.logUnknownEvent(event);
        return;
      }
      this.acceptParsedEvent(parsed);
    };

    this.server.on('status', this.serverStatusHandler);
    this.server.on('event', this.serverEventHandler);
    this.updateStatusBarItem();
  }

  async dispose() {
    if (this.serverStatusHandler) this.server.off('status', this.serverStatusHandler);
    if (this.serverEventHandler) this.server.off('event', this.serverEventHandler);
    this.serverStatusHandler = undefined;
    this.serverEventHandler = undefined;
    this.flushPendingDelta();
    void this.sessionState.persist();
    await this.sessionState.flush();
    this.unknownEventLoggedAt.clear();
    this.recentEvents.clear();
    this.attentionStatusBarItem.dispose();
    this.openCodeStatusBarItem.dispose();
  }

  private acceptParsedEvent(event: ServerEvent) {
    event = projectEventSummaryDiffs(event);
    let recent: RecentEventState | undefined;
    if (event.id) {
      recent = this.recentEvents.get(event.id);
      if (recent) {
        // A direct compatibility event may precede its sequenced sync twin. Forward
        // only the new cursor so the webview does not replay the mutation.
        if (event.seq !== undefined && !recent.sequenceObserved) {
          recent.sequenceObserved = true;
          if (recent.forwarded) {
            this.flushPendingDelta();
            this.post({
              type: 'server/event',
              payload: { ...event, sequenceOnly: true } as ServerEvent,
            });
          }
        }
        return;
      }

      recent = { sequenceObserved: event.seq !== undefined, forwarded: false };
      this.recentEvents.set(event.id, recent);
      while (this.recentEvents.size > MAX_TRACKED_EVENT_IDS) {
        const oldestId = this.recentEvents.keys().next().value;
        if (oldestId === undefined) break;
        this.recentEvents.delete(oldestId);
      }
    }

    const delta = getCoalescableDelta(event);
    if (!delta || this.pendingDelta?.key !== delta.key) this.flushPendingDelta();
    this.hiddenSessions.observeEvent?.(event);
    if (this.shouldSuppress(event) || this.shouldSuppressWorkspace(event)) {
      this.flushPendingDelta();
      return;
    }
    this.sessionState.handleServerEvent(event);
    if (recent) recent.forwarded = true;
    if (delta) this.enqueueDelta(event, delta);
    else this.post({ type: 'server/event', payload: event });
  }

  private enqueueDelta(event: ServerEvent, delta: CoalescableDelta) {
    const pending = this.pendingDelta;
    if (pending?.key === delta.key) {
      if (
        pending.fragmentCount < MAX_BATCHED_DELTA_FRAGMENTS &&
        pending.fragment.length + delta.fragment.length <= MAX_BATCHED_DELTA_CHARACTERS
      ) {
        const fragment = pending.fragment + delta.fragment;
        this.pendingDelta = {
          ...delta,
          event: mergeDeltaEvent(event, delta.fragmentField, fragment),
          fragment,
          fragmentCount: pending.fragmentCount + 1,
        };
        return;
      }
      this.flushPendingDelta();
    }

    if (delta.fragment.length > MAX_BATCHED_DELTA_CHARACTERS) {
      this.post({ type: 'server/event', payload: event });
      return;
    }

    this.pendingDelta = { ...delta, event, fragmentCount: 1 };
    this.pendingDeltaTimer = setTimeout(() => this.flushPendingDelta(), DELTA_BATCH_INTERVAL_MS);
  }

  private flushPendingDelta() {
    if (this.pendingDeltaTimer) clearTimeout(this.pendingDeltaTimer);
    this.pendingDeltaTimer = undefined;
    const pending = this.pendingDelta;
    this.pendingDelta = undefined;
    if (pending) this.post({ type: 'server/event', payload: pending.event });
  }

  private logUnknownEvent(event: unknown) {
    const type = getRawEventType(event);
    if (!type) return;

    const now = Date.now();
    const lastLoggedAt = this.unknownEventLoggedAt.get(type) ?? 0;
    if (now - lastLoggedAt < UNKNOWN_EVENT_LOG_INTERVAL_MS) return;

    if (!this.unknownEventLoggedAt.has(type)) {
      while (this.unknownEventLoggedAt.size >= MAX_TRACKED_UNKNOWN_EVENT_TYPES) {
        const oldestType = this.unknownEventLoggedAt.keys().next().value;
        if (oldestType === undefined) break;
        this.unknownEventLoggedAt.delete(oldestType);
      }
    }
    this.unknownEventLoggedAt.set(type, now);
    logger.warn(`Ignoring unknown OpenCode event type: ${type}`);
  }

  private shouldSuppress(event: ServerEvent) {
    return getSessionIdsForEvent(event).some((sessionID) =>
      this.hiddenSessions.isHidden(sessionID)
    );
  }

  private shouldSuppressWorkspace(event: ServerEvent) {
    const workspacePath = this.workspace?.getPath();
    if (!normalizeWorkspaceIdentity(workspacePath)) return false;

    const info = asRecord(asRecord(event.properties)?.info);
    const directory = typeof info?.directory === 'string' ? info.directory : undefined;
    if (directory) return !isDirectoryInWorkspace(directory, workspacePath);

    const sessionIDs = getSessionIdsForEvent(event);
    if (sessionIDs.length === 0) return false;
    return sessionIDs.some(
      (sessionID) => this.sessionState.getSessionWorkspaceMatch(sessionID, workspacePath) === false
    );
  }
}

function projectEventSummaryDiffs(event: ServerEvent): ServerEvent {
  const properties = asRecord(event.properties);
  if (!properties) return event;

  let projectedProperties = properties;
  const info = asRecord(properties.info);
  if (info) {
    const projectedInfo = projectSummaryDiffs(info);
    if (projectedInfo !== info)
      projectedProperties = { ...projectedProperties, info: projectedInfo };
  }
  if (event.type === 'session.diff' && Array.isArray(properties.diff)) {
    const diff = projectFileDiffs(properties.diff);
    if (diff !== properties.diff) projectedProperties = { ...projectedProperties, diff };
  }
  const part = asRecord(properties.part);
  if (part) {
    const projectedPart = projectPartFileLists(part);
    if (projectedPart !== part)
      projectedProperties = { ...projectedProperties, part: projectedPart };
  }
  if (projectedProperties === properties) return event;
  return { ...event, properties: projectedProperties } as ServerEvent;
}

function getCoalescableDelta(event: ServerEvent): CoalescableDelta | null {
  if (event.seq !== undefined) return null;
  const properties = asRecord(event.properties);
  if (!properties) return null;

  switch (event.type) {
    case 'message.part.delta':
      return createCoalescableDelta(
        event.type,
        properties,
        'delta',
        ['sessionID', 'messageID', 'partID', 'field'],
        properties.field === 'text'
      );
    case 'session.next.text.delta':
      return createCoalescableDelta(event.type, properties, 'delta', [
        'sessionID',
        'assistantMessageID',
        'textID',
      ]);
    case 'session.next.reasoning.delta':
      return createCoalescableDelta(event.type, properties, 'delta', [
        'sessionID',
        'assistantMessageID',
        'reasoningID',
      ]);
    case 'session.next.tool.input.delta':
      return createCoalescableDelta(event.type, properties, 'delta', [
        'sessionID',
        'assistantMessageID',
        'callID',
      ]);
    case 'session.next.compaction.delta':
      return createCoalescableDelta(event.type, properties, 'text', ['sessionID', 'messageID']);
    default:
      return null;
  }
}

function createCoalescableDelta(
  type: string,
  properties: Record<string, unknown>,
  fragmentField: 'delta' | 'text',
  identityFields: string[],
  eligible = true
): CoalescableDelta | null {
  if (!eligible) return null;
  const fragment = properties[fragmentField];
  if (typeof fragment !== 'string' || fragment.length === 0) return null;
  const identity = identityFields.map((field) => properties[field]);
  if (identity.some((value) => typeof value !== 'string' || value.length === 0)) return null;
  return {
    key: [type, ...identity].join('\u0000'),
    fragmentField,
    fragment,
  };
}

function mergeDeltaEvent(
  event: ServerEvent,
  fragmentField: 'delta' | 'text',
  fragment: string
): ServerEvent {
  return {
    ...event,
    properties: { ...event.properties, [fragmentField]: fragment },
  } as ServerEvent;
}

function getRawEventType(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;

  const candidate = asRecord(record.payload) || asRecord(record.data) || record;
  const syncEvent = asRecord(candidate.syncEvent);
  const type = syncEvent?.type ?? (candidate.type === 'sync' ? candidate.name : candidate.type);
  return typeof type === 'string' && type.trim() ? type : null;
}

function isDirectoryInWorkspace(
  directory: string,
  workspacePath: string | null | undefined
): boolean {
  if (!normalizeWorkspaceIdentity(workspacePath)) return true;
  return isSameWorkspacePath(directory, workspacePath);
}
