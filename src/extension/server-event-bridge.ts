/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- OpenCode server events are decoded before bridge state is updated. */
/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Event assertions follow protocol parsing and workspace checks. */
import * as vscode from 'vscode';
import type { ExtensionMessage, ServerEvent, ServerStatus } from '../shared/protocol';
import { parseServerEvent } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
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

type CoalescableEvent =
  | {
      kind: 'append';
      key: string;
      fragmentField: 'delta' | 'text';
      fragment: string;
    }
  | {
      kind: 'merge';
      key: string;
    };

type PendingEvent = {
  key: string;
  event: ServerEvent;
} & (
  | {
      kind: 'append';
      fragmentField: 'delta' | 'text';
      fragment: string;
      fragmentCount: number;
    }
  | { kind: 'merge' }
);

type RecentEventState = {
  sequenceObserved: boolean;
  forwarded: boolean;
};

type PendingSequenceRange = {
  start: number;
  end: number;
  event: ServerEvent;
};

export class ServerEventBridge {
  private readonly attentionStatusBarItem: vscode.StatusBarItem;
  private readonly openCodeStatusBarItem: vscode.StatusBarItem;
  private status: ServerStatus = { state: 'stopped' };
  private serverStatusHandler: ((status: ServerStatus) => void) | undefined;
  private serverEventHandler: ((event: unknown) => void) | undefined;
  private readonly unknownEventLoggedAt = new Map<string, number>();
  private readonly recentEvents = new Map<string, RecentEventState>();
  private readonly pendingEvents = new Map<string, PendingEvent>();
  private readonly pendingSequenceRanges = new Map<string, PendingSequenceRange>();
  private pendingEventTimer: ReturnType<typeof setTimeout> | undefined;

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
    private readonly updateStatusBarItem: () => void
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
    this.flushPendingServerEvents();
  }

  attach() {
    if (this.serverStatusHandler || this.serverEventHandler) return;
    this.serverStatusHandler = (status: ServerStatus) => {
      this.flushPendingServerEvents();
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
        this.flushPendingServerEvents();
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
    this.flushPendingServerEvents();
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
            if (!this.attachSequenceToPendingProgress(event)) {
              this.flushPendingServerEvents();
              this.post({
                type: 'server/event',
                payload: { ...event, sequenceOnly: true } as ServerEvent,
              });
            }
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

    const coalescable = getCoalescableEvent(event);
    if (!coalescable) this.flushPendingServerEvents();
    this.hiddenSessions.observeEvent?.(event);
    if (this.shouldSuppress(event)) {
      this.flushPendingServerEvents();
      return;
    }
    const routeBeforeStateMutation = event.type === 'session.deleted';
    if (routeBeforeStateMutation) {
      if (recent) recent.forwarded = true;
      this.post({ type: 'server/event', payload: event });
    }
    this.sessionState.handleServerEvent(event);
    if (event.type === 'session.created' || event.type === 'session.updated') {
      this.updateStatusBarItem();
    }
    if (!routeBeforeStateMutation) {
      if (recent) recent.forwarded = true;
      if (coalescable) this.enqueueEvent(event, coalescable);
      else this.post({ type: 'server/event', payload: event });
    }
  }

  private enqueueEvent(event: ServerEvent, coalescable: CoalescableEvent) {
    if (
      coalescable.kind === 'append' &&
      coalescable.fragment.length > MAX_BATCHED_DELTA_CHARACTERS
    ) {
      this.flushPendingServerEvents();
      this.post({ type: 'server/event', payload: event });
      return;
    }

    const pending = this.pendingEvents.get(coalescable.key);
    if (pending) {
      if (pending.kind === 'merge' && coalescable.kind === 'merge') {
        this.pendingEvents.set(coalescable.key, {
          ...pending,
          event,
        });
        return;
      }
      if (
        pending.kind === 'append' &&
        coalescable.kind === 'append' &&
        pending.fragmentCount < MAX_BATCHED_DELTA_FRAGMENTS &&
        pending.fragment.length + coalescable.fragment.length <= MAX_BATCHED_DELTA_CHARACTERS
      ) {
        const fragment = pending.fragment + coalescable.fragment;
        this.pendingEvents.set(coalescable.key, {
          ...coalescable,
          event: mergeDeltaEvent(event, coalescable.fragmentField, fragment),
          fragment,
          fragmentCount: pending.fragmentCount + 1,
        });
        return;
      }
      this.flushPendingServerEvents();
    }

    this.pendingEvents.set(
      coalescable.key,
      coalescable.kind === 'append'
        ? { ...coalescable, event, fragmentCount: 1 }
        : { ...coalescable, event }
    );
    if (!this.pendingEventTimer) {
      this.pendingEventTimer = setTimeout(
        () => this.flushPendingServerEvents(),
        DELTA_BATCH_INTERVAL_MS
      );
    }
  }

  private attachSequenceToPendingProgress(event: ServerEvent) {
    if (event.type !== 'session.next.tool.progress' || event.seq === undefined) return false;
    const properties = asRecord(event.properties);
    const sessionID = properties?.sessionID;
    if (typeof sessionID !== 'string') return false;
    const pending = [...this.pendingEvents.values()].find(
      (item) => item.kind === 'merge' && item.event.id === event.id
    );
    if (!pending) return false;

    const range = this.pendingSequenceRanges.get(sessionID);
    if (range && event.seq !== range.end + 1) return false;
    this.pendingSequenceRanges.set(sessionID, {
      start: range?.start ?? event.seq,
      end: event.seq,
      event,
    });
    return true;
  }

  private flushPendingServerEvents() {
    if (this.pendingEventTimer) clearTimeout(this.pendingEventTimer);
    this.pendingEventTimer = undefined;
    const pending = [...this.pendingEvents.values()];
    const sequenceRanges = [...this.pendingSequenceRanges.entries()];
    this.pendingEvents.clear();
    this.pendingSequenceRanges.clear();
    for (const item of pending) this.post({ type: 'server/event', payload: item.event });
    for (const [sessionID, range] of sequenceRanges) {
      const payload = {
        id: range.event.id,
        type: range.event.type,
        seq: range.end,
        sequenceOnly: true,
        properties: { sessionID },
      } as ServerEvent;
      if (range.event.workspaceDirectory) {
        payload.workspaceDirectory = range.event.workspaceDirectory;
      }
      payload.sequenceStart = range.start;
      this.post({ type: 'server/event', payload });
    }
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

function getCoalescableEvent(event: ServerEvent): CoalescableEvent | null {
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
    case 'session.next.tool.progress':
      return createMergeableEvent(event.type, properties, ['sessionID', 'callID']);
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
): CoalescableEvent | null {
  if (!eligible) return null;
  const fragment = properties[fragmentField];
  if (typeof fragment !== 'string' || fragment.length === 0) return null;
  const identity = identityFields.map((field) => properties[field]);
  if (identity.some((value) => typeof value !== 'string' || value.length === 0)) return null;
  return {
    kind: 'append',
    key: [type, ...identity].join('\u0000'),
    fragmentField,
    fragment,
  };
}

function createMergeableEvent(
  type: string,
  properties: Record<string, unknown>,
  identityFields: string[]
): CoalescableEvent | null {
  const identity = identityFields.map((field) => properties[field]);
  if (identity.some((value) => typeof value !== 'string' || value.length === 0)) return null;
  return { kind: 'merge', key: [type, ...identity].join('\u0000') };
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
