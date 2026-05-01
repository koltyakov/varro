import type { PermissionMode } from './protocol';

export type RalphStatus = 'running' | 'paused' | 'stopped' | 'done' | 'failed';

/**
 * Why a Ralph run stopped. Used to surface a clearer explanation in the UI
 * (e.g. distinguishing a clean completion from running out of iterations
 * with verification gaps still outstanding).
 */
export type RalphStopReason =
  | 'iteration_limit'
  | 'iteration_limit_with_gap'
  | 'consecutive_passes'
  | 'done_marker'
  | 'manual_stop'
  | 'iteration_error';

export type RalphIterationStatus = 'pending' | 'running' | 'passed' | 'failed' | 'aborted';

export type RalphVerificationVerdict = 'pass' | 'fail' | 'skipped';

export type RalphSelectedModel = {
  providerID: string;
  modelID: string;
  variant?: string;
};

export type RalphConfig = {
  managerSessionId: string;
  planDocPath: string;
  iterations: number;
  promptTemplate: string;
  permissionMode: PermissionMode;
  model: RalphSelectedModel | null;
  agent: string | null;
  createdAt: number;
};

export type RalphIterationTokens = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
};

export type RalphIteration = {
  index: number;
  childSessionId: string | null;
  status: RalphIterationStatus;
  startedAt: number | null;
  endedAt: number | null;
  filesChanged: string[];
  /**
   * Verification verdicts reported by the iteration. Names are project-driven
   * (e.g. `lint`, `test`, `build`, `typecheck`, `fmt`, `clippy`, `vet`) - the
   * model decides which checks the workspace supports and reports each by
   * name. Order is preserved as encountered in the model's report.
   */
  verification: Record<string, RalphVerificationVerdict>;
  tokens?: RalphIterationTokens;
  cost?: number;
  note?: string;
  /**
   * Child session ids spawned to repair this iteration after verification
   * failed. Repair runs as a separate sub-agent so its history doesn't
   * pollute the original iteration session.
   */
  repairSessionIds?: string[];
};

export type RalphRun = {
  config: RalphConfig;
  status: RalphStatus;
  currentIteration: number;
  iterations: RalphIteration[];
  updatedAt: number;
  /** Set when the loop transitions to a terminal status. */
  stopReason?: RalphStopReason;
};
