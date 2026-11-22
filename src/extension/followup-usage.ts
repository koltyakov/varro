import type {
  SessionInboxInfo,
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessagesResponse,
} from '@opencode/client';
import type {
  SessionFollowupUsage,
  SessionFollowupUsageInterval,
  SessionUsageTotals,
} from '../shared/protocol';
import { OpenCodeResponseTooLargeError } from './opencode-response-error';
import { isV2UserPrompt } from './opencode-v2-projection';

const FOLLOWUP_USAGE_PAGE_LIMIT = 200;
const FOLLOWUP_USAGE_MAX_PAGES = 10;
export const FOLLOWUP_USAGE_MAX_BYTES = 8 * 1024 * 1024;

export type FollowupUsageReader = {
  readInbox: () => Promise<SessionInboxInfo[]>;
  /** Reads one native page: newest first without a cursor, then older pages by cursor. */
  readPage: (cursor: string | undefined, limit: number) => Promise<SessionMessagesResponse>;
};

/**
 * Reads bounded native history newest first and summarizes it without returning bodies.
 * History beyond the record or byte bounds is reported as incomplete, never as zero usage.
 */
export async function readSessionFollowupUsage(
  reader: FollowupUsageReader,
  limits: { maxPages?: number; maxBytes?: number } = {}
): Promise<SessionFollowupUsage> {
  const maxPages = limits.maxPages ?? FOLLOWUP_USAGE_MAX_PAGES;
  const maxBytes = limits.maxBytes ?? FOLLOWUP_USAGE_MAX_BYTES;
  // Read pending inputs first so a delivery between the reads still appears in history.
  const inbox = await reader.readInbox();
  if (!Array.isArray(inbox)) throw new Error('Invalid OpenCode v2 session inbox');
  const pages: SessionMessageInfo[][] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  let complete = false;
  while (pages.length < maxPages) {
    let page: SessionMessagesResponse;
    try {
      page = await reader.readPage(cursor, FOLLOWUP_USAGE_PAGE_LIMIT);
    } catch (error) {
      // An oversized older page truncates history; newer pages already read stay valid.
      if (error instanceof OpenCodeResponseTooLargeError) break;
      throw error;
    }
    if (!Array.isArray(page?.data)) throw new Error('Invalid OpenCode v2 message page');
    // OpenCode returns a next cursor with every non-empty page, so only an empty page ends history.
    if (!page.data.length) {
      complete = true;
      break;
    }
    bytes += Buffer.byteLength(JSON.stringify(page.data));
    if (bytes > maxBytes) break;
    pages.push(page.data);
    cursor = page.cursor?.next ?? undefined;
    if (!cursor) {
      complete = true;
      break;
    }
    if (seen.has(cursor)) throw new Error('OpenCode repeated a message pagination cursor');
    seen.add(cursor);
  }
  const ordered = pages.flatMap((page) => page).toReversed();
  return summarizeFollowupUsage(ordered, {
    complete,
    pendingPromptIDs: inbox.flatMap((item) => (item.type === 'user' ? [item.id] : [])),
  });
}

/**
 * Groups chronological native records into intervals that start at delivered user prompts,
 * including described goal kickoffs. Persisted order is authoritative: IDs and timestamps do not
 * order deliveries. Only assistant steps count: compaction can be adopted from background
 * summarization started under an earlier prompt, so it stays in session totals only.
 */
export function summarizeFollowupUsage(
  records: readonly SessionMessageInfo[],
  options: { complete: boolean; pendingPromptIDs: string[] }
): SessionFollowupUsage {
  const intervals: SessionFollowupUsageInterval[] = [];
  const counted = new Set<string>();
  let current: { interval: SessionFollowupUsageInterval; stepped: boolean } | undefined;
  let leadingStep = false;
  for (const record of records) {
    if (isV2UserPrompt(record)) {
      if (current && !current.stepped) {
        current.interval.promptIDs.push(record.id);
        continue;
      }
      if (current) current.interval.final = true;
      const interval: SessionFollowupUsageInterval = {
        promptIDs: [record.id],
        usage: emptyUsage(),
        final: false,
      };
      // Without a model step before the oldest read prompt, unseen earlier prompts may share it.
      if (!options.complete && !intervals.length && !leadingStep) interval.boundaryUnknown = true;
      intervals.push(interval);
      current = { interval, stepped: false };
      continue;
    }
    if (record.type === 'idle') {
      // An execution ended, so its unfinished rows were abandoned rather than still running.
      for (const interval of intervals) {
        interval.usage.missing += interval.usage.active;
        interval.usage.active = 0;
      }
      continue;
    }
    if (record.type !== 'assistant') continue;
    if (!current) {
      leadingStep = true;
      continue;
    }
    current.stepped = true;
    // Retries reuse the same record, so each record counts once.
    if (counted.has(record.id)) continue;
    counted.add(record.id);
    addRecordUsage(current.interval.usage, record);
  }
  return {
    supported: true,
    complete: options.complete,
    intervals,
    pendingPromptIDs: options.pendingPromptIDs,
  };
}

function addRecordUsage(usage: SessionUsageTotals, record: SessionMessageAssistant) {
  const tokens = record.tokens;
  if (tokens) {
    usage.input += finite(tokens.input);
    usage.output += finite(tokens.output);
    usage.reasoning += finite(tokens.reasoning);
    usage.cacheRead += finite(tokens.cache?.read);
    usage.cacheWrite += finite(tokens.cache?.write);
    usage.cost += finite(record.cost);
    usage.steps += 1;
    return;
  }
  if (record.time.completed !== undefined || record.error !== undefined) usage.missing += 1;
  else usage.active += 1;
}

function emptyUsage(): SessionUsageTotals {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    steps: 0,
    missing: 0,
    active: 0,
  };
}

function finite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}
