import {
  isAssistantMessage,
  getAssistantTotalTokens,
  type TokenUsage,
} from '../../lib/message-metrics';
import type { AssistantMessage, Message, Part, Session, TextPart } from '../../types';
import { stripContextForHistory } from '../../lib/context-history';

export type MessageInfoEntry = { info: Message };

type AssistantMessageLookupOptions = {
  includeSubagents?: boolean;
};

export function getMessageEntriesForSession<T extends MessageInfoEntry>(
  messages: readonly T[],
  sessionId: string | null
): T[] {
  if (!sessionId) return [];
  return messages.filter((entry) => entry.info.sessionID === sessionId);
}

export function groupMessageEntriesBySession<T extends MessageInfoEntry>(messages: readonly T[]) {
  const messagesBySession = new Map<string, T[]>();
  for (const entry of messages) {
    const sessionId = entry.info.sessionID;
    const entries = messagesBySession.get(sessionId);
    if (entries) entries.push(entry);
    else messagesBySession.set(sessionId, [entry]);
  }
  return messagesBySession;
}

export function getLatestAssistantMessageInfo(
  messages: readonly MessageInfoEntry[]
): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (!info || !isAssistantMessage(info)) continue;
    if (info.mode === 'subagent') continue;
    return info;
  }
  return null;
}

export function getLatestAssistantMessageInfoWithTokens(
  messages: readonly MessageInfoEntry[],
  options?: AssistantMessageLookupOptions
): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (!info || !isAssistantMessage(info)) continue;
    if (!options?.includeSubagents && info.mode === 'subagent') continue;
    if ((info.tokens.input || 0) + (info.tokens.output || 0) > 0) return info;
  }
  return null;
}

export function sumAssistantTokensFromMessageEntries(
  messages: readonly MessageInfoEntry[]
): TokenUsage {
  const result: TokenUsage = {
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };

  for (const entry of messages) {
    const info = entry.info;
    if (!isAssistantMessage(info)) continue;
    result.total += getAssistantTotalTokens(info);
    result.input += info.tokens.input || 0;
    result.output += info.tokens.output || 0;
    result.reasoning += info.tokens.reasoning || 0;
    result.cacheRead += info.tokens.cache?.read || 0;
    result.cacheWrite += info.tokens.cache?.write || 0;
  }

  return result;
}

export function getSessionCost(
  messages: readonly MessageInfoEntry[],
  session: Session | undefined
): number | null {
  let messageCost = 0;
  for (const entry of messages) {
    if (!isAssistantMessage(entry.info)) continue;
    messageCost += entry.info.cost || 0;
  }

  const sessionCost = session?.cost || 0;
  const cost = Math.max(messageCost, sessionCost);
  return cost > 0 ? cost : null;
}

export function sumSessionTreeTokens(
  messages: readonly MessageInfoEntry[],
  sessions: readonly Session[],
  sessionIds: readonly string[],
  rootSessionId: string
): TokenUsage {
  return getSessionTreeTokenBreakdown(messages, sessions, sessionIds, rootSessionId).total;
}

export function getSessionTreeTokenBreakdown(
  messages: readonly MessageInfoEntry[],
  sessions: readonly Session[],
  sessionIds: readonly string[],
  rootSessionId: string
) {
  return getSessionTreeTokenBreakdownFromTotals(
    accumulateSessionMessageTotals(messages, sessionIds),
    sessions,
    sessionIds,
    rootSessionId
  );
}

export type SessionMessageTotals = ReadonlyMap<string, { tokens: TokenUsage; cost: number }>;

/**
 * Sums assistant usage per tree session in transcript order. `earlier` holds the sums for the
 * messages before `messages`, so a settled prefix can be summed once and continued exactly.
 */
export function accumulateSessionMessageTotals(
  messages: readonly MessageInfoEntry[],
  sessionIds: readonly string[],
  earlier?: SessionMessageTotals
): SessionMessageTotals {
  const treeIds = new Set(sessionIds);
  const totals = new Map<string, { tokens: TokenUsage; cost: number }>();
  for (const [sessionId, total] of earlier ?? []) {
    totals.set(sessionId, { tokens: { ...total.tokens }, cost: total.cost });
  }
  for (const entry of messages) {
    const info = entry.info;
    if (!treeIds.has(info.sessionID) || !isAssistantMessage(info)) continue;
    let total = totals.get(info.sessionID);
    if (!total) {
      total = { tokens: emptyTokenUsage(), cost: 0 };
      totals.set(info.sessionID, total);
    }
    total.tokens.total += getAssistantTotalTokens(info);
    total.tokens.input += info.tokens.input || 0;
    total.tokens.output += info.tokens.output || 0;
    total.tokens.reasoning += info.tokens.reasoning || 0;
    total.tokens.cacheRead += info.tokens.cache?.read || 0;
    total.tokens.cacheWrite += info.tokens.cache?.write || 0;
    total.cost += info.cost || 0;
  }
  return totals;
}

export function getSessionTreeTokenBreakdownFromTotals(
  totals: SessionMessageTotals,
  sessions: readonly Session[],
  sessionIds: readonly string[],
  rootSessionId: string
) {
  const treeIds = new Set(sessionIds);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const session = emptyTokenUsage();
  const subagents = emptyTokenUsage();
  let subagentCount = 0;
  for (const sessionId of treeIds) {
    const messageTotal = totals.get(sessionId);
    const messageTokens = messageTotal ? { ...messageTotal.tokens } : emptyTokenUsage();
    const snapshotTokens = getSessionTokenUsage(sessionsById.get(sessionId));
    const tokens =
      snapshotTokens && snapshotTokens.total >= messageTokens.total
        ? snapshotTokens
        : messageTokens;
    const sessionCost = Math.max(messageTotal?.cost ?? 0, sessionsById.get(sessionId)?.cost || 0);
    if (sessionCost > 0) tokens.cost = sessionCost;
    if (sessionId === rootSessionId) {
      addTokenUsage(session, tokens);
      continue;
    }

    subagentCount += 1;
    addTokenUsage(subagents, tokens);
  }
  const total = emptyTokenUsage();
  addTokenUsage(total, session);
  addTokenUsage(total, subagents);
  return { session, subagents, total, subagentCount };
}

function getSessionTokenUsage(session: Session | undefined): TokenUsage | null {
  if (!session?.tokens) return null;
  const tokens = session.tokens;
  const usage = {
    total: 0,
    input: tokens.input || 0,
    output: tokens.output || 0,
    reasoning: tokens.reasoning || 0,
    cacheRead: tokens.cache?.read || 0,
    cacheWrite: tokens.cache?.write || 0,
  };
  usage.total = usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
  return usage;
}

function emptyTokenUsage(): TokenUsage {
  return { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokenUsage(target: TokenUsage, source: TokenUsage) {
  if (source.cost) target.cost = (target.cost ?? 0) + source.cost;
  target.total += source.total;
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

export function getUserMessageHistoryText(parts: Part[]) {
  const text = parts
    .filter((part): part is TextPart => part.type === 'text')
    .filter((part) => !part.synthetic && !part.ignored)
    .map((part) => stripContextForHistory(part.text).trim())
    .filter(
      (value) =>
        value.length > 0 &&
        !value.startsWith('[Working directory:') &&
        !value.startsWith('[Selection from') &&
        !value.startsWith('[Active file:')
    )
    .join('\n\n')
    .trim();

  return text.length > 0 ? text : null;
}

export type SessionTreeTokenBreakdown = ReturnType<typeof getSessionTreeTokenBreakdown>;

/** The subset of a breakdown the merge reads, so protocol payloads without `total` still fit. */
type MergeableTokenBreakdown = Pick<
  SessionTreeTokenBreakdown,
  'session' | 'subagents' | 'subagentCount'
>;

function mergeUsage(local: TokenUsage, complete: TokenUsage): TokenUsage {
  const tokens = complete.total >= local.total ? complete : local;
  const cost = Math.max(local.cost ?? 0, complete.cost ?? 0);
  return cost === (tokens.cost ?? 0) ? tokens : { ...tokens, cost };
}

/**
 * Merges a server-side token breakdown over the one derived from locally loaded messages.
 *
 * The local view only counts messages the webview has actually fetched, so it under-reports on
 * long sessions; the server view can lag a live run. Taking the larger of the two per bucket
 * keeps the displayed totals monotonic instead of flickering downward when one source catches up.
 */
export function mergeCompleteTokenBreakdown(
  local: SessionTreeTokenBreakdown,
  complete: { rootId: string; breakdown: MergeableTokenBreakdown } | null | undefined,
  rootId: string | null
): SessionTreeTokenBreakdown {
  if (!rootId || complete?.rootId !== rootId) return local;

  return {
    ...local,
    session: mergeUsage(local.session, complete.breakdown.session),
    subagents: mergeUsage(local.subagents, complete.breakdown.subagents),
    subagentCount: Math.max(local.subagentCount, complete.breakdown.subagentCount),
  };
}
