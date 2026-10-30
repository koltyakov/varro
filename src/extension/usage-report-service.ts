/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Usage endpoint payloads are decoded before aggregation. */
/* oxlint-disable anti-slop/no-known-value-widening -- Query and aggregate values intentionally use their named service contracts. */
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';

import { asRecord } from '../shared/type-utils';
import { isSameWorkspacePath } from '../shared/workspace-path';
import { pauseCompletedAt, readSessionPauses } from '../shared/session-pauses';
import type { SessionPauseBoundary } from '../shared/session-pauses';
import type { OpenCodeServer } from './server';
import { getVarroStateReadDirectory } from './varro-state-paths';
import { usageDatabasePaths } from './usage-database-paths';
import { sessionTranscriptArchivePath } from './session-transcript-archive';
import { acquireFileLock } from './file-lock';
import { ORIGINAL_USAGE_TIMING_WORKER } from './usage-original-timing';
import type { OriginalUsageTiming } from './usage-original-timing';

export type UsageArchiveSession = {
  id: string;
  directory: string;
  updated: number;
  version?: 1 | 2;
  directories?: string[];
};

export type LegacyCleanupSession = UsageArchiveSession & {
  version: 1;
  parentID?: string;
  title: string;
  created: number;
};

export async function readLegacyCleanupSessions(
  v2: UsageArchiveSession[]
): Promise<LegacyCleanupSession[]> {
  const result = await runLocalUsageWorker({ legacyInventory: v2 });
  if (!Array.isArray(result)) throw new Error('Malformed legacy cleanup inventory.');
  return result.map((value: unknown) => {
    const row = asRecord(value);
    const id = stringValue(row?.id),
      directory = stringValue(row?.directory);
    const updated = nonnegativeInteger(row?.updated),
      created = nonnegativeInteger(row?.created);
    if (
      !id ||
      !/^[a-zA-Z0-9_-]{1,256}$/.test(id) ||
      !directory ||
      !isAbsolute(directory) ||
      updated === null ||
      created === null ||
      typeof row?.title !== 'string' ||
      (row.parentID !== undefined && typeof row.parentID !== 'string')
    )
      throw new Error('Malformed legacy cleanup session.');
    return {
      id,
      directory,
      updated,
      created,
      title: row.title,
      parentID: row.parentID,
      version: 1,
    };
  });
}

/** Caller must hold the cleanup lock and the verified server's offline maintenance boundary. */
export async function cleanupLegacySessionRecords(
  sessions: LegacyCleanupSession[],
  cutoff: number,
  options: {
    prepared: () => Promise<void>;
    committing: () => void;
    onProgress: (message: string) => void;
    signal: AbortSignal;
  }
): Promise<number> {
  const result = asRecord(
    await runLocalUsageWorker(
      { legacySessions: sessions, legacyCutoff: cutoff, start: null, windows: [] },
      options.onProgress,
      options.signal,
      options
    )
  );
  if (result?.deleted !== sessions.length)
    throw new Error('Legacy deletion did not acknowledge every session.');
  return sessions.length;
}

/** Explicit opt-in only. Reads live history; writes scalar provenance to the statistics sidecar. */
export async function preserveOriginalUsageTiming(
  sessions: UsageArchiveSession[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<{ sessions: number; messages: number }> {
  signal?.throwIfAborted();
  const release = await acquireFileLock(`${usageDatabasePaths().archivePath}.cleanup.lock`, signal);
  try {
    const result = asRecord(
      await runLocalUsageWorker({ preserveTimings: sessions }, onProgress, signal)
    );
    const messages = nonnegativeInteger(result?.messages);
    if (result?.sessions !== sessions.length || messages === null || messages === 0)
      throw new Error(
        'Could not verify preserved original usage timing. No history may be deleted.'
      );
    return { sessions: sessions.length, messages };
  } finally {
    await release();
  }
}

/** The archive commits before the caller is allowed to delete any session. */
export async function archiveSessionUsage(
  sessions: UsageArchiveSession[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const result = await runLocalUsageWorker(
    { archiveSessions: sessions, start: null, windows: [] },
    onProgress,
    signal
  );
  if (asRecord(result)?.archived !== sessions.length) {
    throw new Error('Could not archive every session. No sessions were deleted.');
  }
}

export async function readPendingUsageCleanup(
  signal?: AbortSignal
): Promise<UsageArchiveSession[]> {
  const result = await runLocalUsageWorker({ cleanupAction: 'pending' }, undefined, signal);
  if (!Array.isArray(result)) throw new Error('Malformed usage cleanup journal.');
  return result.map((value) => {
    const item = asRecord(value);
    const id = stringValue(item?.id);
    const directory = stringValue(item?.directory);
    const updated = numberValue(item?.updated);
    const directories = item?.directories;
    if (!id || !directory || updated === null) {
      throw new Error('Malformed session in usage cleanup journal.');
    }
    if (
      directories !== undefined &&
      (!Array.isArray(directories) ||
        !directories.length ||
        !directories.every((entry) => typeof entry === 'string' && isAbsolute(entry)))
    )
      throw new Error('Malformed cleanup directory provenance.');
    const session: UsageArchiveSession = { id, directory, updated };
    if (Array.isArray(directories)) session.directories = directories;
    return session;
  });
}

export async function usageCleanupArtifacts(
  id: string,
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<string[]> {
  return (await readUsageCleanupArtifacts([id], onProgress, signal)).get(id)!;
}

/** Share one remaining-history scan across every already-deleted recovery unit. */
export async function readUsageCleanupArtifacts(
  ids: string[],
  onProgress?: (message: string, processed?: number) => void,
  signal?: AbortSignal
): Promise<Map<string, string[]>> {
  if (!ids.length) return new Map();
  const result = await runLocalUsageWorker(
    { cleanupAction: 'artifacts', sessionIDs: ids },
    onProgress,
    signal
  );
  if (!Array.isArray(result)) throw new Error('Malformed artifact cleanup journal.');
  const paths = new Map<string, string[]>();
  for (const value of result) {
    const item = asRecord(value);
    if (
      typeof item?.id !== 'string' ||
      !ids.includes(item.id) ||
      paths.has(item.id) ||
      !Array.isArray(item.paths) ||
      !item.paths.every((path): path is string => typeof path === 'string')
    ) {
      throw new Error('Malformed artifact cleanup journal.');
    }
    paths.set(item.id, item.paths);
  }
  if (paths.size !== ids.length) throw new Error('Incomplete artifact cleanup journal.');
  return paths;
}

export async function finishUsageCleanup(
  id: string,
  paths: string[],
  signal?: AbortSignal
): Promise<void> {
  await runLocalUsageWorker({ cleanupAction: 'complete', sessionID: id, paths }, undefined, signal);
}

export type UsageCsvExport = { csv: string; rowCount: number };

export async function readAllTimeUsageCsv(
  onProgress?: (message: string) => void,
  signal?: AbortSignal
): Promise<UsageCsvExport> {
  const result = await runLocalUsageWorker(
    { exportCsv: true, start: null, windows: [] },
    onProgress,
    signal
  );
  if (result === null)
    throw new Error('No local OpenCode usage database or statistics archive was found.');
  const data = asRecord(result);
  const rowCount = nonnegativeInteger(data?.rowCount);
  if (
    typeof data?.csv !== 'string' ||
    rowCount === null ||
    rowCount > LOCAL_USAGE_MAX_CSV_ROWS ||
    Buffer.byteLength(data.csv) > LOCAL_USAGE_MAX_CSV_BYTES
  ) {
    throw new Error('Local OpenCode usage export returned malformed CSV data.');
  }
  return { csv: data.csv, rowCount };
}

type OpenCodeRequest = Pick<OpenCodeServer, 'request'> &
  Partial<Pick<OpenCodeServer, 'isAttachOnly' | 'apiVersion'>>;

type Session = {
  id: string;
  directory: string;
  updated: number | null;
  pauses?: SessionPauseBoundary[];
  identity?: string;
  originalTimings?: Map<string, OriginalUsageTiming>;
  timingRevision?: string;
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
  pauseRevision: string;
  timingRevision: string;
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
const LOCAL_USAGE_REPORT_STALL_TIMEOUT_MS = 60_000;
const LOCAL_USAGE_REPORT_MAX_DURATION_MS = 10 * 60_000;
const LOCAL_USAGE_CSV_STALL_TIMEOUT_MS = 60_000;
const LOCAL_USAGE_CSV_MAX_DURATION_MS = 10 * 60_000;
const LOCAL_ARTIFACT_SCAN_STALL_TIMEOUT_MS = 60_000;
const LOCAL_ARTIFACT_SCAN_MAX_DURATION_MS = 10 * 60_000;
const LOCAL_USAGE_MAX_ASSISTANT_ROWS = 250_000;
const LOCAL_USAGE_MAX_SCANNED_ASSISTANT_ROWS = 1_000_000;
const LOCAL_USAGE_MAX_ROUTES = 4_096;
const LOCAL_USAGE_MAX_MESSAGE_DATA_BYTES = 1024 * 1024;
const LOCAL_USAGE_MAX_CSV_ROWS = 100_000;
const LOCAL_USAGE_MAX_CSV_BYTES = 64 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export class UsageReportService {
  private readonly sessionUsageCache = new Map<string, CachedSessionUsage>();
  private sessionUsageCacheEntries = 0;
  private reportOperation: { includeAllTime: boolean; promise: Promise<void> } | null = null;
  private csvExportOperation: Promise<void> | null = null;

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

  exportCsv(): Promise<void> {
    if (this.csvExportOperation) return this.csvExportOperation;
    const promise = this.exportCsvNow();
    this.csvExportOperation = promise;
    const finish = () => {
      if (this.csvExportOperation === promise) this.csvExportOperation = null;
    };
    void promise.then(finish, finish);
    return promise;
  }

  private async exportCsvNow(): Promise<void> {
    const controller = new AbortController();
    try {
      if (this.server.isAttachOnly)
        throw new Error(
          'All-time usage CSV export requires the local OpenCode database and statistics archive. Run this command on the server host, not in attach-only mode.'
        );
      const destination = await vscode.window.showSaveDialog({
        title: 'Export all-time OpenCode usage to CSV',
        defaultUri: vscode.Uri.file(join(homedir(), 'opencode-usage-all-time.csv')),
        filters: { CSV: ['csv'] },
        saveLabel: 'Export usage',
      });
      if (!destination) return;
      await assertUsageCsvDestination(destination);
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Exporting all-time OpenCode usage',
          cancellable: true,
        },
        async (progress, token) => {
          const subscription = token.onCancellationRequested(() => controller.abort());
          if (token.isCancellationRequested) controller.abort();
          try {
            return await readAllTimeUsageCsv(
              (message) => progress.report({ message }),
              controller.signal
            );
          } finally {
            subscription.dispose();
          }
        }
      );
      controller.signal.throwIfAborted();
      await assertUsageCsvDestination(destination);
      controller.signal.throwIfAborted();
      await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(result.csv));
      await vscode.window.showInformationMessage(
        `Exported ${result.rowCount.toLocaleString()} daily OpenCode usage rows to ${destination.fsPath}. Dates are UTC; missing reasoning settings are marked unknown.`
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      await vscode.window.showErrorMessage(
        `Could not export OpenCode usage CSV: ${errorMessage(error)}`
      );
      throw error;
    }
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
    const local = this.server.isAttachOnly
      ? null
      : await this.readLocalUsage?.(start, now, includeAllTime);
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
        this.server.isAttachOnly
          ? `Usage reports in attach-only mode support up to ${SESSION_FALLBACK_MAX_SESSIONS} sessions through the API. Run usage reporting on the server host for ${sessions.length.toLocaleString()} sessions.`
          : `The local OpenCode usage database is unavailable. Refusing to fetch full history for ${sessions.length.toLocaleString()} sessions.`
      );
    }
    // Never read this machine's sidecar for an external/unknown server connection.
    if (sessions.length && this.server.isAttachOnly === false && this.server.apiVersion === 2) {
      const timings = await readOriginalUsageTimings(sessions.map((session) => session.id));
      const bySession = new Map<string, OriginalUsageTiming[]>();
      for (const timing of timings) {
        const rows = bySession.get(timing.session_id) ?? [];
        rows.push(timing);
        bySession.set(timing.session_id, rows);
      }
      for (const session of sessions) {
        const rows = bySession.get(session.id) ?? [];
        session.originalTimings = new Map(rows.map((row) => [row.message_id, row]));
        session.timingRevision = createHash('sha256')
          .update(JSON.stringify([session.identity, rows]))
          .digest('hex');
      }
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
            pauses: readSessionPauses(record?.metadata),
            identity:
              stringValue(
                asRecord(asRecord(record?.metadata)?.varroLegacyImport)?.sourceSessionID
              ) ?? id,
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
      cached.pauseRevision === JSON.stringify(session.pauses ?? []) &&
      cached.timingRevision === (session.timingRevision ?? '') &&
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
      pauseRevision: JSON.stringify(session.pauses ?? []),
      timingRevision: session.timingRevision ?? '',
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

async function assertUsageCsvDestination(destination: vscode.Uri): Promise<void> {
  if (destination.scheme !== 'file' || extname(destination.fsPath).toLowerCase() !== '.csv') {
    throw new Error('Choose a local .csv file on the OpenCode server host.');
  }
  const metadata = await lstat(destination.fsPath).catch((error: unknown) => {
    if (asRecord(error)?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (metadata && (!metadata.isFile() || metadata.isSymbolicLink()))
    throw new Error('The usage CSV destination must be a regular file, not a symlink.');
  const { databasePath, archivePath } = usageDatabasePaths();
  for (const path of [databasePath, archivePath, sessionTranscriptArchivePath()]) {
    if (isSameWorkspacePath(destination.fsPath, path))
      throw new Error(
        'The usage CSV destination must not overwrite an OpenCode database or archive.'
      );
    if (!metadata || metadata.ino === 0) continue;
    try {
      const source = await stat(path);
      if (source.dev === metadata.dev && source.ino === metadata.ino)
        throw new Error('The usage CSV destination refers to an OpenCode database or archive.');
    } catch (error) {
      if (asRecord(error)?.code !== 'ENOENT') throw error;
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

async function readOriginalUsageTimings(ids: string[]): Promise<OriginalUsageTiming[]> {
  const result = await runLocalUsageWorker({ readTimings: ids });
  if (!Array.isArray(result)) throw new Error('Invalid original usage timing reply.');
  return result.map((value: unknown) => {
    const row = asRecord(value);
    const sessionID = stringValue(row?.session_id);
    const messageID = stringValue(row?.message_id);
    const sourceSessionID = stringValue(row?.source_session_id);
    const sourceMessageID = stringValue(row?.source_message_id);
    const providerID = stringValue(row?.provider_id);
    const modelID = stringValue(row?.model_id);
    const created = nonnegativeInteger(row?.time_created);
    const completed = nonnegativeInteger(row?.time_completed);
    if (
      !sessionID ||
      !ids.includes(sessionID) ||
      !messageID ||
      !sourceSessionID ||
      !sourceMessageID ||
      sourceMessageID !== messageID ||
      !providerID ||
      !modelID ||
      created === null ||
      completed === null ||
      completed < created ||
      row?.provenance !== 'v1-message'
    )
      throw new Error('Invalid preserved original usage timing.');
    return {
      session_id: sessionID,
      message_id: messageID,
      source_session_id: sourceSessionID,
      source_message_id: sourceMessageID,
      provider_id: providerID,
      model_id: modelID,
      time_created: created,
      time_completed: completed,
      provenance: 'v1-message',
    };
  });
}

async function readLocalUsageDatabase(
  start?: number,
  now = Date.now(),
  includeAllTime = false
): Promise<LocalUsageSnapshot | null> {
  const windows = createReportWindows(now, includeAllTime);
  const result = await runLocalUsageWorker({ start: start ?? null, windows });
  if (result === null) return null;
  const snapshot = normalizeLocalUsageSnapshot(result, windows);
  if (!snapshot) throw new Error('Local OpenCode usage query returned malformed data.');
  return snapshot;
}

type UsageDatabaseTask =
  | { legacyInventory: UsageArchiveSession[] }
  | { legacySessions: LegacyCleanupSession[]; legacyCutoff: number; start: null; windows: [] }
  | { preserveTimings: UsageArchiveSession[] }
  | { readTimings: string[] }
  | { cleanupAction: 'pending' }
  | { cleanupAction: 'artifacts'; sessionIDs: string[] }
  | { cleanupAction: 'complete'; sessionID: string; paths: string[] }
  | { archiveSessions: UsageArchiveSession[]; start: null; windows: ReportWindow[] }
  | { exportCsv: true; start: null; windows: [] }
  | { start: number | null; windows: ReportWindow[] };

async function runLocalUsageWorker(
  task: UsageDatabaseTask,
  onProgress?: (message: string, processed?: number) => void,
  signal?: AbortSignal,
  legacy?: { prepared: () => Promise<void>; committing: () => void }
): Promise<unknown> {
  signal?.throwIfAborted();
  const annotationsDirectory = getVarroStateReadDirectory('opencode-v2');

  return new Promise((resolve, reject) => {
    const allTime = 'windows' in task && task.windows.some((window) => window.start === null);
    const worker = new Worker(LOCAL_USAGE_WORKER, {
      eval: true,
      workerData: {
        ...usageDatabasePaths(),
        annotationsDirectory,
        maxAssistantRows: LOCAL_USAGE_MAX_ASSISTANT_ROWS,
        maxMessageDataBytes: LOCAL_USAGE_MAX_MESSAGE_DATA_BYTES,
        maxRoutes: LOCAL_USAGE_MAX_ROUTES,
        maxScannedAssistantRows: LOCAL_USAGE_MAX_SCANNED_ASSISTANT_ROWS,
        maxCsvRows: LOCAL_USAGE_MAX_CSV_ROWS,
        maxCsvBytes: LOCAL_USAGE_MAX_CSV_BYTES,
        allTimeReport: allTime,
        ...task,
      },
    });
    let settled = false;
    let phase: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let processed = 0;
    let committing = false;
    let preparing: Promise<void> | undefined;
    const csv = 'exportCsv' in task;
    const artifacts = 'cleanupAction' in task && task.cleanupAction === 'artifacts';
    const longScan = csv || artifacts || allTime;
    const cancel = () => {
      if (!committing) finish(null, new Error('Local OpenCode usage operation cancelled.'));
    };
    const finish = (result: unknown, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      void worker
        .terminate()
        .catch(() => 0)
        .then(async () => {
          await preparing?.catch(() => {});
          if (error) reject(error);
          else resolve(result);
        });
    };
    const armTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(
        () =>
          finish(
            null,
            new Error(
              `${legacy ? 'Legacy cleanup preparation exceeded the 10-minute limit.' : csv ? 'Local OpenCode usage CSV made no row progress for 60 seconds.' : artifacts ? 'OpenCode artifact reference scan made no row progress for 60 seconds.' : allTime ? 'Local OpenCode all-time usage query made no row progress for 60 seconds.' : `Local OpenCode usage query timed out after ${LOCAL_USAGE_WORKER_TIMEOUT_MS / 1_000} seconds.`}${phase ? ` Last phase: ${phase}.` : ''}`
            )
          ),
        legacy
          ? 10 * 60_000
          : csv
            ? LOCAL_USAGE_CSV_STALL_TIMEOUT_MS
            : artifacts
              ? LOCAL_ARTIFACT_SCAN_STALL_TIMEOUT_MS
              : allTime
                ? LOCAL_USAGE_REPORT_STALL_TIMEOUT_MS
                : LOCAL_USAGE_WORKER_TIMEOUT_MS
      );
    };
    armTimeout();
    if (longScan)
      deadline = setTimeout(
        () =>
          finish(
            null,
            new Error(
              `${csv ? 'Local OpenCode usage CSV exceeded the 10-minute export limit.' : artifacts ? 'OpenCode artifact reference scan exceeded the 10-minute scan limit.' : 'Local OpenCode all-time usage query exceeded the 10-minute scan limit.'}${phase ? ` Last phase: ${phase}.` : ''}`
            )
          ),
        csv
          ? LOCAL_USAGE_CSV_MAX_DURATION_MS
          : artifacts
            ? LOCAL_ARTIFACT_SCAN_MAX_DURATION_MS
            : LOCAL_USAGE_REPORT_MAX_DURATION_MS
      );
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.on('message', (value: unknown) => {
      if (settled) return;
      if (value === null) {
        finish(null);
        return;
      }
      const workerMessage = asRecord(value);
      if (workerMessage?.legacyPrepared === true && legacy) {
        preparing = legacy
          .prepared()
          .then(() => {
            if (settled || signal?.aborted) return;
            committing = true;
            clearTimeout(timeout);
            legacy.committing();
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads messages do not accept a browser targetOrigin.
            worker.postMessage({ commit: true });
          })
          .catch((error: unknown) =>
            finish(null, error instanceof Error ? error : new Error(String(error)))
          );
        return;
      }
      const progress = stringValue(workerMessage?.progress);
      if (progress) {
        phase = progress;
        const count = numberValue(workerMessage?.processed);
        if (
          longScan &&
          count !== null &&
          Number.isSafeInteger(count) &&
          count > processed &&
          count <=
            (artifacts || allTime
              ? Number.MAX_SAFE_INTEGER
              : LOCAL_USAGE_MAX_SCANNED_ASSISTANT_ROWS)
        ) {
          processed = count;
          armTimeout();
        }
        if (count !== null && Number.isSafeInteger(count) && count >= 0)
          onProgress?.(progress, count);
        else onProgress?.(progress);
        return;
      }
      const workerError = stringValue(workerMessage?.error);
      if (workerError) {
        finish(
          null,
          new Error(
            `${artifacts ? 'OpenCode artifact reference scan failed' : 'Local OpenCode usage query failed'}: ${workerError}`
          )
        );
        return;
      }
      finish(value);
    });
    worker.once('error', (error) =>
      finish(null, new Error(`Local OpenCode usage worker failed: ${errorMessage(error)}`))
    );
    worker.once('exit', (code) => {
      finish(null, new Error(`Local OpenCode usage worker exited without a result, code ${code}.`));
    });
  });
}

const LOCAL_USAGE_WORKER = String.raw`
const { DatabaseSync } = require('node:sqlite');
const { existsSync, readFileSync } = require('node:fs');
const { join, dirname, resolve, basename, isAbsolute } = require('node:path');
const { fileURLToPath } = require('node:url');
const { tmpdir } = require('node:os');
const { parentPort, workerData } = require('node:worker_threads');
const progress = (message, processed) => {
  parentPort.postMessage({ progress: message, processed });
};
${ORIGINAL_USAGE_TIMING_WORKER}

const sessionPauses = new Map();
const readPauseTime = (sessionID, messageID) => {
  if (!sessionPauses.has(sessionID)) {
    let entries = [];
    if (/^[a-zA-Z0-9_-]{1,256}$/.test(sessionID)) {
      try {
        const metadata = JSON.parse(readFileSync(join(workerData.annotationsDirectory, sessionID + '.json'), 'utf8')).metadata;
        const pauses = metadata?.varro?.pauses;
        if (Array.isArray(pauses)) entries = pauses.filter((pause) => typeof pause?.messageId === 'string' && Number.isFinite(pause.pausedAt));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (workerData.allTimeReport && sessionPauses.size >= 64) sessionPauses.delete(sessionPauses.keys().next().value);
    sessionPauses.set(sessionID, new Map(entries.map((pause) => [pause.messageId, pause.pausedAt])));
  }
  return sessionPauses.get(sessionID).get(messageID);
};

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

const compactUsageRow = (row) => {
  // SQLite extracts the compact scalar tuple once. Large content/tool bodies
  // never cross the worker boundary or get parsed into JavaScript objects.
  const fields = JSON.parse(row.fields);
  const original = row.originalTiming === null ? null : JSON.parse(row.originalTiming);
  const originalCompleted = original && typeof fields[7] === 'number' && original[0] === 'assistant' &&
    original[1] === fields[7] && original[2] === (fields[0] ?? fields[1]) &&
    original[3] === (fields[2] ?? fields[3] ?? fields[4]) &&
    typeof original[4] === 'number' && original[4] >= fields[7]
      ? original[4] : null;
  return {
    sessionID: row.sessionID, messageID: row.messageID, version: row.version, identity: row.identity, parentID: row.parentID,
    providerID: fields[0], nestedProviderID: fields[1], modelID: fields[2],
    nestedModelID: fields[3] ?? fields[4], variant: fields[5] ?? fields[6],
    timeCreated: fields[7], timeCompleted: fields[8], total: fields[9], cost: fields[10],
    input: fields[11], output: fields[12], reasoning: fields[13],
    cacheRead: fields[14], cacheWrite: fields[15], originalCompleted,
  };
};

const cleanupJournal = () => {
  if (!existsSync(workerData.archivePath)) return [];
  const archive = new DatabaseSync(workerData.archivePath);
  try {
    checkTimingSchema(archive);
    if (workerData.cleanupAction === 'pending') {
      const locations = archive.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_cleanup_directory'").get();
      return archive.prepare('SELECT id, directory, time_updated AS updated FROM usage_cleanup ORDER BY time_updated, id').all().map(row => locations ? ({ ...row, directories:[...new Set([row.directory,...archive.prepare('SELECT directory FROM usage_cleanup_directory WHERE session_id=?').all(row.id).map(location => location.directory)])] }) : row);
    }
    if (workerData.cleanupAction === 'complete') {
      archive.exec('BEGIN IMMEDIATE');
      for (const path of workerData.paths) archive.prepare('DELETE FROM usage_artifact WHERE session_id = ? AND path = ?').run(workerData.sessionID, path);
      archive.prepare('DELETE FROM usage_cleanup WHERE id = ? AND NOT EXISTS (SELECT 1 FROM usage_artifact WHERE session_id = ?)').run(workerData.sessionID, workerData.sessionID);
      if (archive.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_cleanup_directory'").get()) archive.prepare('DELETE FROM usage_cleanup_directory WHERE session_id=? AND NOT EXISTS (SELECT 1 FROM usage_cleanup WHERE id=?)').run(workerData.sessionID,workerData.sessionID);
      archive.exec('COMMIT');
      return [];
    }
    const selectPaths = archive.prepare('SELECT path FROM usage_artifact WHERE session_id = ?');
    const groups = workerData.sessionIDs.map((id) => ({ id, paths: selectPaths.all(id).map((row) => row.path) }));
    if (!existsSync(workerData.databasePath)) return groups;
    // Previously each artifact executed a fresh full-history instr() query.
    // Read each remaining row once, discarding matched names as soon as found.
    // Matching raw text rather than only structured references stays conservative.
    const existing = new Set(groups.flatMap((group) => group.paths.filter((path) => existsSync(path))));
    const names = new Set([...existing].map((path) => basename(path)));
    if (!names.size) return groups;
    // A literal union rejects unrelated rows in one native regexp pass instead
    // of rereading large tool bodies once for every unresolved filename.
    // A positive row still checks every name with includes(), preserving prefix,
    // suffix and overlapping matches exactly. Recompile after removing names so
    // an already-protected common name cannot trigger repeated slow checks.
    const compileNames = () => new RegExp([...names].map((name) => name.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')).join('|'));
    let matcher = compileNames();
    const referenced = new Set();
    const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
    try {
      database.exec('PRAGMA busy_timeout = 1000; BEGIN;');
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      let scanned = 0;
      let reportedAt = Date.now();
      for (const table of ['message', 'part', 'session_message', 'session_part', 'session_inbox']) {
        if (!tables.has(table) || !names.size) continue;
        progress('Checking artifact references in ' + table + ': ' + names.size.toLocaleString() + ' unresolved names');
        for (const row of database.prepare('SELECT ' + (table === 'session_inbox' ? 'payload' : 'data') + ' AS data FROM ' + table).iterate()) {
          if (typeof row.data !== 'string') throw new Error('Cannot safely inspect non-text artifact references in ' + table);
          scanned++;
          if (matcher.test(row.data)) {
            const before = names.size;
            for (const name of names) {
              if (!row.data.includes(name)) continue;
              referenced.add(name);
              names.delete(name);
            }
            if (names.size && names.size !== before) matcher = compileNames();
          }
          if (Date.now() - reportedAt >= 1000) {
            reportedAt = Date.now();
            progress('Checked artifact references in ' + scanned.toLocaleString() + ' rows; ' + names.size.toLocaleString() + ' names unresolved', scanned);
          }
          if (!names.size) break;
        }
      }
      progress('Artifact reference scan complete: ' + scanned.toLocaleString() + ' rows, ' + referenced.size.toLocaleString() + ' referenced names kept', scanned);
      return groups.map((group) => ({ id: group.id, paths: group.paths.filter((path) => !existing.has(path) || !referenced.has(basename(path))) }));
    } finally { database.close(); }
  } finally { archive.close(); }
};

const legacyInventory = (database) => {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (!tables.has('session')) return [];
  return database.prepare('SELECT id,directory,title,parent_id AS parentID,time_created AS created,time_updated AS updated FROM session ORDER BY time_updated,id').all().map(row => ({ ...row, parentID: row.parentID ?? undefined, version: 1 }));
};
(async () => { try {
  if (workerData.legacyInventory) {
    const database = new DatabaseSync(workerData.databasePath, { readOnly: true });
    try {
      database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
      const stored = database.prepare('SELECT id,directory,time_updated AS updated FROM session_v2').all();
      const byID = new Map(stored.map(row => [row.id,row]));
      if (stored.length !== workerData.legacyInventory.length || workerData.legacyInventory.some(expected => { const row = byID.get(expected.id); return !row || row.updated !== expected.updated || row.directory !== expected.directory; })) throw new Error('The local database does not match the connected V2 session inventory. Retry after current activity settles.');
      parentPort.postMessage(legacyInventory(database));
    } finally { database.close(); }
  } else
  if (workerData.preserveTimings) {
    parentPort.postMessage(preserveUsageTimings(workerData.preserveTimings));
  } else if (workerData.readTimings) {
    const timing = new OriginalUsageTimingStore(workerData.archivePath);
    try { parentPort.postMessage(timing.readSessions(workerData.readTimings)); }
    finally { timing.close(); }
  } else if (workerData.cleanupAction) {
    parentPort.postMessage(cleanupJournal());
  } else
  if (!existsSync(workerData.databasePath) && !existsSync(workerData.archivePath)) {
    parentPort.postMessage(null);
  } else {
    const legacyCleanup = workerData.legacySessions;
    if (legacyCleanup) {
      const { lstatSync } = require('node:fs');
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { const file = lstatSync(workerData.databasePath + suffix); if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error('Legacy cleanup requires regular database files without links.'); }
        catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
      }
    }
    const database = existsSync(workerData.databasePath)
      ? new DatabaseSync(workerData.databasePath, { readOnly: !legacyCleanup })
      : new DatabaseSync(':memory:');
    let archive;
    let timing;
    try {
      if (workerData.allTimeReport) {
        // Keep all-time prompt deduplication off the JavaScript heap.
        // Use temporary storage with an 8 MiB page cache, without changing
        // the live history or the persistent statistics archive.
        database.exec('PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-8192;');
      }
      if (existsSync(workerData.archivePath) && !workerData.archiveSessions && !legacyCleanup) {
        database.prepare('ATTACH DATABASE ? AS stats').run(workerData.archivePath);
      }
      if (legacyCleanup) {
        database.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
        const actual = legacyInventory(database);
        const byID = new Map(actual.map(row => [row.id,row]));
        const ids = new Set(legacyCleanup.map(row => row.id));
        if (!ids.size || ids.size !== legacyCleanup.length || legacyCleanup.some(expected => {
          const row = byID.get(expected.id);
          return !row || row.updated !== expected.updated || row.directory !== expected.directory || row.parentID !== expected.parentID || row.updated >= workerData.legacyCutoff;
        }) || actual.some(row => ids.has(row.parentID) && !ids.has(row.id))) throw new Error('Legacy sessions or their child membership changed. No V1 sessions were deleted.');
        const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        if (database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('session','message','part','todo','session_share') LIMIT 1").get()) throw new Error('Unsupported legacy deletion triggers.');
        for (const { name } of tables) for (const foreign of database.prepare('PRAGMA foreign_key_list(' + JSON.stringify(name) + ')').all()) {
          if (['session','message','part'].includes(foreign.table) && !['session','message','part','todo','session_share'].includes(name)) throw new Error('Unsupported legacy foreign-key dependency in ' + name);
          if (['session','message','part','todo','session_share'].includes(name) && ['session_v2','session_message','session_part'].includes(foreign.table)) throw new Error('Unsupported cross-version legacy foreign key.');
        }
        const dependents = database.prepare("SELECT id,time_updated AS updated,coalesce(json_extract(metadata,'$.varroLegacyImport.sourceSessionID'),id) AS identity FROM session_v2").all().filter(row => ids.has(row.identity));
        for (let index = 0; index < dependents.length; index += 1000) preserveUsageTimings(dependents.slice(index,index + 1000), true);
      } else database.exec('BEGIN');
      timing = new OriginalUsageTimingStore(workerData.archivePath);
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
      const sources = [];
      if (tables.has('session') && tables.has('message')) {
        sources.push("SELECT id, id AS identity, time_updated, 1 AS version, 0 AS archived FROM session");
      }
      if (tables.has('session_v2') && tables.has('session_message')) {
        sources.push("SELECT id, coalesce(json_extract(metadata, '$.varroLegacyImport.sourceSessionID'), id) AS identity, time_updated, 2 AS version, 0 AS archived FROM session_v2");
      }
      const archiveSessions = workerData.archiveSessions ?? legacyCleanup;
      if (archiveSessions && !sources.length) throw new Error('No supported OpenCode usage tables found.');
      let requestedSessions;
      if (archiveSessions) {
        progress('Resolving usage identities');
        // Discover identities by primary key, then resolve their complete live
        // snapshots once. Reusing this small table avoids ranking all projects
        // and decoding every session's metadata for each downstream query.
        database.exec('CREATE TEMP TABLE requested_usage_session (id TEXT PRIMARY KEY); CREATE TEMP TABLE requested_usage_identity (identity TEXT PRIMARY KEY);');
        const insertRequested = database.prepare('INSERT INTO requested_usage_session VALUES (?)');
        for (const session of archiveSessions) insertRequested.run(session.id);
        if (tables.has('session') && tables.has('message')) database.exec('INSERT OR IGNORE INTO requested_usage_identity SELECT s.id FROM requested_usage_session r CROSS JOIN session s ON s.id = r.id');
        if (tables.has('session_v2') && tables.has('session_message')) database.exec("INSERT OR IGNORE INTO requested_usage_identity SELECT coalesce(json_extract(s.metadata, '$.varroLegacyImport.sourceSessionID'), s.id) FROM requested_usage_session r CROSS JOIN session_v2 s ON s.id = r.id");
        database.exec('CREATE TEMP TABLE live_usage_session AS SELECT * FROM (' + sources.join(' UNION ALL ') + ') WHERE identity IN (SELECT identity FROM requested_usage_identity)');
        const liveSnapshots = database.prepare('SELECT * FROM live_usage_session ORDER BY version DESC').all();
        requestedSessions = archiveSessions.map((expected) => liveSnapshots.find((session) => expected.id === session.id && expected.updated === session.time_updated && (expected.version === undefined || expected.version === session.version)));
        if (requestedSessions.some((session) => !session)) throw new Error('Sessions changed or are missing from the local database. Run cleanup again.');
        sources.splice(0, sources.length, 'SELECT * FROM live_usage_session');
      }
      const hasArchive = existsSync(workerData.archivePath);
      if (hasArchive) {
        if (archiveSessions) {
          // Copy only headers through a separate read connection. Holding an attached
          // archive read transaction while committing its writer would deadlock.
          database.exec('CREATE TEMP TABLE archived_usage_session (id TEXT, identity TEXT, time_updated INTEGER, version INTEGER)');
          const previous = new DatabaseSync(workerData.archivePath, { readOnly: true });
          try {
            const identities = database.prepare('SELECT identity FROM requested_usage_identity').all();
            for (const { identity } of identities) {
              const row = previous.prepare('SELECT * FROM usage_session WHERE identity = ?').get(identity);
              if (row) database.prepare('INSERT INTO archived_usage_session VALUES (?, ?, ?, ?)').run(row.id, row.identity, row.time_updated, row.version);
            }
          } finally { previous.close(); }
          sources.push('SELECT id, identity, time_updated, version, 1 AS archived FROM archived_usage_session');
        } else sources.push('SELECT id, identity, time_updated, version, 1 AS archived FROM stats.usage_session');
      }
      if (!sources.length) throw new Error('No supported OpenCode usage tables found.');
      // Select a complete session before filtering dates or reading messages. Equal timestamps prefer v2.
      const selected = 'WITH ranked AS (SELECT *, row_number() OVER (PARTITION BY identity ORDER BY time_updated DESC, version DESC, archived ASC, id DESC) AS rank FROM (' + sources.join(' UNION ALL ') + ')), selected AS (SELECT * FROM ranked WHERE rank = 1' + (archiveSessions || workerData.start === null ? '' : ' AND time_updated >= ?') + ') ';
      const parameters = archiveSessions || workerData.start === null ? [] : [workerData.start];
      progress('Resolving usage snapshot');
      const sessionCount = archiveSessions || workerData.exportCsv ? 0 : database.prepare(selected + 'SELECT count(*) AS count FROM selected').get(...parameters).count;
      if (archiveSessions) {
        const selectedSessions = database.prepare(selected + 'SELECT * FROM selected WHERE archived = 0').all(...parameters);
        timing.freeze(selectedSessions.filter(session => session.version === 2).map(session => session.id));
        // Reports bound JSON body size, but archiving must also retain usage from large tool/image messages.
        for (const session of selectedSessions) {
          progress('Validating usage for ' + session.id);
          const table = session.version === 1 ? 'message' : 'session_message';
          if (database.prepare('SELECT 1 FROM ' + table + ' WHERE session_id = ? AND NOT json_valid(data) LIMIT 1').get(session.id)) {
            throw new Error('Cannot safely archive malformed history for ' + session.id);
          }
        }
        validateUsageArchiveFile();
        archive = new DatabaseSync(workerData.archivePath);
        archive.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;');
        archive.exec('BEGIN IMMEDIATE');
        initializeUsageArchive(archive);
        for (const session of selectedSessions) {
          archive.prepare('DELETE FROM usage_session WHERE identity = ? OR id = ?').run(session.identity, session.id);
          archive.prepare('INSERT INTO usage_session VALUES (?, ?, ?, ?)').run(session.id, session.identity, session.time_updated, session.version);
        }
        for (let index = 0; index < requestedSessions.length; index += 1) {
          const session = requestedSessions[index];
          progress('Collecting owned artifacts for ' + session.id);
          const directory = archiveSessions[index].directory;
          archive.prepare('INSERT OR IGNORE INTO usage_cleanup_directory SELECT id,directory FROM usage_cleanup WHERE id=?').run(session.id);
          archive.prepare('INSERT OR IGNORE INTO usage_cleanup_directory VALUES (?,?)').run(session.id,directory);
          archive.prepare('INSERT OR REPLACE INTO usage_cleanup VALUES (?, ?, ?)').run(session.id, directory, session.time_updated);
          archive.prepare('INSERT OR IGNORE INTO usage_artifact VALUES (?, ?)').run(session.id, join(directory, '.opencode', 'attachments', session.id));
          archive.prepare('INSERT OR IGNORE INTO usage_artifact VALUES (?, ?)').run(session.id, join(workerData.dataDirectory, 'storage', 'session_diff', session.id + '.json'));
          // Record only structured file references, never paths found in prose or source code.
          for (const table of session.version === 1 ? ['message', 'part'] : ['session_message', 'session_part']) {
            if (!tables.has(table)) continue;
            for (const row of database.prepare('SELECT DISTINCT j.value AS path FROM ' + table + ' m, json_tree(m.data) j WHERE m.session_id = ? AND j.key IN (\'outputPath\', \'uri\', \'url\') AND j.type = \'text\'').iterate(session.id)) {
              let path = row.path;
              if (path.length > 32768 || (!path.startsWith('file:') && !isAbsolute(path))) continue;
              if (path.startsWith('file:')) {
                try { path = fileURLToPath(path); } catch { continue; }
              }
              const toolOutput = dirname(resolve(path)) === join(resolve(workerData.dataDirectory), 'tool-output') && /^tool_[a-zA-Z0-9._-]+$/.test(basename(path));
              const temporaryDrop = dirname(dirname(resolve(path))) === join(tmpdir(), 'varro-drops') && /^drop-[a-zA-Z0-9_-]+$/.test(basename(dirname(path))) && /^\d+-[a-f0-9]{32}-.+$/.test(basename(path));
              if (!toolOutput && !temporaryDrop) continue;
              archive.prepare('INSERT OR IGNORE INTO usage_artifact VALUES (?, ?)').run(session.id, resolve(path));
            }
          }
        }
      }
      if (!workerData.exportCsv && tables.has('session_v2') && tables.has('session_message')) {
        // Index the selected user messages once. The source index can cover only
        // (session_id, seq), making a backwards user lookup rescan long assistant runs.
        // Temporary tables keep the source database and its schema read-only.
        progress('Indexing usage prompts');
        database.prepare('CREATE TEMP TABLE usage_prompt AS ' + selected + "SELECT m.session_id, m.seq, m.id FROM selected s CROSS JOIN session_message m ON s.id = m.session_id WHERE s.archived = 0 AND s.version = 2 AND m.type = 'user'").run(...parameters);
        database.exec('CREATE INDEX usage_prompt_session_seq_idx ON usage_prompt(session_id, seq)');
      }
      const compact = !archiveSessions;
      const messages = [];
      const bodyLimit = workerData.exportCsv ? '' : ' AND length(m.data) <= ?';
      // Keep selected sessions as the outer loop. Otherwise SQLite can scan and decode
      // every message in both versions before checking whether its session was selected.
      if (tables.has('session') && tables.has('message')) {
        messages.push("SELECT m.id, s.identity, 1 AS version, m.session_id, m.data, NULL AS originalCompleted, " + (workerData.exportCsv ? 'NULL' : "json_extract(m.data, '$.parentID')") + " AS parentID FROM selected s CROSS JOIN message m ON s.id = m.session_id WHERE s.archived = 0 AND s.version = 1" + bodyLimit + " AND json_extract(m.data, '$.role') = 'assistant'");
      }
      if (tables.has('session_v2') && tables.has('session_message')) {
        // Migration can replace completion times with the import time. Recover timing only
        // from the same original message, without selecting its older token usage.
        const originalCompleted = tables.has('message')
          ? compact
            ? "(SELECT CASE WHEN json_valid(original.data) THEN json_extract(original.data, '$.role', '$.time.created', '$.providerID', '$.modelID', '$.time.completed') END FROM message original WHERE original.id = m.id AND original.session_id = s.identity)"
            : "(SELECT CASE WHEN json_valid(original.data) THEN CASE WHEN json_extract(original.data, '$.role') = 'assistant' AND json_extract(original.data, '$.time.created') = json_extract(m.data, '$.time.created') AND json_extract(original.data, '$.providerID') = coalesce(json_extract(m.data, '$.providerID'), json_extract(m.data, '$.model.providerID')) AND json_extract(original.data, '$.modelID') = coalesce(json_extract(m.data, '$.modelID'), json_extract(m.data, '$.model.id'), json_extract(m.data, '$.model.modelID')) AND json_type(original.data, '$.time.completed') IN ('integer', 'real') AND json_extract(original.data, '$.time.completed') >= json_extract(original.data, '$.time.created') THEN json_extract(original.data, '$.time.completed') END END FROM message original WHERE original.id = m.id AND original.session_id = s.identity)"
          : 'NULL';
        const parentID = workerData.exportCsv ? 'NULL' : "coalesce(json_extract(m.data, '$.parentID'), (SELECT u.id FROM usage_prompt u WHERE u.session_id = m.session_id AND u.seq < m.seq ORDER BY u.seq DESC LIMIT 1))";
        messages.push("SELECT m.id, s.identity, 2 AS version, m.session_id, m.data, " + originalCompleted + " AS originalCompleted, " + parentID + " AS parentID FROM selected s CROSS JOIN session_message m ON s.id = m.session_id WHERE s.archived = 0 AND s.version = 2 AND m.type = 'assistant'" + bodyLimit);
      }
      if (hasArchive && !archiveSessions) {
        messages.push("SELECT m.id, s.identity, 0 AS version, m.session_id, m.data, NULL AS originalCompleted, " + (workerData.exportCsv ? 'NULL' : "json_extract(m.data, '$.parentID')") + " AS parentID FROM selected s CROSS JOIN stats.usage_message m ON s.id = m.session_id WHERE s.archived = 1" + bodyLimit);
      }
      const query = compact ? selected +
        "SELECT m.session_id AS sessionID, m.id AS messageID, m.identity, m.version AS version, m.parentID, m.originalCompleted AS originalTiming, json_extract(m.data, '$.providerID', '$.model.providerID', '$.modelID', '$.model.id', '$.model.modelID', '$.model.variant', '$.variant', '$.time.created', '$.time.completed', '$.tokens.total', '$.cost', '$.tokens.input', '$.tokens.output', '$.tokens.reasoning', '$.tokens.cache.read', '$.tokens.cache.write') AS fields FROM (" + messages.join(' UNION ALL ') + ') m LIMIT ?' : [
        selected,
        'SELECT m.session_id AS sessionID,',
        'm.id AS messageID, m.version AS version, m.identity,',
        "json_extract(m.data, '$.providerID') AS providerID,",
        "json_extract(m.data, '$.model.providerID') AS nestedProviderID,",
        "json_extract(m.data, '$.modelID') AS modelID,",
        "coalesce(json_extract(m.data, '$.model.id'), json_extract(m.data, '$.model.modelID')) AS nestedModelID,",
        ...(archiveSessions || workerData.exportCsv ? ["coalesce(json_extract(m.data, '$.model.variant'), json_extract(m.data, '$.variant')) AS variant,"] : []),
        'm.parentID AS parentID,',
        "json_extract(m.data, '$.time.created') AS timeCreated,",
        'm.originalCompleted AS originalCompleted,',
        "json_extract(m.data, '$.time.completed') AS timeCompleted,",
        "json_extract(m.data, '$.tokens.total') AS total,",
        "json_extract(m.data, '$.cost') AS cost,",
        "json_extract(m.data, '$.tokens.input') AS input,",
        "json_extract(m.data, '$.tokens.output') AS output,",
        "json_extract(m.data, '$.tokens.reasoning') AS reasoning,",
        "json_extract(m.data, '$.tokens.cache.read') AS cacheRead,",
        "json_extract(m.data, '$.tokens.cache.write') AS cacheWrite",
        'FROM (' + messages.join(' UNION ALL ') + ') m',
        'LIMIT ?',
      ].join(' ');
      const statement = database.prepare(query);
      if (archive) progress('Archiving assistant usage records');
      const rows = statement.iterate(...parameters, ...(workerData.exportCsv ? [] : messages.map(() => archive ? Number.MAX_SAFE_INTEGER : workerData.maxMessageDataBytes)), workerData.allTimeReport ? -1 : workerData.maxScannedAssistantRows + 1);
      const insertUsage = archive?.prepare('INSERT INTO usage_message VALUES (?, ?, ?)');
      const aggregates = workerData.windows.map(() => ({
        groups: new Map(),
        promptIDs: new Set(),
      }));
      if (workerData.allTimeReport) database.exec('CREATE TEMP TABLE usage_report_prompt (window_index INTEGER NOT NULL, prompt_id TEXT NOT NULL, route TEXT NOT NULL, PRIMARY KEY(window_index, prompt_id, route)) WITHOUT ROWID');
      const insertReportPrompt = workerData.allTimeReport
        ? database.prepare('INSERT OR IGNORE INTO usage_report_prompt VALUES (?, ?, ?)')
        : undefined;
      const routes = new Set();
      const csvGroups = new Map();
      if (compact) progress(workerData.exportCsv ? 'Aggregating all-time daily usage' : 'Aggregating usage report');
      let assistantRows = 0;
      let scannedAssistantRows = 0;
      let progressAt = Date.now();
      const oldestWindowStart = workerData.exportCsv || workerData.windows.some((window) => window.start === null)
        ? null
        : Math.min(...workerData.windows.map((window) => window.start));

      for (const rawRow of rows) {
        scannedAssistantRows += 1;
        if (!workerData.allTimeReport && scannedAssistantRows > workerData.maxScannedAssistantRows) {
          throw new Error('Usage report exceeds the ' + workerData.maxScannedAssistantRows.toLocaleString() + '-message local scan limit.');
        }
        if (compact && (scannedAssistantRows % 10000 === 0 || Date.now() - progressAt >= 1000)) {
          progressAt = Date.now();
          progress('Read ' + scannedAssistantRows.toLocaleString() + ' assistant messages', scannedAssistantRows);
        }
        const row = compact ? compactUsageRow(rawRow) : rawRow;
        const sessionID = stringValue(row.sessionID);
        const timeCreated = numberValue(row.timeCreated);
        const pausedAt = row.version === 2 && sessionID ? readPauseTime(sessionID, row.messageID) : undefined;
        const preserved = row.version === 2 ? timing.completed(row) : null;
        const original = numberValue(row.originalCompleted);
        if (original !== null && preserved !== null && original !== preserved)
          throw new Error('Conflicting original usage timing for ' + row.messageID);
        const recordedCompleted = original ?? preserved ?? numberValue(row.timeCompleted);
        const timeCompleted = pausedAt !== undefined && timeCreated !== null
          ? Math.max(timeCreated, Math.min(recordedCompleted ?? pausedAt, pausedAt))
          : recordedCompleted;
        const created = timeCompleted ?? timeCreated;
        if (archive) {
          insertUsage.run(row.messageID, row.sessionID, JSON.stringify({
            providerID: stringValue(row.providerID) || stringValue(row.nestedProviderID),
            modelID: stringValue(row.modelID) || stringValue(row.nestedModelID),
            variant: stringValue(row.variant),
            parentID: row.parentID,
            cost: row.cost,
            time: { created: row.timeCreated, completed: timeCompleted },
            tokens: { total: row.total, input: row.input, output: row.output, reasoning: row.reasoning, cache: { read: row.cacheRead, write: row.cacheWrite } },
          }));
          if (scannedAssistantRows % 1000 === 0) progress('Archived usage for ' + scannedAssistantRows.toLocaleString() + ' assistant messages');
        }
        if (workerData.exportCsv && (created === null || !Number.isFinite(new Date(created).getTime()))) throw new Error('Cannot export usage with a missing or invalid message timestamp.');
        if (created === null || (oldestWindowStart !== null && created < oldestWindowStart)) continue;
        assistantRows += 1;
        if (!workerData.allTimeReport && assistantRows > (workerData.exportCsv ? workerData.maxScannedAssistantRows : workerData.maxAssistantRows)) {
          throw new Error('Usage report exceeds the ' + workerData.maxAssistantRows.toLocaleString() + '-message local aggregation limit.');
        }
        const providerID = stringValue(row.providerID) || stringValue(row.nestedProviderID);
        const modelID = stringValue(row.modelID) || stringValue(row.nestedModelID);
        const parentID = stringValue(row.parentID);
        if (!sessionID || !providerID || !modelID) {
          if (workerData.exportCsv) throw new Error('Cannot export usage with missing session, provider, or model identity.');
          continue;
        }

        const input = nonnegativeNumber(row.input);
        const output = nonnegativeNumber(row.output);
        const reasoning = nonnegativeNumber(row.reasoning);
        const cacheRead = nonnegativeNumber(row.cacheRead);
        const cacheWrite = nonnegativeNumber(row.cacheWrite);
        const total = optionalNonnegativeNumber(row.total) ??
          input + output + reasoning + cacheRead + cacheWrite;
        if (workerData.exportCsv) {
          const cost = optionalNonnegativeNumber(row.cost);
          if (total <= 0 && cost === null) continue;
          const day = new Date(created).toISOString().slice(0, 10);
          const variant = stringValue(row.variant) ?? 'unknown';
          const key = JSON.stringify([day, providerID, modelID, variant]);
          let group = csvGroups.get(key);
          if (!group) {
            if (csvGroups.size >= workerData.maxCsvRows) throw new Error('Usage CSV exceeds the daily row limit. No partial export was saved.');
            group = { day, providerID, modelID, variant, messages: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, costedMessages: 0 };
            csvGroups.set(key, group);
          }
          group.messages++;
          group.input += input; group.output += output; group.reasoning += reasoning;
          group.cacheRead += cacheRead; group.cacheWrite += cacheWrite; group.total += total;
          if (cost !== null) { group.cost += cost; group.costedMessages++; }
          continue;
        }
        if (total <= 0) continue;
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
            if (insertReportPrompt) {
              // Repeated assistant continuations need no additional SQLite work.
              // The primary key still deduplicates nonconsecutive occurrences.
              if (aggregate.lastPromptID !== promptID) {
                insertReportPrompt.run(index, promptID, route);
                aggregate.lastPromptID = promptID;
              }
            } else {
              aggregate.promptIDs.add(promptID);
              windowAggregate.promptIDs.add(promptID);
            }
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

      if (workerData.allTimeReport) {
        progress('Counting usage prompts');
        for (const row of database.prepare('SELECT window_index, route, count(*) AS count FROM usage_report_prompt GROUP BY window_index, route').iterate()) {
          aggregates[row.window_index].groups.get(row.route).promptCount = Number(row.count);
        }
        for (const row of database.prepare('SELECT window_index, count(DISTINCT prompt_id) AS count FROM usage_report_prompt GROUP BY window_index').iterate()) {
          aggregates[row.window_index].totalPromptCount = Number(row.count);
        }
      }

      if (archive) {
        progress('Committing usage archive');
        archive.exec('COMMIT');
        if (legacyCleanup) {
          parentPort.postMessage({ legacyPrepared: true });
          await new Promise((resolve,reject) => parentPort.once('message', message => message?.commit === true ? resolve() : reject(new Error('Legacy deletion was not approved.'))));
          const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
          for (const session of legacyCleanup) {
            if (tables.has('part')) database.prepare('DELETE FROM part WHERE session_id=? OR message_id IN (SELECT id FROM message WHERE session_id=?)').run(session.id,session.id);
            for (const table of ['message','todo','session_share']) if (tables.has(table)) database.prepare('DELETE FROM ' + table + ' WHERE session_id=?').run(session.id);
            if (database.prepare('DELETE FROM session WHERE id=?').run(session.id).changes !== 1) throw new Error('Legacy deletion did not remove the expected session.');
          }
          for (const table of ['message','part','todo','session_share']) if (tables.has(table) && database.prepare('PRAGMA foreign_key_check(' + table + ')').all().length) throw new Error('Legacy foreign-key validation failed.');
          database.exec('COMMIT');
          parentPort.postMessage({ deleted: legacyCleanup.length });
        } else parentPort.postMessage({ archived: archiveSessions.length });
      } else if (workerData.exportCsv) {
        progress('Formatting daily CSV');
        const csvCell = (value) => {
          let text = String(value);
          // Identifiers are data, not spreadsheet formulas. Quoting alone is not sufficient.
          if (/^[\u0000-\u0020]*[=+@-]/.test(text)) text = "'" + text;
          return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
        };
        const lines = ['day_utc,provider,model,reasoning_setting,messages,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,total_tokens,reported_cost_usd,costed_messages'];
        let bytes = 3 + Buffer.byteLength(lines[0]) + 2;
        for (const [, group] of [...csvGroups].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
          const line = [group.day, group.providerID, group.modelID, group.variant, group.messages, group.input, group.output, group.reasoning, group.cacheRead, group.cacheWrite, group.total, group.costedMessages ? Number(group.cost.toPrecision(15)) : '', group.costedMessages].map(csvCell).join(',');
          bytes += Buffer.byteLength(line) + 2;
          if (bytes > workerData.maxCsvBytes) throw new Error('Usage CSV exceeds the 64 MB export limit. No partial export was saved.');
          lines.push(line);
        }
        parentPort.postMessage({ csv: '\uFEFF' + lines.join('\r\n') + '\r\n', rowCount: csvGroups.size });
      } else parentPort.postMessage({
        sessionCount: Number(sessionCount),
        windows: aggregates.map((windowAggregate) => ({
          totalPromptCount: windowAggregate.totalPromptCount ?? windowAggregate.promptIDs.size,
          groups: [...windowAggregate.groups.entries()].map(([route, aggregate]) => {
            const separator = route.indexOf('\u0000');
            return {
              providerID: route.slice(0, separator),
              modelID: route.slice(separator + 1),
              prompts: aggregate.promptCount ?? aggregate.promptIDs.size,
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
      archive?.close();
      timing?.close();
      database.close();
    }
  }
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
})();
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
  const startedAt = numberValue(time?.created);
  const pausedAt = session.pauses?.find((pause) => pause.messageId === id)?.pausedAt;
  const timing = id ? session.originalTimings?.get(id) : undefined;
  const original =
    timing?.source_session_id === (session.identity ?? session.id) &&
    timing.time_created === startedAt &&
    timing.provider_id === providerID &&
    timing.model_id === modelID
      ? timing.time_completed
      : undefined;
  const recordedCompleted = original ?? numberValue(time?.completed);
  const completedAt =
    pausedAt !== undefined && startedAt !== null
      ? pauseCompletedAt(startedAt, recordedCompleted ?? undefined, pausedAt)
      : recordedCompleted;
  const created = completedAt ?? startedAt;
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
      durationMs: assistantDuration(startedAt, completedAt),
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
