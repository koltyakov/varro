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
  promptCount?: number;
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

type LocalUsageSnapshot =
  | { sessionCount: number; usage: Usage[] }
  | { aggregates: WindowAggregates[]; sessionCount: number };

type LocalUsageReader = (
  start?: number,
  now?: number,
  includeAllTime?: boolean
) => Promise<LocalUsageSnapshot | null>;
type ReportDocumentOpener = (content: string, title: string) => Promise<vscode.Uri>;
type WindowAggregates = {
  window: ReportWindow;
  groups: Map<string, Aggregate>;
  totalPromptCount?: number;
};

const SESSION_PAGE_LIMIT = 1_000;
const SESSION_CONCURRENCY = 8;
const SESSION_HISTORY_MAX_BYTES = 256 * 1024 * 1024;
const SESSION_USAGE_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_USAGE_CACHE_LIMIT = 500;
const SESSION_USAGE_CACHE_ENTRY_LIMIT = 10_000;
const SESSION_USAGE_CACHE_TOTAL_LIMIT = 50_000;
const SESSION_FALLBACK_MAX_SESSIONS = 250;
const LOCAL_USAGE_WORKER_TIMEOUT_MS = 30_000;
const LOCAL_USAGE_MAX_ASSISTANT_ROWS = 250_000;
const LOCAL_USAGE_MAX_SCANNED_ASSISTANT_ROWS = 1_000_000;
const LOCAL_USAGE_MAX_ROUTES = 4_096;
const LOCAL_USAGE_MAX_MESSAGE_DATA_BYTES = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export class UsageReportService {
  private readonly sessionUsageCache = new Map<string, CachedSessionUsage>();
  private sessionUsageCacheEntries = 0;
  private reportOperation: { includeAllTime: boolean; promise: Promise<void> } | null = null;

  constructor(
    private readonly server: OpenCodeRequest,
    private readonly ensureServerStarted: () => Promise<unknown>,
    private readonly readLocalUsage: LocalUsageReader | null = readLocalUsageDatabase,
    private readonly openDocument: ReportDocumentOpener = openAnonymousReportDocument
  ) {}

  openReport(includeAllTime = false): Promise<void> {
    const current = this.reportOperation;
    if (current) {
      if (current.includeAllTime === includeAllTime) return current.promise;
      return current.promise.then(
        () => this.openReport(includeAllTime),
        () => this.openReport(includeAllTime)
      );
    }
    const promise = this.openReportNow(includeAllTime);
    this.reportOperation = { includeAllTime, promise };
    const finish = () => {
      if (this.reportOperation?.promise === promise) this.reportOperation = null;
    };
    void promise.then(finish, finish);
    return promise;
  }

  private async openReportNow(includeAllTime: boolean): Promise<void> {
    try {
      const content = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Building OpenCode usage report',
          cancellable: false,
        },
        () => this.buildReport(includeAllTime)
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
    const local = await this.readLocalUsage?.(start, now, includeAllTime);
    if (local) {
      this.sessionUsageCache.clear();
      this.sessionUsageCacheEntries = 0;
      return 'aggregates' in local
        ? renderAggregatedReport(local.aggregates, local.sessionCount, warnings, now)
        : renderReport(local.usage, local.sessionCount, warnings, now, includeAllTime);
    }

    await this.ensureServerStarted();
    const sessions = await this.listSessions(warnings, start);
    if (sessions.length > SESSION_FALLBACK_MAX_SESSIONS) {
      throw new Error(
        `The local OpenCode usage database is unavailable. Refusing to fetch full history for ${sessions.length.toLocaleString()} sessions.`
      );
    }
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
          if (sessions.size > SESSION_FALLBACK_MAX_SESSIONS) return [...sessions.values()];
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

async function readLocalUsageDatabase(
  start?: number,
  now = Date.now(),
  includeAllTime = false
): Promise<LocalUsageSnapshot | null> {
  const databasePath = join(resolveOpenCodeDataDirectory(), 'opencode.db');
  const windows = createReportWindows(now, includeAllTime);

  return new Promise((resolve, reject) => {
    const worker = new Worker(LOCAL_USAGE_WORKER, {
      eval: true,
      workerData: {
        databasePath,
        maxAssistantRows: LOCAL_USAGE_MAX_ASSISTANT_ROWS,
        maxMessageDataBytes: LOCAL_USAGE_MAX_MESSAGE_DATA_BYTES,
        maxRoutes: LOCAL_USAGE_MAX_ROUTES,
        maxScannedAssistantRows: LOCAL_USAGE_MAX_SCANNED_ASSISTANT_ROWS,
        start: start ?? null,
        windows,
      },
    });
    let settled = false;
    const finish = (result: LocalUsageSnapshot | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker
        .terminate()
        .catch(() => 0)
        .then(() => {
          if (error) reject(error);
          else resolve(result);
        });
    };
    const timeout = setTimeout(
      () =>
        finish(
          null,
          new Error(
            `Local OpenCode usage query timed out after ${LOCAL_USAGE_WORKER_TIMEOUT_MS / 1_000} seconds.`
          )
        ),
      LOCAL_USAGE_WORKER_TIMEOUT_MS
    );
    worker.once('message', (value: unknown) => {
      if (value === null) {
        finish(null);
        return;
      }
      const workerMessage = asRecord(value);
      const workerError = stringValue(workerMessage?.error);
      if (workerError) {
        finish(null, new Error(`Local OpenCode usage query failed: ${workerError}`));
        return;
      }
      const snapshot = normalizeLocalUsageSnapshot(value, windows);
      finish(
        snapshot,
        snapshot ? undefined : new Error('Local OpenCode usage query returned malformed data.')
      );
    });
    worker.once('error', (error) =>
      finish(null, new Error(`Local OpenCode usage worker failed: ${errorMessage(error)}`))
    );
    worker.once('exit', (code) => {
      if (code !== 0) {
        finish(null, new Error(`Local OpenCode usage worker exited with code ${code}.`));
      }
    });
  });
}

const LOCAL_USAGE_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { existsSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');

const optionalNonnegativeNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const nonnegativeNumber = (value) => optionalNonnegativeNumber(value) ?? 0;
const numberValue = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const stringValue = (value) =>
  typeof value === 'string' && value.length <= 512 && value.trim() ? value.trim() : null;
const emptyAggregate = () => ({
  promptIDs: new Set(),
  durationMs: 0,
  durationCount: 0,
  total: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

try {
  if (!existsSync(workerData.databasePath)) {
    parentPort.postMessage(null);
  } else {
    const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
    try {
      const sessionCount = workerData.start === null
        ? database.prepare('SELECT count(*) AS count FROM session').get().count
        : database.prepare('SELECT count(*) AS count FROM session WHERE time_updated >= ?')
            .get(workerData.start).count;
      const query = [
        'SELECT m.session_id AS sessionID,',
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
        'FROM message m',
        workerData.start === null
          ? "WHERE length(m.data) <= ? AND json_extract(m.data, '$.role') = 'assistant'"
          : "WHERE m.session_id IN (SELECT id FROM session WHERE time_updated >= ?) AND length(m.data) <= ? AND json_extract(m.data, '$.role') = 'assistant'",
        'LIMIT ?',
      ].join(' ');
      const statement = database.prepare(query);
      const rows = workerData.start === null
        ? statement.iterate(workerData.maxMessageDataBytes, workerData.maxScannedAssistantRows + 1)
        : statement.iterate(workerData.start, workerData.maxMessageDataBytes, workerData.maxScannedAssistantRows + 1);
      const aggregates = workerData.windows.map(() => ({
        groups: new Map(),
        promptIDs: new Set(),
      }));
      const routes = new Set();
      let assistantRows = 0;
      let scannedAssistantRows = 0;
      const oldestWindowStart = workerData.windows.some((window) => window.start === null)
        ? null
        : Math.min(...workerData.windows.map((window) => window.start));

      for (const row of rows) {
        scannedAssistantRows += 1;
        if (scannedAssistantRows > workerData.maxScannedAssistantRows) {
          throw new Error('Usage report exceeds the ' + workerData.maxScannedAssistantRows.toLocaleString() + '-message local scan limit.');
        }
        const created = numberValue(row.created);
        if (created === null || (oldestWindowStart !== null && created < oldestWindowStart)) continue;
        assistantRows += 1;
        if (assistantRows > workerData.maxAssistantRows) {
          throw new Error('Usage report exceeds the ' + workerData.maxAssistantRows.toLocaleString() + '-message local aggregation limit.');
        }
        const sessionID = stringValue(row.sessionID);
        const providerID = stringValue(row.providerID) || stringValue(row.nestedProviderID);
        const modelID = stringValue(row.modelID) || stringValue(row.nestedModelID);
        const parentID = stringValue(row.parentID);
        if (!sessionID || !providerID || !modelID) continue;

        const input = nonnegativeNumber(row.input);
        const output = nonnegativeNumber(row.output);
        const reasoning = nonnegativeNumber(row.reasoning);
        const cacheRead = nonnegativeNumber(row.cacheRead);
        const cacheWrite = nonnegativeNumber(row.cacheWrite);
        const total = optionalNonnegativeNumber(row.total) ??
          input + output + reasoning + cacheRead + cacheWrite;
        if (total <= 0) continue;
        const timeCreated = numberValue(row.timeCreated);
        const timeCompleted = numberValue(row.timeCompleted);
        const duration = timeCreated !== null && timeCompleted !== null && timeCompleted >= timeCreated
          ? timeCompleted - timeCreated
          : null;
        const promptID = parentID ? sessionID + '\u0000' + parentID : null;
        const route = providerID + '\u0000' + modelID;
        if (!routes.has(route)) {
          if (routes.size >= workerData.maxRoutes) {
            throw new Error('Usage report exceeds the ' + workerData.maxRoutes.toLocaleString() + '-route local aggregation limit.');
          }
          routes.add(route);
        }

        for (let index = 0; index < workerData.windows.length; index += 1) {
          const window = workerData.windows[index];
          if (window.start !== null && created < window.start) continue;
          const windowAggregate = aggregates[index];
          const aggregate = windowAggregate.groups.get(route) || emptyAggregate();
          if (promptID) {
            aggregate.promptIDs.add(promptID);
            windowAggregate.promptIDs.add(promptID);
          }
          if (duration !== null) {
            aggregate.durationMs += duration;
            aggregate.durationCount += 1;
          }
          aggregate.total += total;
          aggregate.input += input;
          aggregate.output += output;
          aggregate.reasoning += reasoning;
          aggregate.cacheRead += cacheRead;
          aggregate.cacheWrite += cacheWrite;
          windowAggregate.groups.set(route, aggregate);
        }
      }

      parentPort.postMessage({
        sessionCount: Number(sessionCount),
        windows: aggregates.map((windowAggregate) => ({
          totalPromptCount: windowAggregate.promptIDs.size,
          groups: [...windowAggregate.groups.entries()].map(([route, aggregate]) => {
            const separator = route.indexOf('\u0000');
            return {
              providerID: route.slice(0, separator),
              modelID: route.slice(separator + 1),
              prompts: aggregate.promptIDs.size,
              durationMs: aggregate.durationMs,
              durationCount: aggregate.durationCount,
              total: aggregate.total,
              input: aggregate.input,
              output: aggregate.output,
              reasoning: aggregate.reasoning,
              cacheRead: aggregate.cacheRead,
              cacheWrite: aggregate.cacheWrite,
            };
          }),
        })),
      });
    } finally {
      database.close();
    }
  }
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
`;

function normalizeLocalUsageSnapshot(
  value: unknown,
  windows: ReportWindow[]
): LocalUsageSnapshot | null {
  const snapshot = asRecord(value);
  const sessionCount = numberValue(snapshot?.sessionCount);
  if (
    sessionCount === null ||
    !Number.isSafeInteger(sessionCount) ||
    sessionCount < 0 ||
    !Array.isArray(snapshot?.windows) ||
    snapshot.windows.length !== windows.length
  ) {
    return null;
  }

  const aggregates: WindowAggregates[] = [];
  for (let index = 0; index < windows.length; index += 1) {
    const rawWindow = asRecord(snapshot.windows[index]);
    const totalPromptCount = nonnegativeInteger(rawWindow?.totalPromptCount);
    if (totalPromptCount === null || !Array.isArray(rawWindow?.groups)) return null;
    const groups = new Map<string, Aggregate>();
    for (const rawGroup of rawWindow.groups) {
      const group = asRecord(rawGroup);
      const providerID = stringValue(group?.providerID);
      const modelID = stringValue(group?.modelID);
      const promptCount = nonnegativeInteger(group?.prompts);
      const durationCount = nonnegativeInteger(group?.durationCount);
      const durationMs = nonnegativeNumber(group?.durationMs);
      if (!providerID || !modelID || promptCount === null || durationCount === null) return null;
      const aggregate: Aggregate = {
        promptIDs: new Set(),
        promptCount,
        durationMs,
        durationCount,
        total: nonnegativeNumber(group?.total),
        input: nonnegativeNumber(group?.input),
        output: nonnegativeNumber(group?.output),
        reasoning: nonnegativeNumber(group?.reasoning),
        cacheRead: nonnegativeNumber(group?.cacheRead),
        cacheWrite: nonnegativeNumber(group?.cacheWrite),
      };
      groups.set(routeKey(providerID, modelID), aggregate);
    }
    aggregates.push({ window: windows[index]!, groups, totalPromptCount });
  }
  return { sessionCount, aggregates };
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
  return createReportWindows(now, includeAllTime).map((window) => ({
    window,
    groups: new Map(),
  }));
}

function createReportWindows(now: number, includeAllTime: boolean): ReportWindow[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return [
    { title: 'Today', start: midnight.getTime() },
    { title: 'Last 7 rolling days', start: now - 7 * DAY_MS },
    { title: 'Last 30 rolling days', start: now - 30 * DAY_MS },
    ...(includeAllTime ? [{ title: 'All time', start: null }] : []),
  ];
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
    renderAggregateTable(lines, aggregate.groups, aggregate.totalPromptCount);
  }

  if (warnings.length > 0) {
    lines.push('', '## Warnings', '');
    for (const warning of new Set(warnings)) lines.push(`- ${escapeMarkdown(warning)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderAggregateTable(
  lines: string[],
  groups: Map<string, Aggregate>,
  totalPromptCount?: number
): void {
  lines.push(
    '| Provider | Model | Prompts | Total | Duration | Input | Output | Reasoning | Cache read | Cache write |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  );
  for (const [route, aggregate] of [...groups].toSorted(
    ([leftRoute, left], [rightRoute, right]) =>
      aggregatePromptCount(right) - aggregatePromptCount(left) ||
      right.total - left.total ||
      leftRoute.localeCompare(rightRoute)
  )) {
    const [providerID = '', modelID = ''] = route.split('\u0000');
    lines.push(renderAggregateRow(providerID, modelID, aggregate));
  }
  lines.push(renderAggregateRow('**Total**', '', sumAggregates(groups.values(), totalPromptCount)));
}

function sumAggregates(values: Iterable<Aggregate>, promptCount?: number): Aggregate {
  const total = emptyAggregate();
  for (const value of values) {
    for (const promptID of value.promptIDs) total.promptIDs.add(promptID);
    total.durationMs += value.durationMs;
    total.durationCount += value.durationCount;
    addTokens(total, value);
  }
  if (promptCount !== undefined) total.promptCount = promptCount;
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
  return `| ${escapeMarkdown(providerID)} | ${escapeMarkdown(modelID)} | ${integer(aggregatePromptCount(aggregate))} | ${integer(aggregate.total)} | ${formatAggregateDuration(aggregate)} | ${integer(aggregate.input)} | ${integer(aggregate.output)} | ${integer(aggregate.reasoning)} | ${integer(aggregate.cacheRead)} | ${integer(aggregate.cacheWrite)} |`;
}

function aggregatePromptCount(aggregate: Aggregate): number {
  return aggregate.promptCount ?? aggregate.promptIDs.size;
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

function nonnegativeInteger(value: unknown): number | null {
  const parsed = optionalNonnegativeNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) ? parsed : null;
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
