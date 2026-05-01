import type {
  RalphConfig,
  RalphIteration,
  RalphIterationStatus,
  RalphRun,
  RalphStopReason,
  RalphVerificationVerdict,
} from '../../../shared/ralph';
import { client, serverEvents } from '../../lib/client';
import { getSessionPermissionRulesForMode } from '../../hooks/permission-rules';
import { ralphStore } from '../../lib/stores/ralph-store';
import { postMessage } from '../../lib/bridge';
import { collectSessionTreeIds } from '../../lib/session-tree-index';
import {
  buildIterationPrompt,
  buildRepairSubAgentPrompt,
  buildVerificationPrompt,
} from './ralph-prompts';

type ActiveRunState = {
  managerSessionId: string;
  unsubscribers: Array<() => void>;
  currentChildId: string | null;
  pendingResolve: (() => void) | null;
};

type RalphStopReasonInternal = RalphStopReason;

const MAX_ITERATION_REPAIR_ATTEMPTS = 2;

const activeRuns = new Map<string, ActiveRunState>();

export const ralphRunner = {
  isActive(managerSessionId: string): boolean {
    return activeRuns.has(managerSessionId);
  },

  async start(config: RalphConfig): Promise<void> {
    ralphStore.startRun(config);
    await runLoop(config);
  },

  stop(managerSessionId: string): void {
    const active = activeRuns.get(managerSessionId);
    if (active?.currentChildId) {
      void client.session.abort(active.currentChildId).catch(() => {});
    }
    ralphStore.setStatus(managerSessionId, 'stopped', 'manual_stop');
    cleanupActive(managerSessionId);
  },

  pause(managerSessionId: string): void {
    ralphStore.setStatus(managerSessionId, 'paused');
  },

  async resume(managerSessionId: string): Promise<void> {
    const run = ralphStore.getRun(managerSessionId);
    if (!run) return;
    if (run.status !== 'paused' && run.status !== 'failed') return;
    ralphStore.setStatus(managerSessionId, 'running');
    await runLoop(run.config);
  },

  reattachAll(): void {
    for (const run of ralphStore.getAllRuns()) {
      if (run.status === 'running' && !activeRuns.has(run.config.managerSessionId)) {
        void runLoop(run.config).catch((err) => {
          logError('reattach failed', err);
        });
      }
    }
  },
};

async function runLoop(config: RalphConfig): Promise<void> {
  if (activeRuns.has(config.managerSessionId)) return;
  const state: ActiveRunState = {
    managerSessionId: config.managerSessionId,
    unsubscribers: [],
    currentChildId: null,
    pendingResolve: null,
  };
  activeRuns.set(config.managerSessionId, state);

  try {
    while (true) {
      const run = ralphStore.getRun(config.managerSessionId);
      if (!run || run.status !== 'running') break;

      const stopReason = await getStopReason(run);
      if (stopReason) {
        // If we ran out of iterations while there are still verification
        // gaps or unchecked plan items, mark the run as `failed` (not `done`)
        // so the UI surfaces that the work isn't fully complete.
        const terminalStatus: 'done' | 'failed' =
          stopReason === 'iteration_limit_with_gap' ? 'failed' : 'done';
        ralphStore.setStatus(config.managerSessionId, terminalStatus, stopReason);
        break;
      }

      const nextIndex = nextIterationIndex(run);

      const previousIteration = lastCompletedIteration(run);
      const iteration = createPendingIteration(nextIndex);
      ralphStore.upsertIteration(config.managerSessionId, iteration);

      try {
        const childId = await createChildSession(config, nextIndex);
        state.currentChildId = childId;
        ralphStore.upsertIteration(config.managerSessionId, {
          ...iteration,
          childSessionId: childId,
          status: 'running',
          startedAt: Date.now(),
        });

        const prompt = await buildPromptText(config, nextIndex, previousIteration);
        const finalIteration = await runIterationUntilSettled({
          config,
          state,
          childId,
          iterationIndex: nextIndex,
          startedAt: iteration.startedAt ?? Date.now(),
          initialPrompt: prompt,
        });
        ralphStore.upsertIteration(config.managerSessionId, finalIteration);

        if (finalIteration.status === 'aborted') {
          // Stop was triggered externally; loop will exit on next status check.
        }
      } catch (err) {
        logError(`iteration ${nextIndex} failed`, err);
        ralphStore.upsertIteration(config.managerSessionId, {
          ...iteration,
          status: 'failed',
          endedAt: Date.now(),
          note: err instanceof Error ? err.message : String(err),
        });
        ralphStore.setStatus(config.managerSessionId, 'failed', 'iteration_error');
        break;
      }
    }
  } finally {
    cleanupActive(config.managerSessionId);
  }
}

function cleanupActive(managerSessionId: string) {
  const state = activeRuns.get(managerSessionId);
  if (!state) return;
  for (const off of state.unsubscribers) off();
  state.unsubscribers = [];
  state.currentChildId = null;
  if (state.pendingResolve) {
    const resolve = state.pendingResolve;
    state.pendingResolve = null;
    resolve();
  }
  activeRuns.delete(managerSessionId);
}

function nextIterationIndex(run: RalphRun): number {
  const indexes = run.iterations
    .filter((it) => it.status === 'passed' || it.status === 'failed' || it.status === 'aborted')
    .map((it) => it.index);
  const completed = indexes.length === 0 ? 0 : Math.max(...indexes);
  return completed + 1;
}

async function getStopReason(run: RalphRun): Promise<RalphStopReasonInternal | null> {
  const lastCompleted = lastCompletedIteration(run);
  const hasOutstandingVerificationFailure =
    !!lastCompleted && hasFailedVerdict(lastCompleted.verification);
  const planContent = await readPlanContentSafe(run.config.planDocPath);
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
  // Block "soft" stop reasons (DONE marker or consecutive passes) while the
  // most recent completed iteration still has outstanding verification
  // failures. Plan/spec-driven runs must not exit while there are known
  // verification gaps - a follow-up iteration needs to repair them first.
  if (planContent && planHasDoneMarker(planContent)) {
    if (hasOutstandingVerificationFailure) return null;
    return 'done_marker';
  }
  if (shouldStopOnConsecutivePasses(run)) {
    // Don't bail out on consecutive passes alone if the plan/spec still
    // has outstanding `- [ ]` items. Plan-driven runs must verify completion
    // against the checklist, not just recent verification verdicts.
    if (planContent && planHasOutstandingTasks(planContent)) return null;
    if (hasOutstandingVerificationFailure) return null;
    return 'consecutive_passes';
  }
  return null;
}

function hasFailedVerdict(verification: RalphIteration['verification']): boolean {
  return Object.values(verification).some((v) => v === 'fail');
}

function shouldStopOnConsecutivePasses(run: RalphRun): boolean {
  const recent = run.iterations
    .filter((it) => it.status === 'passed' || it.status === 'failed')
    .slice(-2);
  return recent.length === 2 && recent.every((it) => it.status === 'passed');
}

async function readPlanContentSafe(planDocPath: string): Promise<string | null> {
  try {
    const content = await client.varro.readWorkspaceFile(planDocPath);
    return content ?? null;
  } catch {
    return null;
  }
}

function planHasDoneMarker(content: string): boolean {
  return /^\uFEFF?DONE(?:\r?\n|$)/.test(content);
}

function planHasOutstandingTasks(content: string): boolean {
  // Match unchecked boxes in common plan formats: task-list bullets,
  // numbered items, and markdown table cells. Whitespace means "open".
  return /(^\s*(?:[-*+]|\d+[.)])\s+\[\s\])|(^\s*\|[^\n]*\[\s\])/m.test(content);
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

async function createChildSession(config: RalphConfig, iterationIndex: number): Promise<string> {
  const session = await client.session.create({
    title: `Ralph iter ${iterationIndex} · ${planDocLabel(config.planDocPath)}`,
    permission: getSessionPermissionRulesForMode(config.permissionMode, 'create'),
    parentID: config.managerSessionId,
  });
  return session.id;
}

function planDocLabel(path: string): string {
  return path.split('/').pop() || path;
}

async function sendPrompt(childId: string, prompt: string, config: RalphConfig): Promise<void> {
  const body: Parameters<typeof client.session.sendAsync>[1] = {
    parts: [{ type: 'text', text: prompt }],
  };
  if (config.model) {
    body.model = { providerID: config.model.providerID, modelID: config.model.modelID };
    if (config.model.variant) body.variant = config.model.variant;
  }
  if (config.agent) body.agent = config.agent;
  await client.session.sendAsync(childId, body);
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
  await sendPrompt(childId, initialPrompt, config);
  await waitForIdle(state, childId);

  // 2) Parent dynamically requires verification (item 38). The verification
  //    command set is NOT hardcoded in the child's initial prompt; the
  //    parent injects it as a follow-up message after the work settles.
  await runVerificationOnSession(config, state, childId);

  let iteration = await summarizeIteration({
    config,
    childId,
    iterationIndex,
    startedAt,
  });

  if (iteration.status !== 'failed') return iteration;

  // 3) Verification failed - spawn a separate repair sub-agent (item 37).
  //    The repair child session is filed under the same manager so its
  //    history doesn't pollute the iteration session.
  const repairSessionIds: string[] = [];
  for (let attempt = 1; attempt <= MAX_ITERATION_REPAIR_ATTEMPTS; attempt += 1) {
    let repairChildId: string;
    try {
      repairChildId = await createRepairChildSession(config, iterationIndex, attempt);
    } catch (err) {
      logError(`iteration ${iterationIndex} repair-spawn failed`, err);
      break;
    }
    repairSessionIds.push(repairChildId);
    state.currentChildId = repairChildId;

    const repairPrompt = buildRepairSubAgentPrompt({
      config,
      failedIteration: iteration,
      attempt,
      maxAttempts: MAX_ITERATION_REPAIR_ATTEMPTS,
    });
    await sendPrompt(repairChildId, repairPrompt, config);
    await waitForIdle(state, repairChildId);

    await runVerificationOnSession(config, state, repairChildId);

    const repairSummary = await summarizeIteration({
      config,
      childId: repairChildId,
      iterationIndex,
      startedAt,
    });

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
  await sendPrompt(sessionId, verificationPrompt, config);
  await waitForIdle(state, sessionId);
}

async function createRepairChildSession(
  config: RalphConfig,
  iterationIndex: number,
  attempt: number
): Promise<string> {
  const session = await client.session.create({
    title: `Ralph iter ${iterationIndex} repair ${attempt} · ${planDocLabel(config.planDocPath)}`,
    permission: getSessionPermissionRulesForMode(config.permissionMode, 'create'),
    parentID: config.managerSessionId,
  });
  return session.id;
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
 * Resolve every session that participated in this iteration so token usage
 * from any sub-agents (and their nested sub-sub-agents) spawned by the Task
 * tool gets folded into the iteration's totals. Falls back to just the
 * iteration's own child session when the session list cannot be fetched.
 */
async function collectIterationSessionIds(childId: string): Promise<string[]> {
  try {
    const sessions = await client.session.list();
    const treeIds = collectSessionTreeIds(childId, sessions);
    return treeIds.length > 0 ? treeIds : [childId];
  } catch {
    return [childId];
  }
}

function waitForIdle(state: ActiveRunState, childId: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = () => {
      for (const off of state.unsubscribers) off();
      state.unsubscribers = [];
      state.pendingResolve = null;
      resolve();
    };
    state.pendingResolve = finish;

    state.unsubscribers.push(
      serverEvents.on('session.idle', (data) => {
        const sid = (data.properties as { sessionID?: string } | undefined)?.sessionID;
        if (sid === childId) finish();
      })
    );
    state.unsubscribers.push(
      serverEvents.on('session.status', (data) => {
        const props = data.properties as
          | { sessionID?: string; status?: { type?: string } }
          | undefined;
        if (props?.sessionID === childId && props.status?.type === 'idle') finish();
      })
    );
  });
}

async function summarizeIteration(args: {
  config: RalphConfig;
  childId: string;
  iterationIndex: number;
  startedAt: number;
}): Promise<RalphIteration> {
  const { childId, iterationIndex, startedAt } = args;
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
    const sessionIds = await collectIterationSessionIds(childId);
    const messagesPerSession = await Promise.all(
      sessionIds.map((sid) => client.session.messages(sid).catch(() => []))
    );
    let iterationMessages: Awaited<ReturnType<typeof client.session.messages>> = [];
    for (let i = 0; i < sessionIds.length; i += 1) {
      const sid = sessionIds[i];
      const sessionMessages = messagesPerSession[i] ?? [];
      if (sid === childId) iterationMessages = sessionMessages;
      for (const m of sessionMessages) {
        for (const p of m.parts) {
          if (p.type === 'patch') {
            for (const f of p.files) filesChangedSet.add(f);
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
    // Verdicts come from the iteration's own final assistant report; sub-agent
    // chatter must not override them.
    for (let i = iterationMessages.length - 1; i >= 0; i -= 1) {
      const m = iterationMessages[i];
      if (!m || m.info.role !== 'assistant') continue;
      lastAssistantText = m.parts
        .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
      break;
    }
  } catch {
    /* best-effort summary */
  }

  const verification = parseVerificationVerdicts(lastAssistantText);
  const status = inferIterationStatus(verification);

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

/**
 * Extract verdict lines from the model's report. Names are project-driven -
 * we accept any short token followed by `: PASS|FAIL|SKIPPED` (with optional
 * dash separator). Example matches: `lint: PASS`, `cargo build - FAIL`,
 * `mypy: SKIPPED`, `tc:pass`. The first verdict per name wins so a model
 * that re-reports a check after fixing it still shows the latest line as
 * authoritative - we walk top-to-bottom and keep the LAST occurrence.
 */
function parseVerificationVerdicts(text: string): RalphIteration['verification'] {
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
  if (reported.length === 0) return 'passed';
  if (reported.some((v) => v === 'fail')) return 'failed';
  return 'passed';
}

function buildPromptText(
  config: RalphConfig,
  iterationIndex: number,
  previousIteration: RalphIteration | null
): Promise<string> {
  return buildIterationPrompt({
    config,
    iterationIndex,
    previousIteration,
    readFile: (path) => client.varro.readWorkspaceFile(path),
  });
}

function logError(context: string, err: unknown): void {
  postMessage({
    type: 'log',
    payload: {
      msg: `ralph-runner:${context}`,
      error: err instanceof Error ? err.message : String(err),
      level: 'error',
    },
  });
}
