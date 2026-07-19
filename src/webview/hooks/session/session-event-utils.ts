import { appStore } from '../../lib/stores/app-store';
import type {
  AssistantMessage,
  Message,
  MessageEntry,
  Part,
  Session,
  SessionEventInfo,
} from '../../types';

export function isCompleteMessageInfo(value: unknown): value is Message {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.sessionID !== 'string' ||
    !record.sessionID ||
    typeof record.role !== 'string' ||
    !record.time ||
    typeof record.time !== 'object' ||
    typeof (record.time as { created?: unknown }).created !== 'number'
  ) {
    return false;
  }

  if (record.role === 'user') {
    return !!(
      record.parentID === undefined &&
      typeof record.agent === 'string' &&
      record.model &&
      typeof record.model === 'object' &&
      typeof (record.model as { providerID?: unknown }).providerID === 'string' &&
      typeof (record.model as { modelID?: unknown }).modelID === 'string'
    );
  }

  if (record.role === 'assistant') {
    return !!(
      typeof record.parentID === 'string' &&
      typeof record.modelID === 'string' &&
      typeof record.providerID === 'string' &&
      typeof record.mode === 'string' &&
      record.path &&
      typeof record.path === 'object' &&
      typeof (record.path as { cwd?: unknown }).cwd === 'string' &&
      typeof (record.path as { root?: unknown }).root === 'string' &&
      typeof record.cost === 'number' &&
      record.tokens &&
      typeof record.tokens === 'object' &&
      typeof (record.tokens as { input?: unknown }).input === 'number' &&
      typeof (record.tokens as { output?: unknown }).output === 'number' &&
      typeof (record.tokens as { reasoning?: unknown }).reasoning === 'number' &&
      (record.tokens as { cache?: unknown }).cache &&
      typeof (record.tokens as { cache?: unknown }).cache === 'object' &&
      typeof ((record.tokens as { cache?: unknown }).cache as { read?: unknown }).read ===
        'number' &&
      typeof ((record.tokens as { cache?: unknown }).cache as { write?: unknown }).write ===
        'number'
    );
  }

  return false;
}

export function isCompleteMessagePart(value: unknown): value is Part {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    !!record.id &&
    typeof record.sessionID === 'string' &&
    !!record.sessionID &&
    typeof record.messageID === 'string' &&
    !!record.messageID &&
    typeof record.type === 'string' &&
    !!record.type
  );
}

export function isContinuationStepEnd(eventName: string, props: Record<string, unknown>) {
  if (eventName !== 'session.next.step.ended') return false;
  return isContinuationStepFinish(getEventString(props, 'finish'));
}

export function isContinuationStepFinish(value: string | undefined) {
  const finish = normalizeStepFinish(value);
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

function normalizeStepFinish(value: string | undefined) {
  return value?.toLowerCase().replace(/[\s-]+/g, '_');
}

export function getPartDeltaQueueKey(messageID: string, partID: string) {
  return `${messageID}\u0000${partID}`;
}

export const getToolExecutionKey = (sessionId: string, callId: string) =>
  `${sessionId}\u0000${callId}`;

export const getEventTimestamp = (props: Record<string, unknown>) => {
  const timestamp = props.timestamp;
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now();
};

export function getPermissionReplyId(props: Record<string, unknown>) {
  const source =
    props.info && typeof props.info === 'object' ? (props.info as Record<string, unknown>) : props;
  return (source.id || source.permissionID || source.requestID) as string | undefined;
}

// Accept `id` as a fallback for `requestID`, matching the extension host's
// SessionStateManager so both sides clear question attention on the same
// event shapes.
export function getQuestionReplyId(props: Record<string, unknown> | undefined) {
  const requestID = props?.requestID || props?.id;
  return typeof requestID === 'string' ? requestID : undefined;
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
  props: Record<string, unknown>
): AssistantUsagePatch | undefined {
  const tokens = parseAssistantTokens(props.tokens);
  const cost = getFiniteNumber(props.cost);
  const finish = getEventString(props, 'finish');
  if (!tokens && cost === undefined && !finish) return undefined;

  return { tokens: tokens ?? undefined, cost, finish };
}

function parseAssistantTokens(value: unknown): AssistantMessage['tokens'] | null {
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
  return {
    ...(total !== undefined ? { total } : {}),
    input,
    output,
    reasoning,
    cache: { read: cacheRead, write: cacheWrite },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  if (typeof partialMessage.id === 'string' && partialMessage.id) return partialMessage.id;
  if (!partialMessage.sessionID) return null;
  return latestAssistantMessageForSession(messages, partialMessage.sessionID)?.info.id ?? null;
}

export function normalizeSessionEventInfo(
  info: SessionEventInfo | undefined,
  sessionID?: string
): NormalizedSessionEventInfo | null {
  if (!info) return null;
  const normalized = stripNullishSessionInfo(info);
  const id = typeof normalized.id === 'string' && normalized.id ? normalized.id : sessionID;
  return id ? { ...normalized, id } : null;
}

function stripNullishSessionInfo(info: SessionEventInfo): SessionEventInfo {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(info)) {
    if (value === null || value === undefined) continue;
    if (key === 'time' && value && typeof value === 'object') {
      const time = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).filter(
          ([, timeValue]) => timeValue !== null && timeValue !== undefined
        )
      );
      if (Object.keys(time).length > 0) normalized.time = time;
      continue;
    }
    normalized[key] = value;
  }
  return normalized as SessionEventInfo;
}

export function mergeSessionEventInfo(info: NormalizedSessionEventInfo): Session | null {
  const existing = appStore.state.sessions.find((session) => session.id === info.id);
  if (existing) {
    return {
      ...existing,
      ...info,
      time: { ...existing.time, ...info.time },
    };
  }

  if (
    typeof info.projectID === 'string' &&
    typeof info.directory === 'string' &&
    typeof info.title === 'string' &&
    typeof info.version === 'string' &&
    typeof info.time?.created === 'number' &&
    typeof info.time.updated === 'number'
  ) {
    return info as Session;
  }

  return null;
}

export function syncSessionAgent(info: NormalizedSessionEventInfo) {
  const agent = (info as { agent?: unknown }).agent;
  if (typeof agent === 'string' && agent) {
    appStore.setState('sessionSelectedAgents', info.id, agent);
  }
}

export function currentStreamingSnapshot() {
  return { partId: appStore.state.streamingPartId, text: appStore.state.streamingText };
}

export function getEventString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' ? item : undefined;
}

export function parseToolInput(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return asToolInput(parsed);
  } catch {
    return {};
  }
}

export function asToolInput(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asToolMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function getToolStateInput(part: Part): Record<string, unknown> {
  if (part.type !== 'tool') return {};
  const input = part.state.input;
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function getToolStartTime(part: Part): number {
  if (part.type !== 'tool') return Date.now();
  const time = (part.state as { time?: { start?: unknown } }).time;
  return typeof time?.start === 'number' ? time.start : Date.now();
}

export function getToolErrorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const message = (value as Record<string, unknown>).message;
    if (typeof message === 'string') return message;
  }
  return 'Tool execution failed';
}

export function toolOutputToString(content: unknown, structured: unknown): string {
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        if (record.type === 'text' && typeof record.text === 'string') return record.text;
        if (record.type === 'file' && typeof record.uri === 'string') return record.uri;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  if (structured && typeof structured === 'object') {
    try {
      return JSON.stringify(structured, null, 2);
    } catch {
      return String(structured);
    }
  }
  return '';
}
