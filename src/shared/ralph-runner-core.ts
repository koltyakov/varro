import type {
  RalphConfig,
  RalphIteration,
  RalphIterationStatus,
  RalphRun,
  RalphStopReason,
  RalphVerificationVerdict,
} from './ralph';
import { RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT } from './ralph';
import { getSessionPermissionRulesForMode } from './permission-rules';
import {
  buildIterationPrompt,
  buildRepairSubAgentPrompt,
  buildVerificationPrompt,
} from './ralph-prompts';

/**
 * Host-agnostic Ralph orchestration loop. All environment access goes
 * through {@link RalphRunnerPorts} so the same loop runs on the extension
 * host in production, in the e2e harness, and against fakes in unit tests.
 * The store is the single source of truth for run state; the runner only
 * tracks which manager sessions have a live loop in this process.
 */

export type RalphRunnerStore = {
  getRun(managerSessionId: string): RalphRun | null;
  getAllRuns(): RalphRun[];
  startRun(config: RalphConfig): void;
  setStatus(
    managerSessionId: string,
    status: RalphRun['status'],
    stopReason?: RalphStopReason
  ): void;
  addIterations(managerSessionId: string, count: number): void;
  upsertIteration(managerSessionId: string, iteration: RalphIteration): void;
};

export type RalphSessionSummary = { id: string; parentID?: string | null };

export type RalphSessionStatus =
  | { type: 'active' }
  | { type: 'idle' }
  | { type: 'missing' }
  | { type: 'error'; message: string }
  | { type: 'unknown'; message: string };

export type RalphMessageEntry = {
  info: {
    role?: string;
    cost?: number;
    time?: { created?: number; completed?: number };
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
  };
  parts: Array<{ type: string; text?: string; files?: string[] }>;
};

export type RalphSendBody = {
  parts: Array<{ type: 'text'; text: string }>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  variant?: string;
};

export type RalphRunnerPorts = {
  store: RalphRunnerStore;
  createSession(
    args: {
      title: string;
      permission: ReturnType<typeof getSessionPermissionRulesForMode>;
      parentID: string;
    },
    signal: AbortSignal
  ): Promise<string>;
  sendPrompt(sessionId: string, body: RalphSendBody, signal: AbortSignal): Promise<void>;
  abortSession(sessionId: string, signal: AbortSignal): Promise<void>;
  listSessions(signal: AbortSignal): Promise<RalphSessionSummary[]>;
  listMessages(sessionId: string, signal: AbortSignal): Promise<RalphMessageEntry[]>;
  getSessionStatus(sessionId: string, signal: AbortSignal): Promise<RalphSessionStatus>;
  /** Subscribe to session status signals; returns an unsubscribe function. */
  onSessionStatus(listener: (sessionID: string, status: RalphSessionStatus) => void): () => void;
  /** Maximum idle wait per prompt. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
  /** Authoritative status polling interval. Defaults to one second. */
  idlePollIntervalMs?: number;
  /** Grace before poll-only idle/missing states are trusted. Defaults to 250ms. */
  idleAdmissionGraceMs?: number;
  readWorkspaceFile(path: string, signal: AbortSignal): Promise<string | null>;
  /** Normalize a model variant name for a model id; null drops the variant. */
  normalizeVariant(modelID: string, variant: string): string | null;
  logError(context: string, err: unknown): void;
};

export type RalphRunner = {
  isActive(managerSessionId: string): boolean;
  activeIds(): string[];
  start(config: RalphConfig): Promise<void>;
  stop(managerSessionId: string): void;
  pause(managerSessionId: string): void;
  resume(managerSessionId: string): Promise<void>;
  reattachAll(): void;
  shutdown(): Promise<void>;
};

type ActiveRunState = {
  managerSessionId: string;
  abortController: AbortController;
  currentChildId: string | null;
  childAbortRequests: Map<string, Promise<void>>;
  cleanupAbortController: AbortController;
  cancelIdleWait: (() => void) | null;
  shutdownRequested: boolean;
};

const MAX_ITERATION_REPAIR_ATTEMPTS = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_POLL_INTERVAL_MS = 1_000;
const DEFAULT_IDLE_ADMISSION_GRACE_MS = 250;

class RalphRunCancelledError extends Error {
  constructor(managerSessionId: string) {
    super(`Ralph run ${managerSessionId} was stopped`);
  }
}

function throwIfRunCancelled(state: ActiveRunState): void {
  if (state.abortController.signal.aborted) {
    throw new RalphRunCancelledError(state.managerSessionId);
  }
}

function isRunCancelled(state: ActiveRunState, err: unknown): boolean {
  return state.abortController.signal.aborted || err instanceof RalphRunCancelledError;
}

export function createRalphRunner(ports: RalphRunnerPorts): RalphRunner {
  const activeRuns = new Map<string, ActiveRunState>();
  const runPromises = new Map<string, Promise<void>>();
  let shuttingDown = false;

  const runner: RalphRunner = {
    isActive(managerSessionId: string): boolean {
      return activeRuns.has(managerSessionId);
    },

    activeIds(): string[] {
      return [...activeRuns.keys()];
    },

    async start(config: RalphConfig): Promise<void> {
      if (shuttingDown) return;
      if (
        activeRuns.has(config.managerSessionId) ||
        runPromises.has(config.managerSessionId) ||
        ports.store.getRun(config.managerSessionId)
      ) {
        return;
      }
      ports.store.startRun(config);
      if (!ports.store.getRun(config.managerSessionId)) return;
      await trackRunLoop(config);
    },

    stop(managerSessionId: string): void {
      const active = activeRuns.get(managerSessionId);
      ports.store.setStatus(managerSessionId, 'stopped', 'manual_stop');
      active?.abortController.abort();
      if (active?.currentChildId) {
        void abortChildSession(active, active.currentChildId);
      }
    },

    pause(managerSessionId: string): void {
      ports.store.setStatus(managerSessionId, 'paused');
    },

    async resume(managerSessionId: string): Promise<void> {
      if (shuttingDown) return;
      const run = ports.store.getRun(managerSessionId);
      if (!run) return;
      if (run.status !== 'paused' && run.status !== 'failed' && run.status !== 'incomplete') return;
      if (run.status === 'incomplete') {
        ports.store.addIterations(managerSessionId, RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT);
      }
      const resumedRun = ports.store.getRun(managerSessionId);
      if (!resumedRun) return;
      ports.store.setStatus(managerSessionId, 'running');
      await trackRunLoop(resumedRun.config);
    },

    reattachAll(): void {
      if (shuttingDown) return;
      for (const run of ports.store.getAllRuns()) {
        if (run.status === 'running' && !activeRuns.has(run.config.managerSessionId)) {
          void trackRunLoop(run.config).catch((err) => {
            ports.logError('reattach failed', err);
          });
        }
      }
    },

    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const state of activeRuns.values()) {
        state.shutdownRequested = true;
        state.abortController.abort();
      }
      await Promise.allSettled(runPromises.values());
    },
  };

  function trackRunLoop(config: RalphConfig): Promise<void> {
    const existing = runPromises.get(config.managerSessionId);
    if (existing) return existing;
    const promise = runLoop(config);
    runPromises.set(config.managerSessionId, promise);
    const cleanup = () => {
      if (runPromises.get(config.managerSessionId) === promise) {
        runPromises.delete(config.managerSessionId);
      }
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  function awaitPort<T>(
    state: ActiveRunState,
    operation: (signal: AbortSignal) => Promise<T>,
    onLateValue?: (value: T) => void
  ): Promise<T> {
    throwIfRunCancelled(state);
    let operationPromise: Promise<T>;
    try {
      operationPromise = Promise.resolve(operation(state.abortController.signal));
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise<T>((resolve, reject) => {
      const signal = state.abortController.signal;
      let settled = false;
      const cancel = () => {
        if (settled) return;
        settled = true;
        reject(new RalphRunCancelledError(state.managerSessionId));
      };
      signal.addEventListener('abort', cancel, { once: true });
      operationPromise.then(
        (value) => {
          if (settled) {
            onLateValue?.(value);
            return;
          }
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

  async function runLoop(initialConfig: RalphConfig): Promise<void> {
    const managerSessionId = initialConfig.managerSessionId;
    if (activeRuns.has(managerSessionId)) return;
    const state: ActiveRunState = {
      managerSessionId,
      abortController: new AbortController(),
      currentChildId: null,
      childAbortRequests: new Map(),
      cleanupAbortController: new AbortController(),
      cancelIdleWait: null,
      shutdownRequested: false,
    };
    activeRuns.set(managerSessionId, state);

    try {
      while (true) {
        const run = ports.store.getRun(managerSessionId);
        if (!run || run.status !== 'running') break;

        const unsettledIteration = findUnsettledIteration(run);
        if (unsettledIteration) {
          try {
            const settled = await settlePersistedIteration(state, run.config, unsettledIteration);
            throwIfRunCancelled(state);
            ports.store.upsertIteration(managerSessionId, settled);
            state.currentChildId = null;
          } catch (err) {
            if (isRunCancelled(state, err)) {
              if (state.currentChildId) abortChildSession(state, state.currentChildId);
              if (!state.shutdownRequested) {
                ports.store.upsertIteration(managerSessionId, {
                  ...unsettledIteration,
                  status: 'aborted',
                  endedAt: Date.now(),
                });
              }
              break;
            }
            failIteration(managerSessionId, unsettledIteration, err);
            break;
          }
          continue;
        }

        const stopReason = await getStopReason(run, state);
        throwIfRunCancelled(state);
        const boundaryRun = ports.store.getRun(managerSessionId);
        if (!boundaryRun || boundaryRun.status !== 'running') break;
        if (boundaryRun.config.iterations !== run.config.iterations) continue;
        if (stopReason) {
          // If we ran out of iterations while there are still verification
          // gaps or unchecked plan items, mark the run as `incomplete` (not
          // `done` and not `failed`) so the UI can distinguish "ran out of
          // budget before convergence" from a hard error or a clean finish.
          const terminalStatus: 'done' | 'incomplete' =
            stopReason === 'iteration_limit_with_gap' ? 'incomplete' : 'done';
          ports.store.setStatus(managerSessionId, terminalStatus, stopReason);
          break;
        }

        // Model and iteration-budget updates are authoritative at boundaries;
        // keep one config snapshot only for the iteration now being launched.
        const config = boundaryRun.config;
        const nextIndex = nextIterationIndex(boundaryRun);

        const previousIteration = lastCompletedIteration(boundaryRun);
        let iteration = createPendingIteration(nextIndex);
        ports.store.upsertIteration(managerSessionId, iteration);

        try {
          const childId = await createChildSession(state, config, nextIndex);
          state.currentChildId = childId;
          if (state.abortController.signal.aborted) {
            abortChildSession(state, childId);
            throwIfRunCancelled(state);
          }
          iteration = {
            ...iteration,
            childSessionId: childId,
            status: 'running',
            phase: 'primary',
            startedAt: Date.now(),
          };
          ports.store.upsertIteration(managerSessionId, iteration);

          const prompt = await buildIterationPrompt({
            config,
            iterationIndex: nextIndex,
            previousIteration,
            readFile: async (path) => {
              return awaitPort(state, (signal) => ports.readWorkspaceFile(path, signal));
            },
          });
          throwIfRunCancelled(state);
          const finalIteration = await runIterationUntilSettled({
            config,
            state,
            childId,
            iteration,
            initialPrompt: prompt,
          });
          throwIfRunCancelled(state);
          ports.store.upsertIteration(managerSessionId, finalIteration);
          state.currentChildId = null;

          if (finalIteration.status === 'aborted') {
            // Stop was triggered externally; loop will exit on next status check.
          }
        } catch (err) {
          if (isRunCancelled(state, err)) {
            if (state.currentChildId) {
              abortChildSession(state, state.currentChildId);
            }
            if (!state.shutdownRequested) {
              const latestIteration = getIteration(managerSessionId, nextIndex) ?? iteration;
              ports.store.upsertIteration(managerSessionId, {
                ...latestIteration,
                status: 'aborted',
                endedAt: Date.now(),
              });
            }
            break;
          }
          ports.logError(`iteration ${nextIndex} failed`, err);
          const latestIteration = getIteration(managerSessionId, nextIndex) ?? iteration;
          ports.store.upsertIteration(managerSessionId, {
            ...latestIteration,
            status: 'failed',
            endedAt: Date.now(),
            note: err instanceof Error ? err.message : String(err),
          });
          ports.store.setStatus(managerSessionId, 'failed', 'iteration_error');
          break;
        }
      }
    } catch (err) {
      if (!isRunCancelled(state, err)) throw err;
      if (state.currentChildId) {
        abortChildSession(state, state.currentChildId);
      }
    } finally {
      cleanupActive(managerSessionId);
    }
  }

  function cleanupActive(managerSessionId: string) {
    const state = activeRuns.get(managerSessionId);
    if (!state) return;
    state.cancelIdleWait?.();
    state.cancelIdleWait = null;
    state.currentChildId = null;
    state.cleanupAbortController.abort();
    activeRuns.delete(managerSessionId);
  }

  function abortChildSession(state: ActiveRunState, childId: string): void {
    const existing = state.childAbortRequests.get(childId);
    if (existing) return;

    let request: Promise<void>;
    try {
      request = Promise.resolve(
        ports.abortSession(childId, state.cleanupAbortController.signal)
      ).catch(() => {});
    } catch {
      request = Promise.resolve();
    }
    state.childAbortRequests.set(childId, request);
  }

  function failIteration(managerSessionId: string, iteration: RalphIteration, err: unknown): void {
    ports.logError(`iteration ${iteration.index} failed`, err);
    ports.store.upsertIteration(managerSessionId, {
      ...iteration,
      status: 'failed',
      endedAt: Date.now(),
      note: err instanceof Error ? err.message : String(err),
    });
    ports.store.setStatus(managerSessionId, 'failed', 'iteration_error');
  }

  function getIteration(managerSessionId: string, iterationIndex: number): RalphIteration | null {
    return (
      ports.store
        .getRun(managerSessionId)
        ?.iterations.find((iteration) => iteration.index === iterationIndex) ?? null
    );
  }

  async function getStopReason(
    run: RalphRun,
    state: ActiveRunState
  ): Promise<RalphStopReason | null> {
    const lastCompleted = lastCompletedIteration(run);
    const hasOutstandingVerificationFailure =
      !!lastCompleted && hasFailedVerdict(lastCompleted.verification);
    const planContent = await readPlanContentSafe(run.config.planDocPath, state);
    throwIfRunCancelled(state);
    const planIncomplete =
      !!planContent && planHasOutstandingTasks(planContent) && !planHasDoneMarker(planContent);

    if (nextIterationIndex(run) > run.config.iterations) {
      // Iteration cap is the hard exit. Surface a clearer "with_gap" reason
      // when work is verifiably incomplete so the UI can flag the gap rather
      // than reporting a clean completion.
      if (hasOutstandingVerificationFailure || planIncomplete) {
        return 'iteration_limit_with_gap';
      }
      return 'iteration_limit';
    }
    // Block soft completion while the most recent completed iteration still has
    // outstanding verification failures. Plan-driven runs should only finish
    // early when the plan explicitly says it is complete.
    if (planContent && planHasDoneMarker(planContent)) {
      if (hasOutstandingVerificationFailure) return null;
      return 'done_marker';
    }
    return null;
  }

  async function readPlanContentSafe(
    planDocPath: string,
    state: ActiveRunState
  ): Promise<string | null> {
    let content: string | null = null;
    try {
      content = await awaitPort(state, (signal) => ports.readWorkspaceFile(planDocPath, signal));
    } catch {
      throwIfRunCancelled(state);
      // Plan reads are best-effort for stop-condition checks.
    }
    throwIfRunCancelled(state);
    return content ?? null;
  }

  async function createChildSession(
    state: ActiveRunState,
    config: RalphConfig,
    iterationIndex: number
  ): Promise<string> {
    return awaitPort(
      state,
      (signal) =>
        ports.createSession(
          {
            title: `Ralph iter ${iterationIndex} · ${planDocLabel(config.planDocPath)}`,
            permission: getSessionPermissionRulesForMode(config.permissionMode, 'create'),
            parentID: config.managerSessionId,
          },
          signal
        ),
      (childId) => abortChildSession(state, childId)
    );
  }

  async function sendPrompt(
    state: ActiveRunState,
    childId: string,
    prompt: string,
    config: RalphConfig
  ): Promise<void> {
    const body: RalphSendBody = {
      parts: [{ type: 'text', text: prompt }],
    };
    if (config.model) {
      body.model = { providerID: config.model.providerID, modelID: config.model.modelID };
      if (config.model.variant) {
        body.variant =
          ports.normalizeVariant(config.model.modelID, config.model.variant) || undefined;
      }
    }
    if (config.agent) body.agent = config.agent;
    await awaitPort(state, (signal) => ports.sendPrompt(childId, body, signal));
  }

  async function sendPromptAndWaitForIdle(
    state: ActiveRunState,
    childId: string,
    prompt: string,
    config: RalphConfig
  ): Promise<void> {
    // Arm idle listeners before sending so a fast child can't emit `idle`
    // between the send resolving and the wait subscription being attached.
    const pollingReady = createDeferred<void>();
    const idlePromise = waitForIdle(state, childId, pollingReady.promise);
    try {
      await sendPrompt(state, childId, prompt, config);
      pollingReady.resolve();
      throwIfRunCancelled(state);
      const idleResult = await idlePromise;
      throwIfRunCancelled(state);
      if (idleResult.type === 'timeout') {
        abortChildSession(state, childId);
        throwIfRunCancelled(state);
        throw new Error(
          `Ralph session ${childId} did not become idle within ${idleTimeoutMs}ms after a prompt; check whether the child is still running or idle event delivery was interrupted`
        );
      }
      if (idleResult.type === 'error') {
        throw idleResult.error;
      }
    } catch (err) {
      pollingReady.resolve();
      state.cancelIdleWait?.();
      throw err;
    }
  }

  async function runIterationUntilSettled(args: {
    config: RalphConfig;
    state: ActiveRunState;
    childId: string;
    iteration: RalphIteration;
    initialPrompt: string;
  }): Promise<RalphIteration> {
    const { config, state, childId, initialPrompt } = args;
    let iteration = args.iteration;
    const iterationIndex = iteration.index;
    const startedAt = iteration.startedAt ?? Date.now();

    // 1) Run the iteration's primary work in the iteration child session.
    await sendPromptAndWaitForIdle(state, childId, initialPrompt, config);
    throwIfRunCancelled(state);

    // 2) Parent dynamically requires verification. The verification command
    //    set is NOT hardcoded in the child's initial prompt; the parent
    //    injects it as a follow-up message after the work settles.
    iteration = persistIterationPhase(config.managerSessionId, iteration, 'verification');
    await runVerificationOnSession(config, state, childId);
    throwIfRunCancelled(state);

    iteration = await summarizeIteration({
      state,
      childId,
      iterationIndex,
      startedAt,
      phase: 'verification',
    });
    throwIfRunCancelled(state);

    if (iteration.status !== 'failed') return iteration;

    // 3) Verification failed - spawn a separate repair sub-agent. The repair
    //    child session is filed under the same manager so its history
    //    doesn't pollute the iteration session.
    const repairSessionIds: string[] = [];
    for (let attempt = 1; attempt <= MAX_ITERATION_REPAIR_ATTEMPTS; attempt += 1) {
      let repairChildId: string;
      try {
        repairChildId = await createRepairChildSession(state, config, iterationIndex, attempt);
        state.currentChildId = repairChildId;
        if (state.abortController.signal.aborted) {
          abortChildSession(state, repairChildId);
          throwIfRunCancelled(state);
        }
      } catch (err) {
        throwIfRunCancelled(state);
        ports.logError(`iteration ${iterationIndex} repair-spawn failed`, err);
        break;
      }
      repairSessionIds.push(repairChildId);
      iteration = persistIterationPhase(config.managerSessionId, iteration, 'repair', {
        repairSessionIds: [...repairSessionIds],
      });

      const repairPrompt = buildRepairSubAgentPrompt({
        config,
        failedIteration: iteration,
        attempt,
        maxAttempts: MAX_ITERATION_REPAIR_ATTEMPTS,
      });
      await sendPromptAndWaitForIdle(state, repairChildId, repairPrompt, config);
      throwIfRunCancelled(state);

      iteration = persistIterationPhase(config.managerSessionId, iteration, 'verification');
      await runVerificationOnSession(config, state, repairChildId);
      throwIfRunCancelled(state);

      const repairSummary = await summarizeIteration({
        state,
        childId: repairChildId,
        iterationIndex,
        startedAt,
        phase: 'verification',
      });
      throwIfRunCancelled(state);

      iteration = mergeRepairResult(iteration, repairSummary, repairSessionIds);
      if (iteration.status !== 'failed') return iteration;
    }

    // Restore currentChildId pointer to the iteration session for any
    // subsequent stop/abort wiring.
    state.currentChildId = childId;
    return { ...iteration, repairSessionIds };
  }

  function persistIterationPhase(
    managerSessionId: string,
    iteration: RalphIteration,
    phase: NonNullable<RalphIteration['phase']>,
    updates: Partial<RalphIteration> = {}
  ): RalphIteration {
    const next: RalphIteration = {
      ...iteration,
      ...updates,
      phase,
      status: 'running',
      endedAt: null,
    };
    ports.store.upsertIteration(managerSessionId, next);
    return next;
  }

  async function runVerificationOnSession(
    config: RalphConfig,
    state: ActiveRunState,
    sessionId: string
  ): Promise<void> {
    const verificationPrompt = buildVerificationPrompt(config);
    await sendPromptAndWaitForIdle(state, sessionId, verificationPrompt, config);
    throwIfRunCancelled(state);
  }

  async function createRepairChildSession(
    state: ActiveRunState,
    config: RalphConfig,
    iterationIndex: number,
    attempt: number
  ): Promise<string> {
    return awaitPort(
      state,
      (signal) =>
        ports.createSession(
          {
            title: `Ralph iter ${iterationIndex} repair ${attempt} · ${planDocLabel(config.planDocPath)}`,
            permission: getSessionPermissionRulesForMode(config.permissionMode, 'create'),
            parentID: config.managerSessionId,
          },
          signal
        ),
      (childId) => abortChildSession(state, childId)
    );
  }

  /**
   * Resolve every session that participated in this iteration so token usage
   * from any sub-agents (and their nested sub-sub-agents) spawned by the
   * Task tool gets folded into the iteration's totals. Falls back to just
   * the iteration's own child session when the session list cannot be
   * fetched.
   */
  async function collectIterationSessionIds(
    state: ActiveRunState,
    childId: string
  ): Promise<string[]> {
    let sessions: RalphSessionSummary[];
    try {
      sessions = await awaitPort(state, (signal) => ports.listSessions(signal));
    } catch {
      throwIfRunCancelled(state);
      return [childId];
    }
    throwIfRunCancelled(state);
    const treeIds = collectSessionTreeIds(childId, sessions);
    return treeIds.length > 0 ? treeIds : [childId];
  }

  type IdleWaitResult =
    | { type: 'idle' }
    | { type: 'cancelled' }
    | { type: 'timeout' }
    | { type: 'error'; error: unknown };

  const idleTimeoutMs = ports.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idlePollIntervalMs = ports.idlePollIntervalMs ?? DEFAULT_IDLE_POLL_INTERVAL_MS;
  const idleAdmissionGraceMs = ports.idleAdmissionGraceMs ?? DEFAULT_IDLE_ADMISSION_GRACE_MS;

  function finishFromSessionStatus(
    childId: string,
    status: RalphSessionStatus,
    finish: (result: IdleWaitResult) => void
  ): void {
    if (status.type === 'idle') finish({ type: 'idle' });
    if (status.type === 'missing') {
      finish({ type: 'error', error: sessionMissingError(childId) });
    }
    if (status.type === 'error' || status.type === 'unknown') {
      finish({ type: 'error', error: sessionTerminalError(childId, status.message) });
    }
  }

  function waitForIdle(
    state: ActiveRunState,
    childId: string,
    pollingReady: Promise<void> = Promise.resolve()
  ): Promise<IdleWaitResult> {
    return new Promise<IdleWaitResult>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let pollingStartedAt: number | null = null;
      let observedActive = false;
      const signal = state.abortController.signal;
      const finish = (result: IdleWaitResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (pollTimer) clearTimeout(pollTimer);
        signal.removeEventListener('abort', cancel);
        unsubscribe?.();
        unsubscribe = null;
        if (state.cancelIdleWait === cancel) state.cancelIdleWait = null;
        resolve(result);
      };
      const cancel = () => finish({ type: 'cancelled' });
      state.cancelIdleWait = cancel;
      signal.addEventListener('abort', cancel, { once: true });
      timeout = setTimeout(() => finish({ type: 'timeout' }), idleTimeoutMs);

      try {
        unsubscribe = ports.onSessionStatus((sessionID, status) => {
          if (sessionID !== childId) return;
          if (status.type === 'active') {
            observedActive = true;
            return;
          }
          // SSE completion is direct evidence from the running session and
          // remains the zero-delay path for genuinely fast turns.
          finishFromSessionStatus(childId, status, finish);
        });
        if (settled) {
          unsubscribe();
          unsubscribe = null;
        }
      } catch (error) {
        finish({ type: 'error', error });
      }

      void pollingReady.then(
        () => {
          if (!settled) {
            pollingStartedAt = Date.now();
            void poll();
          }
        },
        (error) => finish({ type: 'error', error })
      );

      if (signal.aborted) cancel();

      async function poll(): Promise<void> {
        if (settled) return;
        try {
          const status = await awaitPort(state, (portSignal) =>
            ports.getSessionStatus(childId, portSignal)
          );
          if (settled) return;
          if (status.type === 'active') {
            observedActive = true;
          } else if (status.type === 'idle' || status.type === 'missing') {
            const elapsed = Date.now() - (pollingStartedAt ?? Date.now());
            if (observedActive || elapsed >= idleAdmissionGraceMs) {
              finishFromSessionStatus(childId, status, finish);
              return;
            }
            const remainingGrace = idleAdmissionGraceMs - elapsed;
            pollTimer = setTimeout(() => void poll(), Math.min(idlePollIntervalMs, remainingGrace));
            return;
          } else {
            finishFromSessionStatus(childId, status, finish);
            return;
          }
        } catch (err) {
          if (isRunCancelled(state, err)) {
            cancel();
            return;
          }
          // SSE remains authoritative while transient polling failures recover.
          ports.logError(`session ${childId} status poll failed`, err);
        }
        if (!settled) pollTimer = setTimeout(() => void poll(), idlePollIntervalMs);
      }
    });
  }

  async function settlePersistedIteration(
    state: ActiveRunState,
    config: RalphConfig,
    iteration: RalphIteration
  ): Promise<RalphIteration> {
    const childId = iteration.childSessionId;
    if (!childId) {
      return { ...iteration, status: 'aborted', endedAt: Date.now() };
    }

    const phase = iteration.phase ?? 'primary';
    const repairChildId = iteration.repairSessionIds?.at(-1);
    const isRepairSession = phase !== 'primary' && repairChildId !== undefined;
    const activeSessionId = isRepairSession ? repairChildId : childId;
    if (phase === 'repair' && !repairChildId) {
      throw new Error(
        `Ralph iteration ${iteration.index} was persisted in repair phase without a repair session; manual intervention is required`
      );
    }

    state.currentChildId = activeSessionId;
    const status = await awaitPort(state, (signal) =>
      ports.getSessionStatus(activeSessionId, signal)
    );
    if (status.type === 'missing') throw sessionMissingError(activeSessionId);
    if (status.type === 'error' || status.type === 'unknown') {
      throw sessionTerminalError(activeSessionId, status.message);
    }
    if (status.type === 'active') {
      const idleResult = await waitForIdle(state, activeSessionId);
      throwIfRunCancelled(state);
      if (idleResult.type === 'timeout') {
        abortChildSession(state, activeSessionId);
        throw new Error(
          `Ralph session ${activeSessionId} did not become idle within ${idleTimeoutMs}ms while reattaching; check the child session before resuming the run`
        );
      }
      if (idleResult.type === 'error') throw idleResult.error;
    }

    let summary: RalphIteration | null = null;
    if (phase === 'verification') {
      summary = await summarizeIteration({
        state,
        childId: activeSessionId,
        iterationIndex: iteration.index,
        startedAt: iteration.startedAt ?? Date.now(),
        phase: 'verification',
        requireVerificationPromptArtifact: true,
      });
    } else {
      // A persisted primary/repair phase may have been written before its
      // prompt was admitted. Require actual assistant output before advancing
      // to verification rather than verifying an empty session.
      await summarizeIteration({
        state,
        childId: activeSessionId,
        iterationIndex: iteration.index,
        startedAt: iteration.startedAt ?? Date.now(),
        phase,
      });
    }

    if (!summary || Object.keys(summary.verification).length === 0) {
      persistIterationPhase(config.managerSessionId, iteration, 'verification');
      await runVerificationOnSession(config, state, activeSessionId);
      summary = await summarizeIteration({
        state,
        childId: activeSessionId,
        iterationIndex: iteration.index,
        startedAt: iteration.startedAt ?? Date.now(),
        phase: 'verification',
      });
    }

    return isRepairSession
      ? mergeRepairResult(iteration, summary, iteration.repairSessionIds ?? [])
      : summary;
  }

  async function summarizeIteration(args: {
    state: ActiveRunState;
    childId: string;
    iterationIndex: number;
    startedAt: number;
    phase?: RalphIteration['phase'];
    requireVerificationPromptArtifact?: boolean;
  }): Promise<RalphIteration> {
    const { state, childId, iterationIndex, startedAt, phase, requireVerificationPromptArtifact } =
      args;
    let lastAssistantText = '';
    const filesChangedSet = new Set<string>();
    const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    // Walk the iteration's session tree so tokens from any sub-agents
    // spawned by the Task tool (and their nested sub-sub-agents) are
    // accumulated into the iteration's totals - matching how the chat
    // popup shows in/out for a session, but rolled up across the entire
    // iteration's work.
    const sessionIds = await collectIterationSessionIds(state, childId);
    throwIfRunCancelled(state);
    const messagesPerSession = await Promise.all(
      sessionIds.map(async (sid) => {
        try {
          return await awaitPort(state, (signal) => ports.listMessages(sid, signal));
        } catch (err) {
          throwIfRunCancelled(state);
          throw new Error(`Failed to read Ralph session ${sid} messages`, { cause: err });
        }
      })
    );
    throwIfRunCancelled(state);
    let iterationMessages: RalphMessageEntry[] = [];
    for (let i = 0; i < sessionIds.length; i += 1) {
      const sid = sessionIds[i];
      const sessionMessages = messagesPerSession[i] ?? [];
      if (sid === childId) iterationMessages = sessionMessages;
      for (const m of sessionMessages) {
        for (const p of m.parts) {
          if (p.type === 'patch') {
            for (const f of p.files || []) filesChangedSet.add(f);
          }
        }
        if (m.info.role === 'assistant') {
          const t = m.info.tokens;
          if (t) {
            tokens.input += t.input ?? 0;
            tokens.output += t.output ?? 0;
            tokens.reasoning += t.reasoning ?? 0;
            tokens.cacheRead += t.cache?.read ?? 0;
            tokens.cacheWrite += t.cache?.write ?? 0;
          }
          cost += m.info.cost ?? 0;
        }
      }
    }
    tokens.total = tokens.input + tokens.output + tokens.reasoning;
    const lastAssistantIndex = findLatestMessageIndex(
      iterationMessages,
      (message) => message.info.role === 'assistant'
    );
    const verificationPromptIndex = findLatestMessageIndex(
      iterationMessages,
      isVerificationPromptMessage
    );
    const verificationReportIndex =
      verificationPromptIndex < 0
        ? -1
        : findLatestMessageIndex(
            iterationMessages,
            (message, index) =>
              message.info.role === 'assistant' &&
              messageOccursAfter(iterationMessages, index, verificationPromptIndex)
          );
    const verificationResponseMissing =
      requireVerificationPromptArtifact === true &&
      verificationPromptIndex >= 0 &&
      verificationReportIndex < 0;
    const selectedAssistantIndex = requireVerificationPromptArtifact
      ? verificationReportIndex >= 0
        ? verificationReportIndex
        : lastAssistantIndex
      : lastAssistantIndex;
    if (selectedAssistantIndex >= 0) {
      lastAssistantText = getMessageText(iterationMessages[selectedAssistantIndex]);
    }
    throwIfRunCancelled(state);
    if (!verificationResponseMissing && !lastAssistantText.trim()) {
      throw new Error(
        `Ralph session ${childId} produced no assistant report; inspect the child session before resuming`
      );
    }

    const verification =
      requireVerificationPromptArtifact &&
      (verificationPromptIndex < 0 || verificationReportIndex < 0)
        ? {}
        : parseVerificationVerdicts(lastAssistantText);
    const status = inferIterationStatus(verification);
    const note = verificationResponseMissing
      ? `The verification prompt for Ralph session ${childId} has no assistant response; verification will be resumed`
      : Object.keys(verification).length === 0 &&
          !isInterruptionLikeAssistantText(lastAssistantText)
        ? `No completed verification report was found for Ralph session ${childId}. Last output: ${lastAssistantText.slice(0, 200)}`
        : lastAssistantText.slice(0, 280);

    return {
      index: iterationIndex,
      childSessionId: childId,
      status,
      startedAt,
      endedAt: Date.now(),
      filesChanged: Array.from(filesChangedSet),
      verification,
      ...(phase ? { phase } : {}),
      tokens: tokens.total > 0 ? tokens : undefined,
      cost: cost > 0 ? cost : undefined,
      note,
    };
  }

  return runner;
}

function collectSessionTreeIds(rootId: string, sessions: RalphSessionSummary[]): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const children = childrenByParent.get(session.parentID);
    if (children) children.push(session.id);
    else childrenByParent.set(session.parentID, [session.id]);
  }

  const visited = new Set<string>();
  const pending = [rootId];
  while (pending.length > 0) {
    const currentId = pending.pop();
    if (!currentId || visited.has(currentId)) continue;
    visited.add(currentId);
    for (const childId of childrenByParent.get(currentId) || []) {
      pending.push(childId);
    }
  }
  return [...visited];
}

function findLatestMessageIndex(
  messages: RalphMessageEntry[],
  predicate: (message: RalphMessageEntry, index: number) => boolean
): number {
  let latestIndex = -1;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || !predicate(message, index)) continue;
    if (latestIndex < 0 || messageOccursAfter(messages, index, latestIndex)) latestIndex = index;
  }
  return latestIndex;
}

function messageOccursAfter(
  messages: RalphMessageEntry[],
  candidateIndex: number,
  referenceIndex: number
): boolean {
  const candidateTime = getMessageTime(messages[candidateIndex]);
  const referenceTime = getMessageTime(messages[referenceIndex]);
  if (candidateTime !== null && referenceTime !== null && candidateTime !== referenceTime) {
    return candidateTime > referenceTime;
  }
  return candidateIndex > referenceIndex;
}

function getMessageTime(message: RalphMessageEntry | undefined): number | null {
  const time = message?.info.time?.created ?? message?.info.time?.completed;
  return typeof time === 'number' && Number.isFinite(time) ? time : null;
}

function getMessageText(message: RalphMessageEntry | undefined): string {
  return (
    message?.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n') ?? ''
  );
}

function isVerificationPromptMessage(message: RalphMessageEntry): boolean {
  return (
    message.info.role !== 'assistant' &&
    message.parts.some(
      (part) =>
        part.type === 'text' && part.text?.includes('Ralph manager is requesting verification')
    )
  );
}

function nextIterationIndex(run: RalphRun): number {
  const indexes = run.iterations
    .filter((it) => it.status === 'passed' || it.status === 'failed' || it.status === 'aborted')
    .map((it) => it.index);
  const completed = indexes.length === 0 ? 0 : Math.max(...indexes);
  return completed + 1;
}

function findUnsettledIteration(run: RalphRun): RalphIteration | null {
  let unsettled: RalphIteration | null = null;
  for (const iteration of run.iterations) {
    if (iteration.status !== 'pending' && iteration.status !== 'running') continue;
    if (!unsettled || iteration.index > unsettled.index) unsettled = iteration;
  }
  return unsettled;
}

function sessionTerminalError(childId: string, message: string): Error {
  return new Error(`Ralph session ${childId} failed while waiting for idle: ${message}`);
}

function sessionMissingError(childId: string): Error {
  return new Error(
    `Ralph session ${childId} is missing from the authoritative status snapshot; it may have been deleted, so manual intervention is required`
  );
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function hasFailedVerdict(verification: RalphIteration['verification']): boolean {
  return Object.values(verification).some((v) => v === 'fail');
}

export function planHasDoneMarker(content: string): boolean {
  return /^\uFEFF?DONE(?:\r?\n|$)/.test(content);
}

export function planHasOutstandingTasks(content: string): boolean {
  // Match unchecked boxes in common plan formats: task-list bullets,
  // numbered items, and markdown table cells. Whitespace means "open".
  if (/(^\s*(?:[-*+]|\d+[.)])\s+\[\s\])|(^\s*\|[^\n]*\[\s\])/m.test(content)) {
    return true;
  }

  // Plans may use plain bullets/numbered lists for remaining work. Treat list
  // items without an explicit checked box as outstanding so iteration-limit
  // exits do not claim clean completion while visible tasks remain.
  return /^\s*(?:[-*+]|\d+[.)])\s+(?!\[[xX]\])\S/m.test(content);
}

function lastCompletedIteration(run: RalphRun): RalphIteration | null {
  for (let i = run.iterations.length - 1; i >= 0; i -= 1) {
    const it = run.iterations[i];
    if (it && (it.status === 'passed' || it.status === 'failed')) return it;
  }
  return null;
}

function createPendingIteration(index: number): RalphIteration {
  return {
    index,
    childSessionId: null,
    status: 'pending',
    phase: 'primary',
    startedAt: null,
    endedAt: null,
    filesChanged: [],
    verification: {},
  };
}

function planDocLabel(path: string): string {
  return path.split('/').pop() || path;
}

/**
 * Merge a repair sub-agent's summary back into the failed iteration record.
 * The iteration keeps its original index/childSessionId/startedAt; the
 * verification verdicts and status come from the most recent repair attempt
 * (so a successful repair flips the iteration to `passed`). Files-changed
 * and token totals are unioned/summed across the iteration and its repairs.
 */
function mergeRepairResult(
  iteration: RalphIteration,
  repair: RalphIteration,
  repairSessionIds: string[]
): RalphIteration {
  const filesChanged = Array.from(new Set([...iteration.filesChanged, ...repair.filesChanged]));
  const tokens = sumTokens(iteration.tokens, repair.tokens);
  const cost =
    iteration.cost !== undefined || repair.cost !== undefined
      ? (iteration.cost ?? 0) + (repair.cost ?? 0)
      : undefined;
  return {
    ...iteration,
    status: repair.status,
    phase: repair.phase ?? iteration.phase,
    endedAt: repair.endedAt ?? iteration.endedAt,
    filesChanged,
    verification: repair.verification,
    tokens,
    cost,
    note: repair.note ?? iteration.note,
    repairSessionIds: [...repairSessionIds],
  };
}

function sumTokens(
  a: RalphIteration['tokens'],
  b: RalphIteration['tokens']
): RalphIteration['tokens'] {
  if (!a && !b) return undefined;
  const left = a ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const right = b ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    total: left.total + right.total,
  };
}

/**
 * Extract verdict lines from the model's report. Names are project-driven -
 * we accept any short token followed by `: PASS|FAIL|SKIPPED` (with optional
 * dash separator). Example matches: `lint: PASS`, `cargo build - FAIL`,
 * `mypy: SKIPPED`, `tc:pass`. We walk top-to-bottom and keep the LAST
 * occurrence per name so a model that re-reports a check after fixing it
 * shows the latest line as authoritative.
 */
export function parseVerificationVerdicts(text: string): RalphIteration['verification'] {
  const verdicts: RalphIteration['verification'] = {};
  if (!text) return verdicts;
  // Anchor at line starts so prose like "the lint passed earlier" doesn't
  // get parsed as a verdict. Allow a leading list marker (`- `, `* `, `1.`)
  // and bold/code wrappers (`**lint**`, `` `lint` ``).
  const lineRegex =
    /^[ \t]*(?:[-*+]\s+|\d+[.)]\s+)?[`*_]*([a-z][a-z0-9 _./+-]{0,30}?)[`*_]*\s*[:\--]\s*(pass|fail|skipped)\b/gim;
  for (const match of text.matchAll(lineRegex)) {
    const rawName = match[1];
    const verdict = match[2];
    if (!rawName || !verdict) continue;
    const name = normalizeVerificationName(rawName);
    if (!name) continue;
    verdicts[name] = verdict.toLowerCase() as RalphVerificationVerdict;
  }
  return verdicts;
}

function normalizeVerificationName(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  // Reject obviously prose-y tokens. Verdict names should be short labels.
  if (trimmed.length > 32) return null;
  if (trimmed.split(' ').length > 3) return null;
  return trimmed;
}

function inferIterationStatus(verdicts: RalphIteration['verification']): RalphIterationStatus {
  const reported = Object.values(verdicts);
  if (reported.length === 0) return 'failed';
  if (reported.some((v) => v === 'fail')) return 'failed';
  return 'passed';
}

function isInterruptionLikeAssistantText(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('usage limit') ||
    normalized.includes('messages exhausted') ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('the usage limit has been reached')
  );
}
