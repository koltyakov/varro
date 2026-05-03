import { createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type {
  RalphConfig,
  RalphIteration,
  RalphRun,
  RalphSelectedModel,
  RalphStatus,
  RalphStopReason,
} from '../../../shared/ralph';
import { readStored, writeStored } from '../state-storage';

const STORAGE_KEY = 'varro.ralph.runs';

type RalphRunsRecord = Record<string, RalphRun>;

const [runs, setRuns] = createStore<RalphRunsRecord>(loadInitial());
const [showRalphForm, setShowRalphForm] = createSignal(false);

function loadInitial(): RalphRunsRecord {
  const stored = readStored<RalphRunsRecord>(STORAGE_KEY);
  return stored ? { ...stored } : {};
}

function persist(record: RalphRunsRecord) {
  writeStored(STORAGE_KEY, record);
}

export const ralphStore = {
  runs,
  showRalphForm,
  setShowRalphForm,

  isRalphSession(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return !!runs[sessionId];
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

  startRun(config: RalphConfig) {
    const now = Date.now();
    const run: RalphRun = {
      config,
      status: 'running',
      currentIteration: 0,
      iterations: [],
      updatedAt: now,
    };
    setRuns(config.managerSessionId, run);
    persist({ ...runs, [config.managerSessionId]: run });
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
    persist({ ...runs });
  },

  addIterations(sessionId: string, count: number) {
    if (!runs[sessionId] || !Number.isFinite(count) || count < 1) return;
    setRuns(
      sessionId,
      produce((draft) => {
        draft.config.iterations += Math.floor(count);
        draft.updatedAt = Date.now();
      })
    );
    persist({ ...runs });
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
    persist({ ...runs });
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
    persist({ ...runs });
  },

  removeRun(sessionId: string) {
    if (!runs[sessionId]) return;
    setRuns(
      produce((draft) => {
        delete draft[sessionId];
      })
    );
    persist({ ...runs });
  },
};

export type RalphStore = typeof ralphStore;
