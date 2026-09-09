/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Session history payloads are untrusted and normalized before aggregation. */
import {
  estimateContextBreakdownFromCharacters,
  estimateNestedContextBreakdown,
} from '../shared/context-breakdown';
import type {
  ContextCharacterCounts,
  ContextBreakdownKey,
  ContextMessageEntry,
} from '../shared/context-breakdown';
import type { Message, Part } from '../shared/opencode-types';
import type {
  SessionDiffSummary,
  SessionTokenBreakdown,
  SessionTokenUsage,
} from '../shared/protocol';
import type { LocalSessionSummaryData } from './local-session-summary';
import { asRecord } from './sidebar-provider-utils';
import {
  isGeneratedDependencyPath,
  projectPartFileLists,
  projectSummaryDiffs,
} from './util/summary-projection';

async function summarizeRemoteSession(
  diffs: unknown,
  messages: unknown,
  descendants: Array<{ id: string; tokens?: unknown }>,
  loadDescendantMessages: () => Promise<unknown[]>
): Promise<SessionDiffSummary> {
  const diffStats = summarizeSessionDiff(diffs);
  const historyStatsUnavailable = hasOmittedMessageHistory(messages);
  const messageEditStats = summarizeSessionMessageEdits(messages);
  const editStats = hasSessionEdits(diffStats) ? diffStats : messageEditStats;
  const session = summarizeSessionTokenUsage(messages);
  const subagents = emptySessionTokenUsage();
  const messageLists = await loadDescendantMessages();
  for (let index = 0; index < descendants.length; index += 1) {
    const snapshot = summarizeTokenUsageRecord(asRecord(descendants[index]?.tokens));
    addSessionTokenUsage(
      subagents,
      snapshot.total > 0 ? snapshot : summarizeSessionTokenUsage(messageLists[index])
    );
  }
  const tokenBreakdown = {
    session,
    subagents,
    subagentCount: descendants.length,
  } satisfies SessionTokenBreakdown;
  const nestedContextBreakdown = estimateNestedContextBreakdown([
    normalizeContextMessages(messages),
    ...messageLists.map(normalizeContextMessages),
  ]);
  const model = summarizeSessionModel(messages);
  const result: SessionDiffSummary = {
    ...editStats,
    tokens:
      getSessionTokensExcludingCacheReads(tokenBreakdown.session) +
      getSessionTokensExcludingCacheReads(tokenBreakdown.subagents),
    ...summarizeSessionDuration(messages),
  };
  if (historyStatsUnavailable) result.historyStatsUnavailable = true;
  if (model) result.model = model;
  if (!historyStatsUnavailable) result.tokenBreakdown = tokenBreakdown;
  if (!historyStatsUnavailable && nestedContextBreakdown.length > 0) {
    result.nestedContextBreakdown = nestedContextBreakdown;
  }
  return result;
}

function summarizeSessionDiff(
  value: unknown
): Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'> {
  const record = asRecord(value);
  const candidates = Array.isArray(value)
    ? value
    : record && isDiffRecord(record)
      ? [record]
      : Object.values(record ?? {});
  const relativeFiles = new Set<string>();
  const absoluteFiles = new Set<string>();
  const absoluteFileSuffixes = new Set<string>();
  let fileCount = 0;
  let validDiffs = 0;
  let additions = 0;
  let deletions = 0;

  for (const candidate of candidates) {
    const diff = asRecord(candidate);
    if (!diff || !isDiffRecord(diff)) continue;
    if (typeof diff.file === 'string' && isGeneratedDependencyPath(diff.file)) continue;
    validDiffs += 1;
    if (typeof diff.file === 'string' && diff.file) {
      const file = normalizeSummaryFile(diff.file);
      const absolute = isAbsoluteSummaryFile(file);
      const duplicate = absolute
        ? absoluteFiles.has(file) ||
          getSummaryFileSuffixes(file).some((suffix) => relativeFiles.has(suffix))
        : relativeFiles.has(file) || absoluteFileSuffixes.has(file);
      if (!duplicate) {
        fileCount += 1;
        if (absolute) {
          absoluteFiles.add(file);
          for (const suffix of getSummaryFileSuffixes(file)) absoluteFileSuffixes.add(suffix);
        } else {
          relativeFiles.add(file);
        }
      }
    }
    additions += readDiffLineCount(diff.additions, diff.added);
    deletions += readDiffLineCount(diff.deletions, diff.removed);
  }

  return {
    files: fileCount || validDiffs,
    additions,
    deletions,
  };
}

function normalizeSummaryFile(path: string) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isAbsoluteSummaryFile(path: string) {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function getSummaryFileSuffixes(path: string): string[] {
  const suffixes: string[] = [];
  for (
    let separator = path.indexOf('/');
    separator !== -1;
    separator = path.indexOf('/', separator + 1)
  ) {
    const suffix = path.slice(separator + 1);
    if (suffix) suffixes.push(suffix);
  }
  return suffixes;
}

function summarizeSessionMessageEdits(
  value: unknown
): Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'> {
  if (!Array.isArray(value)) return { files: 0, additions: 0, deletions: 0 };

  const diffs: Record<string, unknown>[] = [];
  let filesTruncated = false;
  for (const entry of value) {
    const message = asRecord(entry);
    const info = asRecord(message?.info);
    const summary = asRecord(info?.summary);
    if (summary?.diffsOmitted === true || summary?.diffsTruncated === true) filesTruncated = true;
    if (Array.isArray(summary?.diffs)) diffs.push(...summary.diffs.flatMap(asDiffRecord));

    if (!Array.isArray(message?.parts)) continue;
    for (const partValue of message.parts) {
      const part = asRecord(partValue);
      if (part?.type === 'patch' && Array.isArray(part.files)) {
        for (const file of part.files) {
          if (typeof file === 'string' && file && !isGeneratedDependencyPath(file)) {
            diffs.push({ file });
          }
        }
        continue;
      }
      if (part?.type !== 'tool' || typeof part.tool !== 'string') continue;

      const state = asRecord(part.state);
      const metadata = asRecord(state?.metadata);
      if (Array.isArray(metadata?.files)) {
        for (const item of metadata.files) {
          const diff = asRecord(item);
          const file = diff && readFirstString(diff, ['relativePath', 'file', 'path', 'filePath']);
          if (!diff || !file || isGeneratedDependencyPath(file)) continue;
          diffs.push({ ...diff, file });
        }
        continue;
      }

      const tool = part.tool.trim().toLowerCase().split('.').pop() || '';
      if (!SESSION_FILE_CHANGE_TOOLS.has(tool)) continue;
      const input = asRecord(state?.input);
      const source = { ...metadata, ...input };
      const file = readFirstString(source, [
        'relativePath',
        'file',
        'path',
        'filePath',
        'filepath',
        'filename',
      ]);
      if (!file || isGeneratedDependencyPath(file)) continue;
      diffs.push({
        file,
        additions: source.additions ?? source.linesAdded,
        deletions: source.deletions ?? source.linesRemoved,
      });
    }
  }
  const summary = summarizeSessionDiff(diffs);
  if (filesTruncated && summary.files === 0) summary.filesTruncated = true;
  return summary;
}

function hasOmittedMessageHistory(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const info = asRecord(asRecord(entry)?.info);
    return asRecord(info?.summary)?.diffsOmitted === true;
  });
}

function projectMessageHistory(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    const message = asRecord(entry);
    if (!message) return entry;
    const info = projectSummaryDiffs(message.info);
    const parts = Array.isArray(message.parts)
      ? message.parts.map(projectPartFileLists)
      : message.parts;
    return info === message.info && parts === message.parts ? entry : { ...message, info, parts };
  });
}

function omittedMessageHistory() {
  return [
    {
      info: {
        role: 'user',
        time: { created: 0 },
        summary: { diffs: [], diffsOmitted: true, diffsTruncated: true },
      },
      parts: [],
    },
  ];
}

function asDiffRecord(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  return record ? [record] : [];
}

function readFirstString(source: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function hasSessionEdits(
  stats: Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'>
) {
  return (
    stats.filesTruncated === true || stats.files > 0 || stats.additions > 0 || stats.deletions > 0
  );
}

const SESSION_FILE_CHANGE_TOOLS = new Set([
  'apply_patch',
  'edit',
  'write',
  'create',
  'file_edit',
  'file_write',
  'file_create',
  'update_file',
  'replace',
  'insert',
  'apply_edit',
  'apply_diff',
  'delete',
  'remove',
  'unlink',
  'rm',
  'file_delete',
  'file_remove',
  'move',
  'mv',
  'rename',
  'file_move',
  'file_rename',
]);

function summarizeSessionTokenUsage(value: unknown): SessionTokenUsage {
  const usage = emptySessionTokenUsage();
  if (!Array.isArray(value)) return usage;

  for (const entry of value) {
    const info = asRecord(asRecord(entry)?.info);
    if (info?.role !== 'assistant') continue;
    const tokens = asRecord(info.tokens);
    if (!tokens) continue;

    addSessionTokenUsage(usage, summarizeTokenUsageRecord(tokens));
  }
  return usage;
}

function summarizeLocalSession(data: LocalSessionSummaryData): SessionDiffSummary {
  const messages = projectMessageHistory(data.messages);
  const editStats = summarizeSessionMessageEdits(messages);
  const session = summarizeSessionTokenUsage(messages);
  const subagents = emptySessionTokenUsage();
  const contextSessions = [
    {
      messages,
      characters: data.contextCharacters,
      inputTokens: data.contextInputTokens,
    },
  ];

  for (const descendant of data.descendants) {
    const descendantMessages = projectMessageHistory(descendant.messages);
    const snapshot = summarizeTokenUsageRecord(asRecord(descendant.tokens));
    addSessionTokenUsage(
      subagents,
      snapshot.total > 0 ? snapshot : summarizeSessionTokenUsage(descendantMessages)
    );
    contextSessions.push({
      messages: descendantMessages,
      characters: descendant.contextCharacters,
      inputTokens: descendant.contextInputTokens,
    });
  }

  const tokenBreakdown = {
    session,
    subagents,
    subagentCount: data.descendants.length,
  } satisfies SessionTokenBreakdown;
  const result: SessionDiffSummary = {
    ...editStats,
    tokens:
      getSessionTokensExcludingCacheReads(session) + getSessionTokensExcludingCacheReads(subagents),
    tokenBreakdown,
    ...summarizeSessionDuration(messages),
  };
  const model = summarizeSessionModel(messages);
  const nestedContextBreakdown = estimateLocalContextBreakdown(contextSessions);
  if (model) result.model = model;
  if (nestedContextBreakdown.length > 0) result.nestedContextBreakdown = nestedContextBreakdown;
  return result;
}

function estimateLocalContextBreakdown(
  sessions: Array<{
    messages: unknown;
    characters?: ContextCharacterCounts;
    inputTokens?: number;
  }>
) {
  const totals = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
    other: 0,
  } satisfies Record<ContextBreakdownKey, number>;

  for (const session of sessions) {
    const messages = normalizeContextMessages(session.messages);
    let inputTokens = session.inputTokens ?? 0;
    if (session.inputTokens === undefined) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info;
        const input = info?.role === 'assistant' ? info.tokens?.input : 0;
        if (!input || input <= 0) continue;
        inputTokens = input;
        break;
      }
    }
    const breakdown = session.characters
      ? estimateContextBreakdownFromCharacters(session.characters, inputTokens)
      : estimateNestedContextBreakdown([messages]);
    for (const segment of breakdown) totals[segment.key] += segment.tokens;
  }

  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];
  const keys: ContextBreakdownKey[] = ['system', 'user', 'assistant', 'tool', 'other'];
  return keys
    .filter((key) => totals[key] > 0)
    .map((key) => ({
      key,
      tokens: totals[key],
      percent: Math.round((totals[key] / total) * 1_000) / 10,
    }));
}

function normalizeContextMessages(value: unknown): ContextMessageEntry[] {
  if (!Array.isArray(value)) return [];
  const messages: ContextMessageEntry[] = [];
  for (const valueEntry of value) {
    const entry = asRecord(valueEntry);
    const info = asRecord(entry?.info);
    if (info?.role !== 'user' && info?.role !== 'assistant') continue;
    messages.push({
      // SAFETY: The role discriminator is checked before passing history to the existing context estimator.
      info: info as Message,
      // SAFETY: OpenCode history parts are normalized by the context estimator; malformed collections become empty.
      parts: Array.isArray(entry?.parts) ? (entry.parts as Part[]) : [],
    });
  }
  return messages;
}

function summarizeTokenUsageRecord(tokens: Record<string, unknown> | undefined): SessionTokenUsage {
  if (!tokens) return emptySessionTokenUsage();
  const cache = asRecord(tokens.cache);
  const usage = {
    total: 0,
    input: readTokenCount(tokens.input),
    output: readTokenCount(tokens.output),
    reasoning: readTokenCount(tokens.reasoning),
    cacheRead: readTokenCount(cache?.read),
    cacheWrite: readTokenCount(cache?.write),
  };
  usage.total =
    isTokenCount(tokens.total) && tokens.total > 0
      ? tokens.total
      : usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
  return usage;
}

function emptySessionTokenUsage(): SessionTokenUsage {
  return { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function getSessionTokensExcludingCacheReads(usage: SessionTokenUsage): number {
  return Math.max(0, usage.total - usage.cacheRead);
}

function addSessionTokenUsage(target: SessionTokenUsage, source: SessionTokenUsage) {
  target.total += source.total;
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

function summarizeSessionModel(value: unknown): SessionDiffSummary['model'] {
  if (!Array.isArray(value)) return undefined;

  let model: SessionDiffSummary['model'];
  for (const entry of value) {
    const info = asRecord(asRecord(entry)?.info);
    if (info?.role !== 'assistant' || info.mode === 'subagent') continue;
    if (typeof info.providerID !== 'string' || typeof info.modelID !== 'string') continue;
    model = {
      providerID: info.providerID,
      modelID: info.modelID,
    };
    if (typeof info.variant === 'string' && info.variant) model.variant = info.variant;
  }
  return model;
}

function summarizeSessionDuration(
  value: unknown
): Pick<SessionDiffSummary, 'durationMs' | 'activeStartedAt'> {
  if (!Array.isArray(value)) return { durationMs: 0, activeStartedAt: null };

  let total = 0;
  let promptStartedAt: number | null = null;
  let firstAssistantCreatedAt: number | null = null;
  let latestCompletedAt: number | null = null;
  let lastAssistantCompleted = false;

  const flush = () => {
    if (lastAssistantCompleted && latestCompletedAt !== null) {
      const startedAt = promptStartedAt ?? firstAssistantCreatedAt;
      if (startedAt !== null) total += Math.max(0, latestCompletedAt - startedAt);
    }
    promptStartedAt = null;
    firstAssistantCreatedAt = null;
    latestCompletedAt = null;
    lastAssistantCompleted = false;
  };

  for (const entry of value) {
    const info = asRecord(asRecord(entry)?.info);
    if (info?.role !== 'assistant') {
      flush();
      if (info?.role === 'user') promptStartedAt = readTimestamp(asRecord(info.time)?.created);
      continue;
    }
    if (info.mode === 'subagent') continue;

    const time = asRecord(info.time);
    firstAssistantCreatedAt ??= readTimestamp(time?.created);
    const completedAt = readTimestamp(time?.completed);
    lastAssistantCompleted = completedAt !== null;
    if (completedAt !== null) {
      latestCompletedAt = Math.max(latestCompletedAt ?? completedAt, completedAt);
    }
  }

  const activeStartedAt = lastAssistantCompleted
    ? null
    : (promptStartedAt ?? firstAssistantCreatedAt);
  flush();
  return { durationMs: total, activeStartedAt };
}

function readTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTokenCount(value: unknown): number {
  return isTokenCount(value) ? value : 0;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDiffRecord(value: Record<string, unknown>) {
  return (
    typeof value.file === 'string' ||
    isDiffLineCount(value.additions) ||
    isDiffLineCount(value.deletions) ||
    isDiffLineCount(value.added) ||
    isDiffLineCount(value.removed)
  );
}

function readDiffLineCount(primary: unknown, fallback: unknown) {
  if (isDiffLineCount(primary)) return primary;
  return isDiffLineCount(fallback) ? fallback : 0;
}

function isDiffLineCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export const sessionSummary = {
  fromLocal: summarizeLocalSession,
  fromRemote: summarizeRemoteSession,
  projectHistory: projectMessageHistory,
  omittedHistory: omittedMessageHistory,
};
