import { createSignal } from 'solid-js';
import { createStore, produce, reconcile } from 'solid-js/store';
import type {
  RalphConfig,
  RalphIteration,
  RalphRun,
  RalphSelectedModel,
  RalphStatus,
  RalphStopReason,
} from '../../../shared/ralph';
import { MAX_RALPH_ITERATIONS } from '../../../shared/ralph';
import type { RalphStatePayload } from '../../../shared/protocol';
import { postMessage } from '../bridge';
import { readStored, writeStored } from '../state-storage';

const LEGACY_STORAGE_KEY = 'varro.ralph.runs';

type RalphRunsRecord = Record<string, RalphRun>;

/**
 * Render mirror of Ralph state owned by the extension host. Mutation helpers
 * apply optimistic local updates so the dashboard reacts immediately; the
 * host's `ralph/state` broadcasts (applied via {@link applyHostState}) are
 * authoritative and reconcile the mirror.
 */
const [runs, setRuns] = createStore<RalphRunsRecord>({});
const [showRalphForm, setShowRalphForm] = createSignal(false);
const [activeRunnerIds, setActiveRunnerIds] = createSignal<string[]>([]);

export const ralphStore = {
  runs,
  showRalphForm,
  setShowRalphForm,

  isRalphSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return !!runs[sessionId];
  },

  isRunnerActive(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return activeRunnerIds().includes(sessionId);
  },

  /**
   * Returns the manager session id for the Ralph run that owns the given
   * iteration child session, or null if no Ralph run currently tracks it.
   * Used so navigating "back" from a Ralph iteration session returns to the
   * Ralph dashboard instead of the global sessions list.
   */
  findManagerSessionIdForChild(childSessionId: string | null | undefined): string | null {
    if (!childSessionId) return null;
    for (const run of Object.values(runs)) {
      for (const iteration of run.iterations) {
        if (iteration.childSessionId === childSessionId) {
          return run.config.managerSessionId;
        }
      }
    }
    return null;
  },

  getRun(sessionId: string | null | undefined): RalphRun | null {
    if (!sessionId) return null;
    return runs[sessionId] ?? null;
  },

  getAllRuns(): RalphRun[] {
    return Object.values(runs);
  },

  /** Replace the mirror with the host's authoritative snapshot. */
  applyHostState(nextRuns: RalphStatePayload['runs'], activeIds: string[]) {
    const acknowledgedLegacyRunIds: string[] = [];
    const cleanRuns: RalphRunsRecord = {};
    for (const [managerSessionId, stateRun] of Object.entries(nextRuns)) {
      const { legacyMigrationAcknowledged, ...run } = stateRun;
      cleanRuns[managerSessionId] = run;
      if (legacyMigrationAcknowledged) acknowledgedLegacyRunIds.push(managerSessionId);
    }

    setRuns(reconcile(cleanRuns, { merge: true }));
    setActiveRunnerIds(activeIds);
    acknowledgeLegacyRuns(acknowledgedLegacyRunIds);
  },

  /**
   * One-time migration: older builds persisted runs in webview localStorage.
   * Hand them to the host via `ralph/sync`. They remain in localStorage until
   * a host snapshot explicitly acknowledges durable adoption.
   */
  consumeLegacyRuns(): RalphRunsRecord | undefined {
    const stored = readStored<RalphRunsRecord>(LEGACY_STORAGE_KEY);
    if (!stored || Object.keys(stored).length === 0) return undefined;
    return stored;
  },

  startRun(config: RalphConfig) {
    if (runs[config.managerSessionId]) return;
    const now = Date.now();
    const run: RalphRun = {
      config,
      status: 'running',
      currentIteration: 0,
      iterations: [],
      updatedAt: now,
    };
    setRuns(config.managerSessionId, run);
  },

  setStatus(sessionId: string, status: RalphStatus, stopReason?: RalphStopReason) {
    if (!runs[sessionId]) return;
    setRuns(sessionId, 'status', status);
    setRuns(sessionId, 'updatedAt', Date.now());
    if (stopReason !== undefined) {
      setRuns(sessionId, 'stopReason', stopReason);
    } else if (status === 'running' || status === 'paused') {
      // Clear any prior terminal stop reason when leaving a terminal state.
      setRuns(sessionId, 'stopReason', undefined);
    }
  },

  addIterations(sessionId: string, count: number) {
    if (!runs[sessionId] || !Number.isFinite(count) || count < 1) return;
    setRuns(
      sessionId,
      produce((draft) => {
        draft.config.iterations = Math.min(
          MAX_RALPH_ITERATIONS,
          draft.config.iterations + Math.floor(count)
        );
        draft.updatedAt = Date.now();
      })
    );
  },

  updateRunModel(sessionId: string, model: RalphSelectedModel | null) {
    if (!runs[sessionId]) return;
    setRuns(
      sessionId,
      produce((draft) => {
        draft.config.model = model;
        draft.updatedAt = Date.now();
      })
    );
    postMessage({ type: 'ralph/update-model', payload: { managerSessionId: sessionId, model } });
  },

  upsertIteration(sessionId: string, iteration: RalphIteration) {
    if (!runs[sessionId]) return;
    setRuns(
      sessionId,
      produce((draft) => {
        const existing = draft.iterations.findIndex((it) => it.index === iteration.index);
        if (existing >= 0) draft.iterations[existing] = iteration;
        else draft.iterations.push(iteration);
        draft.iterations.sort((a, b) => a.index - b.index);
        draft.currentIteration = Math.max(draft.currentIteration, iteration.index);
        draft.updatedAt = Date.now();
      })
    );
  },

  removeRun(sessionId: string) {
    if (!runs[sessionId]) return;
    setRuns(
      produce((draft) => {
        delete draft[sessionId];
      })
    );
  },
};

export type RalphStore = typeof ralphStore;

function acknowledgeLegacyRuns(managerSessionIds: string[]): void {
  if (managerSessionIds.length === 0) return;
  const stored = readStored<RalphRunsRecord>(LEGACY_STORAGE_KEY);
  if (!stored) return;

  const remaining = { ...stored };
  for (const managerSessionId of managerSessionIds) delete remaining[managerSessionId];
  writeStored(LEGACY_STORAGE_KEY, Object.keys(remaining).length > 0 ? remaining : null);
}
