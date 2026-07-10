import type { RalphConfig, RalphIteration, RalphRun, RalphStopReason } from '../shared/ralph';
import { MAX_RALPH_ITERATIONS } from '../shared/ralph';
import type { RalphStatePayload, WebviewMessage } from '../shared/protocol';
import type { Persistence } from '../shared/persistence';
import { normalizeModelVariant } from '../shared/model-variant';
import {
  createRalphRunner,
  type RalphMessageEntry,
  type RalphRunner,
  type RalphRunnerStore,
  type RalphSessionSummary,
  type RalphSessionStatus,
} from '../shared/ralph-runner-core';
import { asRecord } from '../shared/type-utils';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { logger } from './logger';

const RALPH_RUNS_KEY = 'varro.ralph.runs';
const MAX_PERSISTED_RALPH_RUNS = 100;
const MAX_PERSISTED_RALPH_ITERATIONS = MAX_RALPH_ITERATIONS;
const MAX_RALPH_ID_LENGTH = 512;
const MAX_RALPH_PATH_LENGTH = 4_096;
const MAX_RALPH_PROMPT_LENGTH = 100_000;
const MAX_RALPH_FILES_CHANGED = 500;
const MAX_RALPH_VERIFICATIONS = 100;
const MAX_RALPH_REPAIR_SESSIONS = 100;
const MAX_RALPH_NOTE_LENGTH = 10_000;

type RalphHostMessage = Extract<
  WebviewMessage,
  {
    type:
      | 'ralph/start'
      | 'ralph/stop'
      | 'ralph/pause'
      | 'ralph/resume'
      | 'ralph/update-model'
      | 'ralph/sync';
  }
>;

/**
 * Extension-host store for Ralph runs. The host is the source of truth so
 * autonomous loops survive webview disposal; every mutation persists to the
 * workspace Memento and notifies the host so it can broadcast a state
 * snapshot to the webview mirror.
 */
export class HostRalphStore implements RalphRunnerStore {
  private runs: Record<string, RalphRun>;
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: Persistence,
    private readonly onChange: () => void
  ) {
    const stored = this.persistence.get<unknown>(RALPH_RUNS_KEY);
    this.runs = normalizePersistedRalphRuns(stored);
  }

  snapshot(): Record<string, RalphRun> {
    return { ...this.runs };
  }

  getRun(managerSessionId: string): RalphRun | null {
    return Object.prototype.hasOwnProperty.call(this.runs, managerSessionId)
      ? (this.runs[managerSessionId] ?? null)
      : null;
  }

  getAllRuns(): RalphRun[] {
    return Object.values(this.runs);
  }

  startRun(config: RalphConfig): void {
    const normalizedConfig = normalizeRalphConfigForMutation(config);
    if (
      !normalizedConfig ||
      Object.prototype.hasOwnProperty.call(this.runs, normalizedConfig.managerSessionId) ||
      !this.reserveRunSlot(normalizedConfig.managerSessionId)
    ) {
      return;
    }
    this.runs[normalizedConfig.managerSessionId] = {
      config: normalizedConfig,
      status: 'running',
      currentIteration: 0,
      iterations: [],
      updatedAt: Date.now(),
    };
    this.commit();
  }

  adoptRun(run: RalphRun): void {
    const normalized = normalizePersistedRalphRun(run);
    if (
      !normalized ||
      Object.prototype.hasOwnProperty.call(this.runs, normalized.config.managerSessionId) ||
      !this.reserveRunSlot(normalized.config.managerSessionId)
    ) {
      return;
    }
    this.runs[normalized.config.managerSessionId] = normalized;
    this.commit();
  }

  async adoptLegacyRuns(legacyRuns: Record<string, RalphRun>): Promise<string[]> {
    const candidates: RalphRun[] = [];
    for (const [managerSessionId, rawRun] of Object.entries(legacyRuns)) {
      const normalized = normalizePersistedRalphRun(rawRun, managerSessionId);
      if (normalized) candidates.push(normalized);
    }
    if (candidates.length === 0) return [];

    const stagedRuns = { ...this.runs };
    for (const candidate of candidates) {
      const managerSessionId = candidate.config.managerSessionId;
      if (Object.prototype.hasOwnProperty.call(stagedRuns, managerSessionId)) continue;
      if (!reserveRunSlotIn(stagedRuns, managerSessionId)) continue;
      stagedRuns[managerSessionId] = candidate;
    }
    if (!(await this.enqueuePersistence(stagedRuns))) return [];

    // Re-apply against the latest in-memory state in case another command
    // mutated the store while the migration write was pending.
    const acknowledged: string[] = [];
    for (const candidate of candidates) {
      const managerSessionId = candidate.config.managerSessionId;
      if (Object.prototype.hasOwnProperty.call(this.runs, managerSessionId)) {
        acknowledged.push(managerSessionId);
        continue;
      }
      if (!this.reserveRunSlot(managerSessionId)) continue;
      this.runs[managerSessionId] = candidate;
      acknowledged.push(managerSessionId);
    }
    if (!(await this.enqueuePersistence(this.snapshot()))) return [];
    this.onChange();
    return acknowledged;
  }

  setStatus(managerSessionId: string, status: RalphRun['status'], stopReason?: RalphStopReason) {
    const run = this.getRun(managerSessionId);
    if (!run) return;
    const next: RalphRun = { ...run, status, updatedAt: Date.now() };
    if (stopReason !== undefined) {
      next.stopReason = stopReason;
    } else if (status === 'running' || status === 'paused') {
      // Clear any prior terminal stop reason when leaving a terminal state.
      delete next.stopReason;
    }
    this.runs[managerSessionId] = next;
    this.commit();
  }

  addIterations(managerSessionId: string, count: number): void {
    const run = this.getRun(managerSessionId);
    if (!run || !Number.isFinite(count) || count < 1) return;
    const iterations = Math.min(MAX_RALPH_ITERATIONS, run.config.iterations + Math.floor(count));
    if (iterations === run.config.iterations) return;
    this.runs[managerSessionId] = {
      ...run,
      config: { ...run.config, iterations },
      updatedAt: Date.now(),
    };
    this.commit();
  }

  updateRunModel(managerSessionId: string, model: RalphConfig['model']): void {
    const run = this.getRun(managerSessionId);
    if (!run) return;
    const normalizedModel = model === null ? null : normalizePersistedRalphModel(model);
    if (model !== null && !normalizedModel) return;
    this.runs[managerSessionId] = {
      ...run,
      config: { ...run.config, model: normalizedModel },
      updatedAt: Date.now(),
    };
    this.commit();
  }

  upsertIteration(managerSessionId: string, iteration: RalphIteration): void {
    const run = this.getRun(managerSessionId);
    if (!run) return;
    const normalizedIteration = normalizePersistedRalphIteration(iteration, run.config.iterations);
    if (!normalizedIteration) return;
    const iterations = [...run.iterations];
    const existing = iterations.findIndex((it) => it.index === normalizedIteration.index);
    if (existing >= 0) iterations[existing] = normalizedIteration;
    else {
      if (iterations.length >= MAX_PERSISTED_RALPH_ITERATIONS) return;
      iterations.push(normalizedIteration);
    }
    iterations.sort((a, b) => a.index - b.index);
    this.runs[managerSessionId] = {
      ...run,
      iterations,
      currentIteration: Math.max(run.currentIteration, normalizedIteration.index),
      updatedAt: Date.now(),
    };
    this.commit();
  }

  flush(): Promise<void> {
    return this.persistenceQueue;
  }

  private reserveRunSlot(managerSessionId: string): boolean {
    return reserveRunSlotIn(this.runs, managerSessionId);
  }

  private commit() {
    const snapshot = this.snapshot();
    void this.enqueuePersistence(snapshot);
    this.onChange();
  }

  private enqueuePersistence(snapshot: Record<string, RalphRun>): Promise<boolean> {
    const result = this.persistenceQueue.then(async () => {
      try {
        await this.persistence.set(RALPH_RUNS_KEY, snapshot);
        return true;
      } catch (err) {
        logger.warn(
          `Failed to persist Ralph runs: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
    });
    this.persistenceQueue = result.then(() => {});
    return result;
  }
}

/**
 * Runs Ralph loops on the extension host, so an in-flight autonomous run
 * keeps orchestrating while the sidebar is hidden and resumes after a window
 * reload without waiting for the webview. The webview controls runs through
 * `ralph/*` messages and renders the `ralph/state` broadcasts.
 */
export class RalphHost {
  private readonly store: HostRalphStore;
  private readonly runner: RalphRunner;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly deps: {
      server: Pick<OpenCodeServer, 'request' | 'on' | 'off'>;
      contextProvider: Pick<ContextProvider, 'readFile'>;
      persistence: Persistence;
      ensureServerStarted(): Promise<unknown>;
      broadcastState(payload: RalphStatePayload): void;
    }
  ) {
    this.store = new HostRalphStore(deps.persistence, () => this.broadcast());
    this.runner = createRalphRunner({
      store: this.store,
      createSession: async ({ title, permission, parentID }, signal) => {
        const session = await this.request(
          'POST',
          '/session',
          {
            title,
            parentID,
            ...(permission.length > 0 ? { permission } : {}),
          },
          signal
        );
        const sessionID = getString(asRecord(session)?.id);
        if (!sessionID) throw new Error('Ralph child session was not created');
        return sessionID;
      },
      sendPrompt: async (sessionId, body, signal) => {
        await this.request(
          'POST',
          `/session/${encodeURIComponent(sessionId)}/prompt_async`,
          body,
          signal
        );
      },
      abortSession: async (sessionId, signal) => {
        await this.request(
          'POST',
          `/session/${encodeURIComponent(sessionId)}/abort`,
          undefined,
          signal
        );
      },
      listSessions: async (signal) => {
        const sessions = await this.request('GET', '/session', undefined, signal);
        if (!Array.isArray(sessions)) return [];
        return sessions
          .map((item): RalphSessionSummary | null => {
            const record = asRecord(item);
            const id = getString(record?.id);
            if (!id) return null;
            return { id, parentID: getString(record?.parentID) };
          })
          .filter((item): item is RalphSessionSummary => item !== null);
      },
      listMessages: async (sessionId, signal) => {
        const messages = await this.request(
          'GET',
          `/session/${encodeURIComponent(sessionId)}/message`,
          undefined,
          signal
        );
        return Array.isArray(messages) ? (messages as RalphMessageEntry[]) : [];
      },
      getSessionStatus: async (sessionId, signal) => {
        const statuses = asRecord(await this.request('GET', '/session/status', undefined, signal));
        if (!statuses) throw new Error('OpenCode returned an invalid session status snapshot');
        if (!Object.prototype.hasOwnProperty.call(statuses, sessionId)) {
          const sessions = await this.request('GET', '/session', undefined, signal);
          if (!Array.isArray(sessions)) {
            throw new Error(
              'OpenCode returned an invalid session list while confirming idle status'
            );
          }
          const exists = sessions.some((session) => getString(asRecord(session)?.id) === sessionId);
          return exists ? { type: 'idle' } : { type: 'missing' };
        }
        const status = asRecord(statuses?.[sessionId]);
        if (!status) {
          return {
            type: 'unknown',
            message: `OpenCode returned a malformed status for ${sessionId}`,
          };
        }
        return parseRalphSessionStatus(status, sessionId);
      },
      onSessionStatus: (listener) => {
        const handler = (event: { type?: string; properties?: unknown }) => {
          const props = asRecord(event?.properties);
          const sessionID = getString(props?.sessionID);
          if (!sessionID) return;
          if (event.type === 'session.idle') {
            listener(sessionID, { type: 'idle' });
            return;
          }
          if (event.type === 'session.status') {
            listener(sessionID, parseRalphSessionStatus(asRecord(props?.status), sessionID));
            return;
          }
          if (event.type === 'session.error') {
            listener(sessionID, {
              type: 'error',
              message: getRalphSessionErrorMessage(props?.error),
            });
          }
        };
        this.deps.server.on('event', handler);
        return () => {
          this.deps.server.off('event', handler);
        };
      },
      readWorkspaceFile: (path, signal) =>
        raceAgainstAbort(this.deps.contextProvider.readFile(path), signal),
      normalizeVariant: (modelID, variant) => normalizeModelVariant(modelID, variant),
      logError: (context, err) => {
        logger.error(`ralph-host:${context}: ${err instanceof Error ? err.message : String(err)}`);
      },
    });

    // Resume loops that were running when the previous window closed. This
    // intentionally starts the OpenCode server: an in-flight autonomous run
    // is exactly the case where eager startup is justified.
    if (this.store.getAllRuns().some((run) => run.status === 'running')) {
      void this.deps
        .ensureServerStarted()
        .then(() => this.runner.reattachAll())
        .catch((err) => {
          logger.warn(`Ralph reattach failed: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  }

  getStatePayload(): RalphStatePayload {
    return { runs: this.store.snapshot(), activeIds: this.runner.activeIds() };
  }

  handleMessage(msg: RalphHostMessage): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'ralph/start':
        void this.withServer(() => this.runner.start(msg.payload.config), 'start');
        break;
      case 'ralph/stop':
        this.runner.stop(msg.payload.managerSessionId);
        break;
      case 'ralph/pause':
        this.runner.pause(msg.payload.managerSessionId);
        break;
      case 'ralph/resume':
        void this.withServer(() => this.runner.resume(msg.payload.managerSessionId), 'resume');
        break;
      case 'ralph/update-model':
        this.store.updateRunModel(msg.payload.managerSessionId, msg.payload.model);
        break;
      case 'ralph/sync': {
        void this.handleSync(msg.payload.legacyRuns);
        break;
      }
    }
  }

  flush(): Promise<void> {
    return this.store.flush();
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      await this.runner.shutdown();
      await this.store.flush();
    })();
    return this.disposePromise;
  }

  private async withServer(action: () => Promise<void>, context: string): Promise<void> {
    try {
      await this.deps.ensureServerStarted();
      await action();
    } catch (err) {
      logger.error(
        `ralph-host:${context} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      // Loop transitions (including activity flags) must reach the webview
      // even when the action itself failed.
      this.broadcast();
    }
  }

  private async handleSync(legacyRuns?: Record<string, RalphRun>): Promise<void> {
    const acknowledgedIds = legacyRuns ? await this.store.adoptLegacyRuns(legacyRuns) : [];
    if (this.disposed) return;
    await this.withServer(async () => this.runner.reattachAll(), 'reattach');
    this.broadcast(acknowledgedIds);
  }

  private request(method: string, path: string, body?: unknown, signal?: AbortSignal) {
    const request = this.deps.server.request(method, path, body);
    return signal ? raceAgainstAbort(request, signal) : request;
  }

  private broadcast(legacyMigrationAcknowledgedIds: string[] = []) {
    const payload = this.getStatePayload();
    for (const managerSessionId of legacyMigrationAcknowledgedIds) {
      const run = payload.runs[managerSessionId];
      if (run) payload.runs[managerSessionId] = { ...run, legacyMigrationAcknowledged: true };
    }
    this.deps.broadcastState(payload);
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function raceAgainstAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(new Error('Ralph operation was cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      reject(new Error('Ralph operation was cancelled'));
    };
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        reject(err);
      }
    );
    if (signal.aborted) cancel();
  });
}

function parseRalphSessionStatus(
  status: Record<string, unknown> | null,
  sessionId: string
): RalphSessionStatus {
  if (!status) {
    return { type: 'unknown', message: `OpenCode returned a missing status for ${sessionId}` };
  }
  const type = getString(status.type);
  if (type === 'idle') return { type: 'idle' };
  if (type === 'busy' || type === 'retry') return { type: 'active' };
  if (type === 'error' || type === 'failed') {
    return { type: 'error', message: getRalphSessionErrorMessage(status) };
  }
  return {
    type: 'unknown',
    message: `OpenCode returned an unknown status${type ? ` "${type}"` : ''} for ${sessionId}`,
  };
}

function getRalphSessionErrorMessage(value: unknown): string {
  const error = asRecord(value);
  const data = asRecord(error?.data);
  return (
    getString(data?.message) ||
    getString(error?.message) ||
    getString(error?.name) ||
    'The child session ended with an unknown error'
  );
}

function reserveRunSlotIn(runs: Record<string, RalphRun>, managerSessionId: string): boolean {
  if (Object.prototype.hasOwnProperty.call(runs, managerSessionId)) return true;
  const entries = Object.entries(runs);
  if (entries.length < MAX_PERSISTED_RALPH_RUNS) return true;
  const oldestTerminal = entries
    .filter(([, run]) => isTerminalRalphStatus(run.status))
    .toSorted(([, left], [, right]) => left.updatedAt - right.updatedAt)[0];
  if (!oldestTerminal) return false;
  delete runs[oldestTerminal[0]];
  return true;
}

function normalizePersistedRalphRuns(value: unknown): Record<string, RalphRun> {
  const record = asRecord(value);
  if (!record) return {};

  const runs: Record<string, RalphRun> = {};
  for (const [managerSessionId, rawRun] of Object.entries(record)) {
    if (!isSafeRalphRecordKey(managerSessionId)) continue;
    const run = normalizePersistedRalphRun(rawRun, managerSessionId);
    if (!run) continue;
    if (Object.keys(runs).length < MAX_PERSISTED_RALPH_RUNS) {
      runs[managerSessionId] = run;
      continue;
    }
    const oldestTerminal = Object.entries(runs)
      .filter(([, candidate]) => isTerminalRalphStatus(candidate.status))
      .toSorted(([, left], [, right]) => left.updatedAt - right.updatedAt)[0];
    if (
      oldestTerminal &&
      (!isTerminalRalphStatus(run.status) || run.updatedAt > oldestTerminal[1].updatedAt)
    ) {
      delete runs[oldestTerminal[0]];
      runs[managerSessionId] = run;
    }
  }
  return runs;
}

function normalizePersistedRalphRun(
  value: unknown,
  expectedManagerSessionId?: string
): RalphRun | null {
  const record = asRecord(value);
  const config = normalizePersistedRalphConfig(record?.config);
  if (
    !record ||
    !config ||
    (expectedManagerSessionId !== undefined &&
      config.managerSessionId !== expectedManagerSessionId) ||
    !isRalphStatus(record.status) ||
    !isBoundedInteger(record.currentIteration, 0, config.iterations) ||
    !isSafeInteger(record.updatedAt) ||
    !Array.isArray(record.iterations) ||
    record.iterations.length > MAX_PERSISTED_RALPH_ITERATIONS
  ) {
    return null;
  }

  const iterations: RalphIteration[] = [];
  const indexes = new Set<number>();
  for (const rawIteration of record.iterations) {
    const iteration = normalizePersistedRalphIteration(rawIteration, config.iterations);
    if (!iteration || indexes.has(iteration.index)) return null;
    indexes.add(iteration.index);
    iterations.push(iteration);
  }
  iterations.sort((left, right) => left.index - right.index);

  if (record.stopReason === undefined) {
    return {
      config,
      status: record.status,
      currentIteration: record.currentIteration,
      iterations,
      updatedAt: record.updatedAt,
    };
  }
  if (!isRalphStopReason(record.stopReason)) return null;
  return {
    config,
    status: record.status,
    currentIteration: record.currentIteration,
    iterations,
    updatedAt: record.updatedAt,
    stopReason: record.stopReason,
  };
}

function normalizePersistedRalphConfig(value: unknown): RalphConfig | null {
  const record = asRecord(value);
  if (!record) return null;
  const managerSessionId = getBoundedString(record.managerSessionId, MAX_RALPH_ID_LENGTH);
  const planDocPath = getBoundedString(record.planDocPath, MAX_RALPH_PATH_LENGTH);
  const promptTemplate = getBoundedString(record.promptTemplate, MAX_RALPH_PROMPT_LENGTH);
  if (
    !managerSessionId ||
    !isSafeRalphRecordKey(managerSessionId) ||
    !planDocPath ||
    !promptTemplate ||
    !isBoundedInteger(record.iterations, 1, MAX_RALPH_ITERATIONS) ||
    !isPermissionMode(record.permissionMode) ||
    !isSafeInteger(record.createdAt)
  ) {
    return null;
  }

  const model =
    record.model === null ? null : normalizePersistedRalphModel(record.model) || undefined;
  const agent =
    record.agent === null ? null : getBoundedString(record.agent, MAX_RALPH_ID_LENGTH) || undefined;
  if (model === undefined || agent === undefined) return null;
  return {
    managerSessionId,
    planDocPath,
    iterations: record.iterations,
    promptTemplate,
    permissionMode: record.permissionMode,
    model,
    agent,
    createdAt: record.createdAt,
  };
}

function normalizeRalphConfigForMutation(config: RalphConfig): RalphConfig | null {
  if (!Number.isSafeInteger(config.iterations) || config.iterations < 1) return null;
  return normalizePersistedRalphConfig({
    ...config,
    iterations: Math.min(config.iterations, MAX_RALPH_ITERATIONS),
  });
}

function normalizePersistedRalphModel(value: unknown): RalphConfig['model'] | null {
  const record = asRecord(value);
  const providerID = getBoundedString(record?.providerID, MAX_RALPH_ID_LENGTH);
  const modelID = getBoundedString(record?.modelID, MAX_RALPH_ID_LENGTH);
  if (!record || !providerID || !modelID) return null;
  if (record.variant === undefined) return { providerID, modelID };
  const variant = getBoundedString(record.variant, MAX_RALPH_ID_LENGTH);
  return variant ? { providerID, modelID, variant } : null;
}

function normalizePersistedRalphIteration(value: unknown, maxIndex: number): RalphIteration | null {
  const record = asRecord(value);
  if (
    !record ||
    !isBoundedInteger(record.index, 1, maxIndex) ||
    !isRalphIterationStatus(record.status) ||
    !isNullableBoundedString(record.childSessionId, MAX_RALPH_ID_LENGTH) ||
    !isNullableSafeInteger(record.startedAt) ||
    !isNullableSafeInteger(record.endedAt) ||
    !Array.isArray(record.filesChanged) ||
    record.filesChanged.length > MAX_RALPH_FILES_CHANGED
  ) {
    return null;
  }
  const filesChanged = record.filesChanged.map((path) =>
    getBoundedString(path, MAX_RALPH_PATH_LENGTH)
  );
  if (!filesChanged.every((path): path is string => path !== null)) return null;
  const verification = normalizePersistedRalphVerification(record.verification);
  if (!verification) return null;
  const phase = getRalphIterationPhase(record.phase);
  if (record.phase !== undefined && !phase) return null;

  const iteration: RalphIteration = {
    index: record.index,
    childSessionId: record.childSessionId,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    filesChanged,
    verification,
    ...(phase ? { phase } : {}),
  };
  if (record.tokens !== undefined) {
    const tokens = normalizePersistedRalphTokens(record.tokens);
    if (!tokens) return null;
    iteration.tokens = tokens;
  }
  if (record.cost !== undefined) {
    if (!isBoundedNumber(record.cost, 0, Number.MAX_SAFE_INTEGER)) return null;
    iteration.cost = record.cost;
  }
  if (record.note !== undefined) {
    const note = getBoundedString(record.note, MAX_RALPH_NOTE_LENGTH);
    if (!note) return null;
    iteration.note = note;
  }
  if (record.repairSessionIds !== undefined) {
    if (
      !Array.isArray(record.repairSessionIds) ||
      record.repairSessionIds.length > MAX_RALPH_REPAIR_SESSIONS
    ) {
      return null;
    }
    const repairSessionIds = record.repairSessionIds.map((id) =>
      getBoundedString(id, MAX_RALPH_ID_LENGTH)
    );
    if (!repairSessionIds.every((id): id is string => id !== null)) return null;
    iteration.repairSessionIds = repairSessionIds;
  }
  return iteration;
}

function getRalphIterationPhase(value: unknown): RalphIteration['phase'] | null {
  return value === 'primary' || value === 'verification' || value === 'repair' ? value : null;
}

function normalizePersistedRalphVerification(
  value: unknown
): RalphIteration['verification'] | null {
  const record = asRecord(value);
  if (!record) return null;
  const entries = Object.entries(record);
  if (entries.length > MAX_RALPH_VERIFICATIONS) return null;
  const verification: RalphIteration['verification'] = {};
  for (const [name, verdict] of entries) {
    if (!isSafeRalphRecordKey(name, 100) || !isRalphVerificationVerdict(verdict)) return null;
    verification[name] = verdict;
  }
  return verification;
}

function normalizePersistedRalphTokens(
  value: unknown
): NonNullable<RalphIteration['tokens']> | null {
  const record = asRecord(value);
  if (
    !record ||
    !isSafeInteger(record.input) ||
    !isSafeInteger(record.output) ||
    !isSafeInteger(record.reasoning) ||
    !isSafeInteger(record.cacheRead) ||
    !isSafeInteger(record.cacheWrite) ||
    !isSafeInteger(record.total)
  ) {
    return null;
  }
  return {
    input: record.input,
    output: record.output,
    reasoning: record.reasoning,
    cacheRead: record.cacheRead,
    cacheWrite: record.cacheWrite,
    total: record.total,
  };
}

function getBoundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return isSafeInteger(value) && value >= min && value <= max;
}

function isBoundedNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value === null || isSafeInteger(value);
}

function isNullableBoundedString(value: unknown, maxLength: number): value is string | null {
  return value === null || getBoundedString(value, maxLength) !== null;
}

function isSafeRalphRecordKey(value: string, maxLength = MAX_RALPH_ID_LENGTH): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    value !== '__proto__' &&
    value !== 'prototype' &&
    value !== 'constructor' &&
    !Object.prototype.hasOwnProperty.call(Object.prototype, value)
  );
}

function isPermissionMode(value: unknown): value is RalphConfig['permissionMode'] {
  return value === 'default' || value === 'auto' || value === 'full';
}

function isRalphStatus(value: unknown): value is RalphRun['status'] {
  return (
    value === 'running' ||
    value === 'paused' ||
    value === 'stopped' ||
    value === 'done' ||
    value === 'incomplete' ||
    value === 'failed'
  );
}

function isTerminalRalphStatus(status: RalphRun['status']): boolean {
  return (
    status === 'stopped' || status === 'done' || status === 'incomplete' || status === 'failed'
  );
}

function isRalphStopReason(value: unknown): value is RalphStopReason {
  return (
    value === 'iteration_limit' ||
    value === 'iteration_limit_with_gap' ||
    value === 'consecutive_passes' ||
    value === 'done_marker' ||
    value === 'manual_stop' ||
    value === 'iteration_error'
  );
}

function isRalphIterationStatus(value: unknown): value is RalphIteration['status'] {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'passed' ||
    value === 'failed' ||
    value === 'aborted'
  );
}

function isRalphVerificationVerdict(
  value: unknown
): value is RalphIteration['verification'][string] {
  return value === 'pass' || value === 'fail' || value === 'skipped';
}
