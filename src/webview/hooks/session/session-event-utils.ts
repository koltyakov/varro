import { appStore } from '../../lib/stores/app-store';
import { applySessionShareOverride } from '../../lib/session-share-overrides';
import { isContinuationAssistantFinish } from '../../lib/message-metrics';
import type {
  AssistantMessage,
  Message,
  MessageEntry,
  Part,
  Session,
  SessionEventInfo,
} from '../../types';
import { getSessionWorkspaceScopeFromMetadata } from '../../../shared/protocol';
import { asRecord } from '../../../shared/type-utils';
import type { UnknownRecord } from '../../../shared/type-utils';
import { isNumber, isString } from '../../lib/runtime-values';

export function isCompleteMessageInfo<T>(value: T): value is T & Message {
  const record = asRecord(value);
  if (!record) return false;
  const time = asRecord(record.time);
  if (
    !isString(record.id) ||
    !record.id ||
    !isString(record.sessionID) ||
    !record.sessionID ||
    !isString(record.role) ||
    !record.time ||
    !time ||
    !isNumber(time.created)
  ) {
    return false;
  }

  if (record.role === 'user') {
    const model = asRecord(record.model);
    return !!(
      record.parentID === undefined &&
      isString(record.agent) &&
      record.model &&
      model &&
      isString(model.providerID) &&
      isString(model.modelID)
    );
  }

  if (record.role === 'assistant') {
    const path = asRecord(record.path);
    const tokens = asRecord(record.tokens);
    const cache = asRecord(tokens?.cache);
    return !!(
      isString(record.parentID) &&
      isString(record.modelID) &&
      isString(record.providerID) &&
      isString(record.mode) &&
      record.path &&
      path &&
      isString(path.cwd) &&
      isString(path.root) &&
      isNumber(record.cost) &&
      record.tokens &&
      tokens &&
      isNumber(tokens.input) &&
      isNumber(tokens.output) &&
      isNumber(tokens.reasoning) &&
      cache &&
      isNumber(cache.read) &&
      isNumber(cache.write)
    );
  }

  return false;
}

export function isCompleteMessagePart<T>(value: T): value is T & Part {
  const record = asRecord(value);
  if (!record) return false;
  return (
    isString(record.id) &&
    !!record.id &&
    isString(record.sessionID) &&
    !!record.sessionID &&
    isString(record.messageID) &&
    !!record.messageID &&
    isString(record.type) &&
    !!record.type
  );
}

export function isContinuationStepEnd(eventName: string, props: UnknownRecord) {
  if (eventName !== 'session.next.step.ended') return false;
  return isContinuationStepFinish(getEventString(props, 'finish'));
}

export function isContinuationStepFinish(value: string | undefined) {
  return isContinuationAssistantFinish(value);
}

export function getPartDeltaQueueKey(messageID: string, partID: string) {
  return `${messageID}\u0000${partID}`;
}

export const getToolExecutionKey = (sessionId: string, callId: string) =>
  `${sessionId}\u0000${callId}`;

export const getEventTimestamp = (props: UnknownRecord) => {
  const timestamp = props.timestamp;
  return isNumber(timestamp) && Number.isFinite(timestamp) ? timestamp : Date.now();
};

export function getPermissionReplyId(props: UnknownRecord) {
  const source = asRecord(props.info) ?? props;
  const id = source.id || source.permissionID || source.requestID;
  return isString(id) ? id : undefined;
}

// Accept `id` as a fallback for `requestID`, matching the extension host's
// SessionStateManager so both sides clear question attention on the same
// event shapes.
export function getQuestionReplyId(props: UnknownRecord | undefined) {
  const requestID = props?.requestID || props?.id;
  return isString(requestID) ? requestID : undefined;
}

export type NormalizedSessionEventInfo = SessionEventInfo & { id: string };

export const ACTIVE_SESSION_PROGRESS_EVENTS = [
  'session.next.agent.switched',
  'session.next.model.switched',
  'session.next.prompted',
  'session.next.synthetic',
  'session.next.shell.started',
  'session.next.shell.ended',
  'session.next.step.started',
  'session.next.step.ended',
  'session.next.step.failed',
  'session.next.text.started',
  'session.next.text.delta',
  'session.next.text.ended',
  'session.next.tool.input.started',
  'session.next.tool.input.delta',
  'session.next.tool.input.ended',
  'session.next.tool.called',
  'session.next.tool.progress',
  'session.next.tool.success',
  'session.next.tool.failed',
  'session.next.retried',
  'session.next.compaction.started',
  'session.next.compaction.delta',
  'session.next.compaction.ended',
] as const;

const ACTIVE_TEXT_PROGRESS_EVENTS = new Set<string>([
  'session.next.text.started',
  'session.next.text.delta',
  'session.next.text.ended',
]);

export const PROJECTED_SESSION_EVENTS = new Set<string>([
  ...ACTIVE_TEXT_PROGRESS_EVENTS,
  'session.next.tool.input.started',
  'session.next.tool.input.delta',
  'session.next.tool.input.ended',
  'session.next.tool.called',
  'session.next.tool.progress',
  'session.next.tool.success',
  'session.next.tool.failed',
  'session.next.reasoning.started',
  'session.next.reasoning.delta',
  'session.next.reasoning.ended',
]);

export const TRANSCRIPT_SYNC_SESSION_EVENTS = new Set<string>([
  'session.next.agent.switched',
  'session.next.model.switched',
  'session.next.prompted',
  'session.next.synthetic',
  'session.next.shell.started',
  'session.next.shell.ended',
]);

// After the final assistant text finishes streaming with no tools in flight, we
// optimistically settle the turn this long after the last progress event. Any
// genuine continuation (a tool call, more text/reasoning) arrives well within
// this window and cancels the timer, so it only fires on a real quiet period.
export const STREAMED_COMPLETION_SETTLE_DELAY_MS = 600;

export type ToolExecutionTime = { start?: number; end?: number };

export type AssistantUsagePatch = {
  cost?: number;
  finish?: string;
  tokens?: AssistantMessage['tokens'];
};

export function hasActiveAssistantReply(messages: MessageEntry[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role === 'user') return false;
    return !message.error && !message.time.completed;
  }

  return false;
}

export function getAssistantUsagePatchFromStepEvent(
  props: UnknownRecord
): AssistantUsagePatch | undefined {
  const tokens = parseAssistantTokens(props.tokens);
  const cost = getFiniteNumber(props.cost);
  const finish = getEventString(props, 'finish');
  if (!tokens && cost === undefined && !finish) return undefined;

  return { tokens: tokens ?? undefined, cost, finish };
}

function parseAssistantTokens<T>(value: T): AssistantMessage['tokens'] | null {
  const tokens = asRecord(value);
  if (!tokens) return null;

  const cache = asRecord(tokens.cache);
  const input = getFiniteNumber(tokens.input);
  const output = getFiniteNumber(tokens.output);
  const reasoning = getFiniteNumber(tokens.reasoning);
  const cacheRead = getFiniteNumber(cache?.read);
  const cacheWrite = getFiniteNumber(cache?.write);
  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return null;
  }

  const total = getFiniteNumber(tokens.total);
  const result: AssistantMessage['tokens'] = {
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  };
  if (total !== undefined) result.total = total;
  return result;
}

function getFiniteNumber<T>(value: T): number | undefined {
  return isNumber(value) && Number.isFinite(value) ? value : undefined;
}

export function latestAssistantMessageForSession(messages: MessageEntry[], sessionId: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.info.sessionID !== sessionId || message.info.role !== 'assistant') {
      continue;
    }
    if (!message.info.error && !message.info.time.completed) return message;
  }
  return null;
}

export function getAssistantFinishedMessageId(
  messages: MessageEntry[],
  partialMessage: { sessionID?: string; id?: unknown },
  assistantMessage: AssistantMessage | null
) {
  if (assistantMessage) return assistantMessage.id;
  if (isString(partialMessage.id) && partialMessage.id) return partialMessage.id;
  if (!partialMessage.sessionID) return null;
  return latestAssistantMessageForSession(messages, partialMessage.sessionID)?.info.id ?? null;
}

export function normalizeSessionEventInfo(
  info: SessionEventInfo | undefined,
  sessionID?: string
): NormalizedSessionEventInfo | null {
  if (!info) return null;
  const normalized = stripNullishSessionInfo(info);
  const id = isString(normalized.id) && normalized.id ? normalized.id : sessionID;
  if (!id) return null;
  const workspaceScope = getSessionWorkspaceScopeFromMetadata(normalized.metadata);
  return workspaceScope === 'workspace' && normalized.workspaceScope === undefined
    ? { ...normalized, id, workspaceScope }
    : { ...normalized, id };
}

function stripNullishSessionInfo(info: SessionEventInfo): SessionEventInfo {
  const normalized: UnknownRecord = {};
  for (const [key, value] of Object.entries(info)) {
    if (value === null || value === undefined) continue;
    if (key === 'time') {
      const timeRecord = asRecord(value);
      if (!timeRecord) continue;
      const time = Object.fromEntries(
        Object.entries(timeRecord).filter(
          ([, timeValue]) => timeValue !== null && timeValue !== undefined
        )
      );
      if (Object.keys(time).length > 0) normalized.time = time;
      continue;
    }
    normalized[key] = value;
  }
  // SAFETY: This copy only removes nullish optional fields from SessionEventInfo.
  return normalized as SessionEventInfo;
}

export function mergeSessionEventInfo(info: NormalizedSessionEventInfo): Session | null {
  if (isCompleteSessionEventInfo(info)) return applySessionShareOverride(info);

  const existing = appStore.state.sessions.find((session) => session.id === info.id);
  if (existing) {
    return applySessionShareOverride({
      ...existing,
      ...info,
      time: { ...existing.time, ...info.time },
    });
  }

  return null;
}

function isCompleteSessionEventInfo(
  info: NormalizedSessionEventInfo
): info is NormalizedSessionEventInfo & Session {
  return (
    isString(info.projectID) &&
    isString(info.directory) &&
    isString(info.title) &&
    isString(info.version) &&
    isNumber(info.time?.created) &&
    isNumber(info.time.updated)
  );
}

export function syncSessionAgent(info: NormalizedSessionEventInfo) {
  const agent = asRecord(info)?.agent;
  if (isString(agent) && agent) {
    appStore.setState('sessionSelectedAgents', info.id, agent);
  }
}

export function currentStreamingSnapshot() {
  return { partId: appStore.state.streamingPartId, text: appStore.state.streamingText };
}

export function getEventString<T>(value: T, key: string): string | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const item = record[key];
  return isString(item) ? item : undefined;
}

export function parseToolInput(value: string): UnknownRecord {
  if (!value.trim()) return {};
  return tryParseToolInput(value) ?? {};
}

export function tryParseToolInput(value: string): UnknownRecord | null {
  if (!value.trimEnd().endsWith('}')) return null;
  try {
    const parsed = JSON.parse(value);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

export function asToolInput<T>(value: T): UnknownRecord {
  return asRecord(value) ?? {};
}

export function asToolMetadata<T>(value: T): UnknownRecord {
  return asRecord(value) ?? {};
}

export function getToolStateInput(part: Part): UnknownRecord {
  if (part.type !== 'tool') return {};
  const input = part.state.input;
  return asRecord(input) ?? {};
}

export function getToolStartTime(part: Part): number {
  if (part.type !== 'tool' || !('time' in part.state)) return Date.now();
  const time = asRecord(part.state.time);
  return isNumber(time?.start) ? time.start : Date.now();
}

export function getToolErrorMessage<T>(value: T): string {
  if (isString(value)) return value;
  const message = asRecord(value)?.message;
  if (isString(message)) return message;
  return 'Tool execution failed';
}

export function toolOutputToString<T, U>(content: T, structured: U): string {
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        const record = asRecord(item);
        if (!record) return '';
        if (record.type === 'text' && isString(record.text)) return record.text;
        if (record.type === 'file' && isString(record.uri)) return record.uri;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  if (asRecord(structured) || Array.isArray(structured)) {
    try {
      return JSON.stringify(structured, null, 2);
    } catch {
      return String(structured);
    }
  }
  return '';
}
