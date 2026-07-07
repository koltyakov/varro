import type { RalphConfig, RalphIteration, RalphRun, RalphStopReason } from '../shared/ralph';
import type { RalphStatePayload, WebviewMessage } from '../shared/protocol';
import type { Persistence } from '../shared/persistence';
import {
  createRalphRunner,
  type RalphMessageEntry,
  type RalphRunner,
  type RalphRunnerStore,
  type RalphSessionSummary,
} from '../shared/ralph-runner-core';
import { normalizeModelVariant } from '../webview/lib/model-variants';
import { asRecord } from '../shared/type-utils';
import type { ContextProvider } from './context-provider';
import type { OpenCodeServer } from './server';
import { logger } from './logger';

const RALPH_RUNS_KEY = 'varro.ralph.runs';

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

  constructor(
    private readonly persistence: Persistence,
    private readonly onChange: () => void
  ) {
    this.runs = this.persistence.get<Record<string, RalphRun>>(RALPH_RUNS_KEY) || {};
  }

  snapshot(): Record<string, RalphRun> {
    return { ...this.runs };
  }

  getRun(managerSessionId: string): RalphRun | null {
    return this.runs[managerSessionId] ?? null;
  }

  getAllRuns(): RalphRun[] {
    return Object.values(this.runs);
  }

  startRun(config: RalphConfig): void {
    this.runs[config.managerSessionId] = {
      config,
      status: 'running',
      currentIteration: 0,
      iterations: [],
      updatedAt: Date.now(),
    };
    this.commit();
  }

  adoptRun(run: RalphRun): void {
    if (this.runs[run.config.managerSessionId]) return;
    this.runs[run.config.managerSessionId] = run;
    this.commit();
  }

  setStatus(managerSessionId: string, status: RalphRun['status'], stopReason?: RalphStopReason) {
    const run = this.runs[managerSessionId];
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
    const run = this.runs[managerSessionId];
    if (!run || !Number.isFinite(count) || count < 1) return;
    this.runs[managerSessionId] = {
      ...run,
      config: { ...run.config, iterations: run.config.iterations + Math.floor(count) },
      updatedAt: Date.now(),
    };
    this.commit();
  }

  updateRunModel(managerSessionId: string, model: RalphConfig['model']): void {
    const run = this.runs[managerSessionId];
    if (!run) return;
    this.runs[managerSessionId] = {
      ...run,
      config: { ...run.config, model },
      updatedAt: Date.now(),
    };
    this.commit();
  }

  upsertIteration(managerSessionId: string, iteration: RalphIteration): void {
    const run = this.runs[managerSessionId];
    if (!run) return;
    const iterations = [...run.iterations];
    const existing = iterations.findIndex((it) => it.index === iteration.index);
    if (existing >= 0) iterations[existing] = iteration;
    else iterations.push(iteration);
    iterations.sort((a, b) => a.index - b.index);
    this.runs[managerSessionId] = {
      ...run,
      iterations,
      currentIteration: Math.max(run.currentIteration, iteration.index),
      updatedAt: Date.now(),
    };
    this.commit();
  }

  private commit() {
    void Promise.resolve(this.persistence.set(RALPH_RUNS_KEY, this.runs)).catch((err) => {
      logger.warn(
        `Failed to persist Ralph runs: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    this.onChange();
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
      createSession: async ({ title, permission, parentID }) => {
        const session = await this.request('POST', '/session', {
          title,
          parentID,
          ...(permission.length > 0 ? { permission } : {}),
        });
        const sessionID = getString(asRecord(session)?.id);
        if (!sessionID) throw new Error('Ralph child session was not created');
        return sessionID;
      },
      sendPrompt: async (sessionId, body) => {
        await this.request('POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, body);
      },
      abortSession: async (sessionId) => {
        await this.request('POST', `/session/${encodeURIComponent(sessionId)}/abort`);
      },
      listSessions: async () => {
        const sessions = await this.request('GET', '/session');
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
      listMessages: async (sessionId) => {
        const messages = await this.request(
          'GET',
          `/session/${encodeURIComponent(sessionId)}/message`
        );
        return Array.isArray(messages) ? (messages as RalphMessageEntry[]) : [];
      },
      onSessionIdle: (listener) => {
        const handler = (event: { type?: string; properties?: unknown }) => {
          const props = asRecord(event?.properties);
          const sessionID = getString(props?.sessionID);
          if (!sessionID) return;
          if (event.type === 'session.idle') {
            listener(sessionID);
            return;
          }
          if (
            event.type === 'session.status' &&
            getString(asRecord(props?.status)?.type) === 'idle'
          ) {
            listener(sessionID);
          }
        };
        this.deps.server.on('event', handler);
        return () => {
          this.deps.server.off('event', handler);
        };
      },
      readWorkspaceFile: (path) => this.deps.contextProvider.readFile(path),
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
        for (const run of Object.values(msg.payload.legacyRuns || {})) {
          if (run?.config?.managerSessionId) this.store.adoptRun(run);
        }
        void this.withServer(async () => this.runner.reattachAll(), 'reattach');
        this.broadcast();
        break;
      }
    }
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

  private request(method: string, path: string, body?: unknown) {
    return this.deps.server.request(method, path, body);
  }

  private broadcast() {
    this.deps.broadcastState(this.getStatePayload());
  }
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
