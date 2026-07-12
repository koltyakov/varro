import {
  isAssistantMessage,
  getAssistantTotalTokens,
  type TokenUsage,
} from '../../lib/message-metrics';
import type { AssistantMessage, Message, Part, Session, TextPart } from '../../types';

export type MessageInfoEntry = { info: Message };

type AssistantMessageLookupOptions = {
  includeSubagents?: boolean;
};

export function getMessageEntriesForSession(
  messages: readonly MessageInfoEntry[],
  sessionId: string | null
): MessageInfoEntry[] {
  if (!sessionId) return [];
  return messages.filter((entry) => entry.info.sessionID === sessionId);
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
  const treeIds = new Set(sessionIds);
  const messagesBySession = new Map<string, MessageInfoEntry[]>();
  for (const entry of messages) {
    const sessionId = entry.info.sessionID;
    if (!treeIds.has(sessionId)) continue;
    const entries = messagesBySession.get(sessionId);
    if (entries) entries.push(entry);
    else messagesBySession.set(sessionId, [entry]);
  }

  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const session = emptyTokenUsage();
  const subagents = emptyTokenUsage();
  let subagentCount = 0;
  for (const sessionId of treeIds) {
    const messageTokens = sumAssistantTokensFromMessageEntries(
      messagesBySession.get(sessionId) || []
    );
    if (sessionId === rootSessionId) {
      addTokenUsage(session, messageTokens);
      continue;
    }

    subagentCount += 1;

    const snapshotTokens = getSessionTokenUsage(sessionsById.get(sessionId));
    addTokenUsage(
      subagents,
      snapshotTokens && snapshotTokens.total >= messageTokens.total ? snapshotTokens : messageTokens
    );
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
    .map((part) => part.text.trim())
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
