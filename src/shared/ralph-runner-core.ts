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

export type RalphMessageEntry = {
  info: {
    role?: string;
    cost?: number;
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
  createSession(args: {
    title: string;
    permission: ReturnType<typeof getSessionPermissionRulesForMode>;
    parentID: string;
  }): Promise<string>;
  sendPrompt(sessionId: string, body: RalphSendBody): Promise<void>;
  abortSession(sessionId: string): Promise<void>;
  listSessions(): Promise<RalphSessionSummary[]>;
  listMessages(sessionId: string): Promise<RalphMessageEntry[]>;
  /** Subscribe to session-idle signals; returns an unsubscribe function. */
  onSessionIdle(listener: (sessionID: string) => void): () => void;
  /** Maximum idle wait per prompt. Defaults to 30 minutes. */
  idleTimeoutMs?: number;
  readWorkspaceFile(path: string): Promise<string | null>;
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
  cancelIdleWait: (() => void) | null;
  shutdownRequested: boolean;
};

const MAX_ITERATION_REPAIR_ATTEMPTS = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

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
      ports.store.startRun(config);
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

  async function runLoop(config: RalphConfig): Promise<void> {
    if (activeRuns.has(config.managerSessionId)) return;
    const state: ActiveRunState = {
      managerSessionId: config.managerSessionId,
      abortController: new AbortController(),
      currentChildId: null,
      childAbortRequests: new Map(),
      cancelIdleWait: null,
      shutdownRequested: false,
    };
    activeRuns.set(config.managerSessionId, state);

    try {
      while (true) {
        const run = ports.store.getRun(config.managerSessionId);
        if (!run || run.status !== 'running') break;

        const stopReason = await getStopReason(run, state);
        throwIfRunCancelled(state);
        if (stopReason) {
          // If we ran out of iterations while there are still verification
          // gaps or unchecked plan items, mark the run as `incomplete` (not
          // `done` and not `failed`) so the UI can distinguish "ran out of
          // budget before convergence" from a hard error or a clean finish.
          const terminalStatus: 'done' | 'incomplete' =
            stopReason === 'iteration_limit_with_gap' ? 'incomplete' : 'done';
          ports.store.setStatus(config.managerSessionId, terminalStatus, stopReason);
          break;
        }

        const nextIndex = nextIterationIndex(run);

        const previousIteration = lastCompletedIteration(run);
        let iteration = createPendingIteration(nextIndex);
        ports.store.upsertIteration(config.managerSessionId, iteration);

        try {
          const childId = await createChildSession(config, nextIndex);
          state.currentChildId = childId;
          if (state.abortController.signal.aborted) {
            await abortChildSession(state, childId);
            throwIfRunCancelled(state);
          }
          iteration = {
            ...iteration,
            childSessionId: childId,
            status: 'running',
            startedAt: Date.now(),
          };
          ports.store.upsertIteration(config.managerSessionId, iteration);

          const prompt = await buildIterationPrompt({
            config,
            iterationIndex: nextIndex,
            previousIteration,
            readFile: async (path) => {
              const content = await ports.readWorkspaceFile(path);
              throwIfRunCancelled(state);
              return content;
            },
          });
          throwIfRunCancelled(state);
          const finalIteration = await runIterationUntilSettled({
            config,
            state,
            childId,
            iterationIndex: nextIndex,
            startedAt: iteration.startedAt ?? Date.now(),
            initialPrompt: prompt,
          });
          throwIfRunCancelled(state);
          ports.store.upsertIteration(config.managerSessionId, finalIteration);

          if (finalIteration.status === 'aborted') {
            // Stop was triggered externally; loop will exit on next status check.
          }
        } catch (err) {
          if (isRunCancelled(state, err)) {
            if (state.currentChildId) {
              await abortChildSession(state, state.currentChildId);
            }
            if (!state.shutdownRequested) {
              ports.store.upsertIteration(config.managerSessionId, {
                ...iteration,
                status: 'aborted',
                endedAt: Date.now(),
              });
            }
            break;
          }
          ports.logError(`iteration ${nextIndex} failed`, err);
          ports.store.upsertIteration(config.managerSessionId, {
            ...iteration,
            status: 'failed',
            endedAt: Date.now(),
            note: err instanceof Error ? err.message : String(err),
          });
          ports.store.setStatus(config.managerSessionId, 'failed', 'iteration_error');
          break;
        }
      }
    } catch (err) {
      if (!isRunCancelled(state, err)) throw err;
      if (state.currentChildId) {
        await abortChildSession(state, state.currentChildId);
      }
    } finally {
      cleanupActive(config.managerSessionId);
    }
  }

  function cleanupActive(managerSessionId: string) {
    const state = activeRuns.get(managerSessionId);
    if (!state) return;
    state.cancelIdleWait?.();
    state.cancelIdleWait = null;
    state.currentChildId = null;
    activeRuns.delete(managerSessionId);
  }

  function abortChildSession(state: ActiveRunState, childId: string): Promise<void> {
    const existing = state.childAbortRequests.get(childId);
    if (existing) return existing;

    let request: Promise<void>;
    try {
      request = ports.abortSession(childId).catch(() => {});
    } catch {
      request = Promise.resolve();
    }
    state.childAbortRequests.set(childId, request);
    return request;
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
      content = await ports.readWorkspaceFile(planDocPath);
    } catch {
      // Plan reads are best-effort for stop-condition checks.
    }
    throwIfRunCancelled(state);
    return content ?? null;
  }

  async function createChildSession(config: RalphConfig, iterationIndex: number): Promise<string> {
    return ports.createSession({
      title: `Ralph iter ${iterationIndex} · ${planDocLabel(config.planDocPath)}`,
      permission: getSessionPermissionRulesForMode(config.permissionMode, 'create'),
      parentID: config.managerSessionId,
    });
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
    await ports.sendPrompt(childId, body);
    throwIfRunCancelled(state);
  }

  async function sendPromptAndWaitForIdle(
    state: ActiveRunState,
    childId: string,
    prompt: string,
    config: RalphConfig
  ): Promise<void> {
    // Arm idle listeners before sending so a fast child can't emit `idle`
    // between the send resolving and the wait subscription being attached.
    const idlePromise = waitForIdle(state, childId);
    try {
      await sendPrompt(state, childId, prompt, config);
      throwIfRunCancelled(state);
      const idleResult = await idlePromise;
      throwIfRunCancelled(state);
      if (idleResult.type === 'timeout') {
        await abortChildSession(state, childId);
        throwIfRunCancelled(state);
        throw new Error(
          `Ralph session ${childId} did not become idle within ${idleTimeoutMs}ms after a prompt; check whether the child is still running or idle event delivery was interrupted`
        );
      }
      if (idleResult.type === 'error') {
        throw idleResult.error;
      }
    } catch (err) {
      state.cancelIdleWait?.();
      throw err;
    }
  }

  async function runIterationUntilSettled(args: {
    config: RalphConfig;
    state: ActiveRunState;
    childId: string;
    iterationIndex: number;
    startedAt: number;
    initialPrompt: string;
  }): Promise<RalphIteration> {
    const { config, state, childId, iterationIndex, startedAt, initialPrompt } = args;

    // 1) Run the iteration's primary work in the iteration child session.
    await sendPromptAndWaitForIdle(state, childId, initialPrompt, config);
    throwIfRunCancelled(state);

    // 2) Parent dynamically requires verification. The verification command
    //    set is NOT hardcoded in the child's initial prompt; the parent
    //    injects it as a follow-up message after the work settles.
    await runVerificationOnSession(config, state, childId);
    throwIfRunCancelled(state);

    let iteration = await summarizeIteration({
      state,
      childId,
      iterationIndex,
      startedAt,
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
        repairChildId = await createRepairChildSession(config, iterationIndex, attempt);
        state.currentChildId = repairChildId;
        if (state.abortController.signal.aborted) {
          await abortChildSession(state, repairChildId);
          throwIfRunCancelled(state);
        }
      } catch (err) {
        throwIfRunCancelled(state);
        ports.logError(`iteration ${iterationIndex} repair-spawn failed`, err);
        break;
      }
      repairSessionIds.push(repairChildId);

      const repairPrompt = buildRepairSubAgentPrompt({
        config,
        failedIteration: iteration,
        attempt,
        maxAttempts: MAX_ITERATION_REPAIR_ATTEMPTS,
      });
      await sendPromptAndWaitForIdle(state, repairChildId, repairPrompt, config);
      throwIfRunCancelled(state);

      await runVerificationOnSession(config, state, repairChildId);
      throwIfRunCancelled(state);

      const repairSummary = await summarizeIteration({
        state,
        childId: repairChildId,
        iterationIndex,
        startedAt,
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
    config: RalphConfig,
    iterationIndex: number,
    attempt: number
  ): Promise<string> {
    return ports.createSession({
      title: `Ralph iter ${iterationIndex} repair ${attempt} · ${planDocLabel(config.planDocPath)}`,
      permission: getSessionPermissionRulesForMode(config.permissionMode, 'create'),
      parentID: config.managerSessionId,
    });
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
      sessions = await ports.listSessions();
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

  function waitForIdle(state: ActiveRunState, childId: string): Promise<IdleWaitResult> {
    return new Promise<IdleWaitResult>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const signal = state.abortController.signal;
      const finish = (result: IdleWaitResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
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
        unsubscribe = ports.onSessionIdle((sessionID) => {
          if (sessionID === childId) finish({ type: 'idle' });
        });
        if (settled) {
          unsubscribe();
          unsubscribe = null;
        }
      } catch (error) {
        finish({ type: 'error', error });
      }

      if (signal.aborted) cancel();
    });
  }

  async function summarizeIteration(args: {
    state: ActiveRunState;
    childId: string;
    iterationIndex: number;
    startedAt: number;
  }): Promise<RalphIteration> {
    const { state, childId, iterationIndex, startedAt } = args;
    let lastAssistantText = '';
    const filesChangedSet = new Set<string>();
    const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    try {
      // Walk the iteration's session tree so tokens from any sub-agents
      // spawned by the Task tool (and their nested sub-sub-agents) are
      // accumulated into the iteration's totals - matching how the chat
      // popup shows in/out for a session, but rolled up across the entire
      // iteration's work.
      const sessionIds = await collectIterationSessionIds(state, childId);
      throwIfRunCancelled(state);
      const messagesPerSession = await Promise.all(
        sessionIds.map((sid) => ports.listMessages(sid).catch(() => [] as RalphMessageEntry[]))
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
      // Verdicts come from the iteration's own final assistant report;
      // sub-agent chatter must not override them.
      for (let i = iterationMessages.length - 1; i >= 0; i -= 1) {
        const m = iterationMessages[i];
        if (!m || m.info.role !== 'assistant') continue;
        lastAssistantText = m.parts
          .filter((p) => p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n');
        break;
      }
    } catch {
      throwIfRunCancelled(state);
      /* best-effort summary */
    }
    throwIfRunCancelled(state);

    const verification = parseVerificationVerdicts(lastAssistantText);
    const status = inferIterationStatus(verification, lastAssistantText);

    return {
      index: iterationIndex,
      childSessionId: childId,
      status,
      startedAt,
      endedAt: Date.now(),
      filesChanged: Array.from(filesChangedSet),
      verification,
      tokens: tokens.total > 0 ? tokens : undefined,
      cost: cost > 0 ? cost : undefined,
      note: lastAssistantText.slice(0, 280) || undefined,
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

function nextIterationIndex(run: RalphRun): number {
  const indexes = run.iterations
    .filter((it) => it.status === 'passed' || it.status === 'failed' || it.status === 'aborted')
    .map((it) => it.index);
  const completed = indexes.length === 0 ? 0 : Math.max(...indexes);
  return completed + 1;
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

function inferIterationStatus(
  verdicts: RalphIteration['verification'],
  lastAssistantText: string
): RalphIterationStatus {
  const reported = Object.values(verdicts);
  if (reported.length === 0) {
    return isInterruptionLikeAssistantText(lastAssistantText) ? 'failed' : 'passed';
  }
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
