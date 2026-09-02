/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Usage endpoint payloads are decoded before aggregation. */
/* oxlint-disable anti-slop/no-known-value-widening -- Query and aggregate values intentionally use their named service contracts. */
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';

import { resolveOpenCodeDataDirectory } from '../shared/opencode-data-directory';
import { asRecord } from '../shared/type-utils';
import type { OpenCodeServer } from './server';

type OpenCodeRequest = Pick<OpenCodeServer, 'request'>;

type Session = {
  id: string;
  directory: string;
  updated: number | null;
};

type Tokens = {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

type Usage = {
  providerID: string;
  modelID: string;
  promptID: string | null;
  created: number;
  durationMs: number | null;
  tokens: Tokens;
};

type Aggregate = Tokens & {
  promptIDs: Set<string>;
  durationMs: number;
  durationCount: number;
};

type ReportWindow = {
  title: string;
  start: number | null;
};

type CachedSessionUsage = {
  directory: string;
  updated: number;
  usage: Usage[];
};

type LocalUsageSnapshot = {
  sessionCount: number;
  usage: Usage[];
};

type LocalUsageReader = (start?: number) => Promise<LocalUsageSnapshot | null>;
type ReportDocumentOpener = (content: string, title: string) => Promise<vscode.Uri>;
type WindowAggregates = { window: ReportWindow; groups: Map<string, Aggregate> };

const SESSION_PAGE_LIMIT = 1_000;
const SESSION_CONCURRENCY = 8;
const SESSION_HISTORY_MAX_BYTES = 256 * 1024 * 1024;
const SESSION_USAGE_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_USAGE_CACHE_LIMIT = 500;
const SESSION_USAGE_CACHE_ENTRY_LIMIT = 10_000;
const SESSION_USAGE_CACHE_TOTAL_LIMIT = 50_000;
const LOCAL_USAGE_WORKER_TIMEOUT_MS = 30_000;
const LOCAL_USAGE_DATABASE_MAX_BYTES = 512 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export class UsageReportService {
  private readonly sessionUsageCache = new Map<string, CachedSessionUsage>();
  private sessionUsageCacheEntries = 0;

  constructor(
    private readonly server: OpenCodeRequest,
    private readonly ensureServerStarted: () => Promise<unknown>,
    private readonly readLocalUsage: LocalUsageReader | null = readLocalUsageDatabase,
    private readonly openDocument: ReportDocumentOpener = openAnonymousReportDocument
  ) {}

  async openReport(includeAllTime = false): Promise<void> {
    try {
      const content = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Building OpenCode usage report',
          cancellable: false,
        },
        async () => {
          await this.ensureServerStarted();
          return this.buildReport(includeAllTime);
        }
      );
      const uri = await this.openDocument(content, 'OpenCode Usage Report');
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch (error) {
      const message = errorMessage(error);
      await vscode.window.showErrorMessage(`Could not build OpenCode usage report: ${message}`);
      throw error;
    }
  }

  private async buildReport(includeAllTime: boolean): Promise<string> {
    const warnings: string[] = [];
    const now = Date.now();
    const start = includeAllTime ? undefined : now - 30 * DAY_MS;
    const local = await this.readLocalUsage?.(start);
    if (local) {
      this.sessionUsageCache.clear();
      this.sessionUsageCacheEntries = 0;
      return renderReport(local.usage, local.sessionCount, warnings, now, includeAllTime);
    }

    const sessions = await this.listSessions(warnings, start);
    const sessionIDs = new Set(sessions.map((session) => session.id));
    for (const id of this.sessionUsageCache.keys()) {
      if (sessionIDs.has(id)) continue;
      this.sessionUsageCacheEntries -= this.sessionUsageCache.get(id)?.usage.length ?? 0;
      this.sessionUsageCache.delete(id);
    }

    const aggregates = createWindowAggregates(now, includeAllTime);
    await mapConcurrent(sessions, SESSION_CONCURRENCY, async (session) => {
      addUsageToWindowAggregates(aggregates, await this.readSessionUsage(session, warnings));
    });
    return renderAggregatedReport(aggregates, sessions.length, warnings, now);
  }

  private async listSessions(warnings: string[], start?: number): Promise<Session[]> {
    const sessions = new Map<string, Session>();
    const cursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const query: Record<string, string> = {
        archived: 'true',
        limit: String(SESSION_PAGE_LIMIT),
      };
      if (start !== undefined) query.start = String(start);
      if (cursor) query.cursor = cursor;
      const path = withQuery('/experimental/session', query);
      let response: unknown;
      try {
        response = await this.server.request('GET', path, undefined, {
          unscoped: true,
          captureNextCursor: true,
        });
      } catch (error) {
        throw new Error(`Failed to list retained OpenCode sessions: ${errorMessage(error)}`, {
          cause: error,
        });
      }
      const page = responsePage(response);
      if (!page) throw new Error('OpenCode returned a malformed global session list.');

      for (const value of page.data) {
        const record = asRecord(value);
        const id = stringValue(record?.id);
        const directory = stringValue(record?.directory);
        if (!id || !directory) {
          warnings.push('Ignored a malformed session without an id or directory.');
          continue;
        }
        if (!sessions.has(id)) {
          sessions.set(id, {
            id,
            directory,
            updated: numberValue(asRecord(record?.time)?.updated),
          });
        }
      }

      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) {
        warnings.push(`Stopped session pagination because OpenCode repeated cursor ${cursor}.`);
        break;
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);

    return [...sessions.values()];
  }

  private async readSessionUsage(session: Session, warnings: string[]): Promise<Usage[]> {
    const cached = this.sessionUsageCache.get(session.id);
    if (
      session.updated !== null &&
      cached?.updated === session.updated &&
      cached.directory === session.directory
    ) {
      this.sessionUsageCache.delete(session.id);
      this.sessionUsageCache.set(session.id, cached);
      return cached.usage;
    }

    try {
      const path = scopedPath(
        `/session/${encodeURIComponent(session.id)}/message`,
        session.directory
      );
      const response = await this.server.request('GET', path, undefined, {
        maxResponseBytes: SESSION_HISTORY_MAX_BYTES,
        maxProjectedResponseBytes: SESSION_USAGE_MAX_BYTES,
        stripMessageParts: true,
        stripSummaryDiffs: true,
      });
      const messages = Array.isArray(response) ? response : asRecord(response)?.data;
      if (!Array.isArray(messages)) {
        warnings.push(`Ignored malformed message history for session ${session.id}.`);
        return [];
      }

      const usage: Usage[] = [];
      const messageIDs = new Set<string>();
      for (const value of messages) {
        const entry = normalizeUsage(value, session, warnings);
        if (!entry || messageIDs.has(entry.id)) continue;
        messageIDs.add(entry.id);
        usage.push(entry.usage);
      }
      if (session.updated !== null) {
        this.cacheSessionUsage(session, usage);
      }
      return usage;
    } catch (error) {
      warnings.push(`Could not read messages for session ${session.id}: ${errorMessage(error)}.`);
      return [];
    }
  }

  private cacheSessionUsage(session: Session, usage: Usage[]): void {
    if (session.updated === null) return;
    const previous = this.sessionUsageCache.get(session.id);
    if (previous) {
      this.sessionUsageCacheEntries -= previous.usage.length;
      this.sessionUsageCache.delete(session.id);
    }
    if (usage.length > SESSION_USAGE_CACHE_ENTRY_LIMIT) return;
    this.sessionUsageCache.set(session.id, {
      directory: session.directory,
      updated: session.updated,
      usage,
    });
    this.sessionUsageCacheEntries += usage.length;
    while (
      this.sessionUsageCache.size > SESSION_USAGE_CACHE_LIMIT ||
      this.sessionUsageCacheEntries > SESSION_USAGE_CACHE_TOTAL_LIMIT
    ) {
      const oldestID = this.sessionUsageCache.keys().next().value;
      if (oldestID === undefined) break;
      const oldest = this.sessionUsageCache.get(oldestID);
      this.sessionUsageCache.delete(oldestID);
      this.sessionUsageCacheEntries -= oldest?.usage.length ?? 0;
    }
  }
}

async function openAnonymousReportDocument(content: string): Promise<vscode.Uri> {
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content,
  });
  await vscode.window.showTextDocument(document, { preview: false });
  return document.uri;
}

async function readLocalUsageDatabase(start?: number): Promise<LocalUsageSnapshot | null> {
  const databasePath = join(resolveOpenCodeDataDirectory(), 'opencode.db');

  return new Promise((resolve) => {
    const worker = new Worker(LOCAL_USAGE_WORKER, {
      eval: true,
      workerData: { databasePath, start: start ?? null },
    });
    let settled = false;
    const finish = (result: LocalUsageSnapshot | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate().catch(() => {});
      resolve(result);
    };
    const timeout = setTimeout(() => finish(null), LOCAL_USAGE_WORKER_TIMEOUT_MS);
    worker.once('message', (value: unknown) => finish(normalizeLocalUsageSnapshot(value)));
    worker.once('error', () => finish(null));
    worker.once('exit', () => finish(null));
  });
}

const LOCAL_USAGE_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');

try {
  if (statSync(workerData.databasePath).size > ${LOCAL_USAGE_DATABASE_MAX_BYTES}) {
    throw new Error('database exceeds local usage scan limit');
  }
  const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
  const sessionCount = database
    .prepare('SELECT count(*) AS count FROM session WHERE ? IS NULL OR time_updated >= ?')
    .get(workerData.start, workerData.start).count;
  const query = [
    'SELECT m.id, m.session_id AS sessionID,',
    "json_extract(m.data, '$.providerID') AS providerID,",
    "json_extract(m.data, '$.model.providerID') AS nestedProviderID,",
    "json_extract(m.data, '$.modelID') AS modelID,",
    "json_extract(m.data, '$.model.modelID') AS nestedModelID,",
    "json_extract(m.data, '$.parentID') AS parentID,",
    "json_extract(m.data, '$.time.created') AS timeCreated,",
    "json_extract(m.data, '$.time.completed') AS timeCompleted,",
    "coalesce(json_extract(m.data, '$.time.completed'), json_extract(m.data, '$.time.created')) AS created,",
    "json_extract(m.data, '$.tokens.total') AS total,",
    "json_extract(m.data, '$.tokens.input') AS input,",
    "json_extract(m.data, '$.tokens.output') AS output,",
    "json_extract(m.data, '$.tokens.reasoning') AS reasoning,",
    "json_extract(m.data, '$.tokens.cache.read') AS cacheRead,",
    "json_extract(m.data, '$.tokens.cache.write') AS cacheWrite",
    'FROM message m WHERE (? IS NULL OR m.time_created >= ?)',
    "AND json_extract(m.data, '$.role') = 'assistant'",
  ].join(' ');
  const rows = database.prepare(query).all(workerData.start, workerData.start);
  database.close();
  parentPort.postMessage({ sessionCount: Number(sessionCount), rows });
} catch {
  parentPort.postMessage(null);
}
`;

function normalizeLocalUsageSnapshot(value: unknown): LocalUsageSnapshot | null {
  const snapshot = asRecord(value);
  const sessionCount = numberValue(snapshot?.sessionCount);
  if (sessionCount === null || !Array.isArray(snapshot?.rows)) return null;

  const usage: Usage[] = [];
  for (const rawRow of snapshot.rows) {
    const row = asRecord(rawRow);
    const sessionID = stringValue(row?.sessionID);
    const providerID = stringValue(row?.providerID) || stringValue(row?.nestedProviderID);
    const modelID = stringValue(row?.modelID) || stringValue(row?.nestedModelID);
    const parentID = stringValue(row?.parentID);
    const created = numberValue(row?.created);
    if (!sessionID || !providerID || !modelID || created === null) continue;

    const input = nonnegativeNumber(row?.input);
    const output = nonnegativeNumber(row?.output);
    const reasoning = nonnegativeNumber(row?.reasoning);
    const cacheRead = nonnegativeNumber(row?.cacheRead);
    const cacheWrite = nonnegativeNumber(row?.cacheWrite);
    usage.push({
      providerID,
      modelID,
      promptID: parentID ? `${sessionID}\u0000${parentID}` : null,
      created,
      durationMs: assistantDuration(row?.timeCreated, row?.timeCompleted),
      tokens: {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total:
          optionalNonnegativeNumber(row?.total) ??
          input + output + reasoning + cacheRead + cacheWrite,
      },
    });
  }
  return { sessionCount, usage };
}

function normalizeUsage(
  value: unknown,
  session: Session,
  warnings: string[]
): { id: string; usage: Usage } | null {
  const record = asRecord(value);
  const info = asRecord(record?.info);
  if (info?.role !== 'assistant') return null;

  const id = stringValue(info.id);
  const providerID = stringValue(info.providerID) || stringValue(asRecord(info.model)?.providerID);
  const modelID = stringValue(info.modelID) || stringValue(asRecord(info.model)?.modelID);
  const parentID = stringValue(info.parentID);
  const time = asRecord(info.time);
  const created = numberValue(time?.completed) ?? numberValue(time?.created);
  if (!id || !providerID || !modelID || created === null) {
    warnings.push(`Ignored malformed assistant usage in session ${session.id}.`);
    return null;
  }

  const rawTokens = asRecord(info.tokens);
  const cache = asRecord(rawTokens?.cache);
  const input = nonnegativeNumber(rawTokens?.input);
  const output = nonnegativeNumber(rawTokens?.output);
  const reasoning = nonnegativeNumber(rawTokens?.reasoning);
  const cacheRead = nonnegativeNumber(cache?.read);
  const cacheWrite = nonnegativeNumber(cache?.write);
  const suppliedTotal = optionalNonnegativeNumber(rawTokens?.total);

  return {
    id,
    usage: {
      providerID,
      modelID,
      promptID: parentID ? `${session.id}\u0000${parentID}` : null,
      created,
      durationMs: assistantDuration(time?.created, time?.completed),
      tokens: {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total: suppliedTotal ?? input + output + reasoning + cacheRead + cacheWrite,
      },
    },
  };
}

function renderReport(
  usage: Usage[],
  sessionCount: number,
  warnings: string[],
  now: number,
  includeAllTime: boolean
): string {
  const aggregates = createWindowAggregates(now, includeAllTime);
  addUsageToWindowAggregates(aggregates, usage);
  return renderAggregatedReport(aggregates, sessionCount, warnings, now);
}

function createWindowAggregates(now: number, includeAllTime: boolean): WindowAggregates[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return [
    { title: 'Today', start: midnight.getTime() },
    { title: 'Last 7 rolling days', start: now - 7 * DAY_MS },
    { title: 'Last 30 rolling days', start: now - 30 * DAY_MS },
    ...(includeAllTime ? [{ title: 'All time', start: null }] : []),
  ].map((window) => ({ window, groups: new Map() }));
}

function addUsageToWindowAggregates(aggregates: WindowAggregates[], usage: Usage[]): void {
  for (const entry of usage) {
    if (entry.tokens.total <= 0) continue;
    for (const aggregate of aggregates) {
      if (aggregate.window.start !== null && entry.created < aggregate.window.start) continue;
      addUsageToAggregateGroup(aggregate.groups, entry);
    }
  }
}

function addUsageToAggregateGroup(groups: Map<string, Aggregate>, entry: Usage): void {
  const key = routeKey(entry.providerID, entry.modelID);
  const aggregate = groups.get(key) || emptyAggregate();
  if (entry.promptID) aggregate.promptIDs.add(entry.promptID);
  if (entry.durationMs !== null) {
    aggregate.durationMs += entry.durationMs;
    aggregate.durationCount += 1;
  }
  addTokens(aggregate, entry.tokens);
  groups.set(key, aggregate);
}

function renderAggregatedReport(
  aggregates: WindowAggregates[],
  sessionCount: number,
  warnings: string[],
  now: number
): string {
  const lines = [
    '# OpenCode Usage Report',
    '',
    `Generated ${new Date(now).toLocaleString()} from ${sessionCount.toLocaleString()} sessions scanned.`,
  ];

  for (const aggregate of aggregates) {
    lines.push('', `## ${aggregate.window.title}`, '');
    if (aggregate.groups.size === 0) {
      lines.push('_No token usage._');
      continue;
    }
    renderAggregateTable(lines, aggregate.groups);
  }

  if (warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of new Set(warnings)) lines.push(`- ${escapeMarkdown(warning)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderAggregateTable(lines: string[], groups: Map<string, Aggregate>): void {
  lines.push(
    '| Provider | Model | Prompts | Total | Duration | Input | Output | Reasoning | Cache read | Cache write |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  );
  for (const [route, aggregate] of [...groups].toSorted(
    ([leftRoute, left], [rightRoute, right]) =>
      right.promptIDs.size - left.promptIDs.size ||
      right.total - left.total ||
      leftRoute.localeCompare(rightRoute)
  )) {
    const [providerID = '', modelID = ''] = route.split('\u0000');
    lines.push(renderAggregateRow(providerID, modelID, aggregate));
  }
  lines.push(renderAggregateRow('**Total**', '', sumAggregates(groups.values())));
}

function sumAggregates(values: Iterable<Aggregate>): Aggregate {
  const total = emptyAggregate();
  for (const value of values) {
    for (const promptID of value.promptIDs) total.promptIDs.add(promptID);
    total.durationMs += value.durationMs;
    total.durationCount += value.durationCount;
    addTokens(total, value);
  }
  return total;
}

function emptyAggregate(): Aggregate {
  return {
    promptIDs: new Set(),
    durationMs: 0,
    durationCount: 0,
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function addTokens(target: Tokens, tokens: Tokens): void {
  target.total += tokens.total;
  target.input += tokens.input;
  target.output += tokens.output;
  target.reasoning += tokens.reasoning;
  target.cacheRead += tokens.cacheRead;
  target.cacheWrite += tokens.cacheWrite;
}

function renderAggregateRow(providerID: string, modelID: string, aggregate: Aggregate): string {
  return `| ${escapeMarkdown(providerID)} | ${escapeMarkdown(modelID)} | ${integer(aggregate.promptIDs.size)} | ${integer(aggregate.total)} | ${formatAggregateDuration(aggregate)} | ${integer(aggregate.input)} | ${integer(aggregate.output)} | ${integer(aggregate.reasoning)} | ${integer(aggregate.cacheRead)} | ${integer(aggregate.cacheWrite)} |`;
}

interface ResponsePage {
  data: unknown[];
  nextCursor?: string;
}

function responsePage(value: unknown): ResponsePage | null {
  if (Array.isArray(value)) return { data: value };
  const record = asRecord(value);
  if (!Array.isArray(record?.data)) return null;
  const nextCursor = stringValue(record.nextCursor);
  const page: ResponsePage = { data: record.data };
  if (nextCursor) page.nextCursor = nextCursor;
  return page;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await callback(values[index]!);
      }
    })
  );
  return results;
}

function withQuery(path: string, values: Record<string, string>): string {
  const query = new URLSearchParams(values);
  return `${path}?${query.toString()}`;
}

function scopedPath(path: string, directory: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(directory)}`;
}

function routeKey(providerID: string, modelID: string): string {
  return `${providerID}\u0000${modelID}`;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalNonnegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nonnegativeNumber(value: unknown): number {
  return optionalNonnegativeNumber(value) ?? 0;
}

function assistantDuration(created: unknown, completed: unknown): number | null {
  const start = numberValue(created);
  const end = numberValue(completed);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function formatAggregateDuration(aggregate: Aggregate): string {
  if (aggregate.durationCount === 0) return '-';
  if (aggregate.durationMs < 1_000) return '<1s';

  const totalSeconds = Math.round(aggregate.durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;

  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
}

function integer(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500) || 'Unknown error';
}
