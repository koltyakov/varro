import { For, Show } from 'solid-js';
import type { RalphStopReason } from '../../../shared/ralph';
import { formatVariantLabel } from '../../lib/format';
import { ralphStore } from '../../lib/stores/ralph-store';
import { ralphRunner } from './ralph-runner';
import { RalphIterationCard } from './RalphIterationCard';

export function RalphDashboard(props: { sessionId: string }) {
  const run = () => ralphStore.getRun(props.sessionId);

  const isRunning = () => run()?.status === 'running';
  const isResumable = () => {
    const s = run()?.status;
    return s === 'paused' || s === 'failed' || s === 'incomplete';
  };
  const isTerminal = () => {
    const s = run()?.status;
    return s === 'done' || s === 'stopped' || s === 'failed' || s === 'incomplete';
  };

  return (
    <div class="ralph-dashboard">
      <Show when={run()} fallback={<div class="ralph-dashboard-empty">Ralph run not found.</div>}>
        {(activeRun) => (
          <>
            <header class="ralph-dashboard-header">
              <div class="ralph-dashboard-header-left">
                <span class="ralph-dashboard-tag">Ralph</span>
                <span class="ralph-dashboard-plan" title={activeRun().config.planDocPath}>
                  {planLabel(activeRun().config.planDocPath)}
                </span>
                <span class={`ralph-dashboard-status ralph-dashboard-status-${activeRun().status}`}>
                  {activeRun().status}
                </span>
                <Show when={activeRun().stopReason}>
                  {(reason) => (
                    <span class="ralph-dashboard-stop-reason" title={stopReasonTooltip(reason())}>
                      {stopReasonLabel(reason())}
                    </span>
                  )}
                </Show>
              </div>
              <div class="ralph-dashboard-header-right">
                <Show when={isRunning()}>
                  <button
                    type="button"
                    class="ralph-dashboard-btn ralph-dashboard-btn-icon"
                    title="Pause"
                    aria-label="Pause"
                    onClick={() => ralphRunner.pause(props.sessionId)}
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <rect x="4" y="3" width="3" height="10" rx="0.75" />
                      <rect x="9" y="3" width="3" height="10" rx="0.75" />
                    </svg>
                  </button>
                </Show>
                <Show when={isResumable()}>
                  <button
                    type="button"
                    class="ralph-dashboard-btn"
                    onClick={() => void ralphRunner.resume(props.sessionId)}
                  >
                    Resume
                  </button>
                </Show>
                <Show when={!isTerminal()}>
                  <button
                    type="button"
                    class="ralph-dashboard-btn ralph-dashboard-btn-icon ralph-dashboard-btn-danger"
                    title="Stop"
                    aria-label="Stop"
                    onClick={() => ralphRunner.stop(props.sessionId)}
                  >
                    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                      <rect x="3" y="3" width="10" height="10" rx="1.5" />
                    </svg>
                  </button>
                </Show>
              </div>
            </header>

            <section class="ralph-dashboard-meta">
              <span>
                Iterations: {activeRun().iterations.length} / {activeRun().config.iterations}
              </span>
              <Show when={activeRun().config.model}>
                {(m) => (
                  <span>
                    Model: {m().providerID}/{m().modelID}
                    {formatReasoningLevel(m().variant)}
                  </span>
                )}
              </Show>
              <Show when={activeRun().config.agent}>
                <span>Agent: {activeRun().config.agent}</span>
              </Show>
            </section>

            <section class="ralph-dashboard-list">
              <Show
                when={activeRun().iterations.length > 0}
                fallback={<div class="ralph-dashboard-empty">No iterations yet.</div>}
              >
                <For each={activeRun().iterations}>
                  {(iteration) => <RalphIterationCard iteration={iteration} />}
                </For>
              </Show>
            </section>
          </>
        )}
      </Show>
    </div>
  );
}

function planLabel(path: string): string {
  return path.split('/').pop() || path;
}

function formatReasoningLevel(variant: string | undefined): string {
  return variant ? ` (${formatVariantLabel(variant)})` : '';
}

export function stopReasonLabel(reason: RalphStopReason): string {
  switch (reason) {
    case 'iteration_limit':
      return 'iteration limit';
    case 'iteration_limit_with_gap':
      return 'iteration limit · verification gap';
    case 'consecutive_passes':
      return 'consecutive passes';
    case 'done_marker':
      return 'plan marked DONE';
    case 'manual_stop':
      return 'stopped manually';
    case 'iteration_error':
      return 'iteration error';
  }
}

export function stopReasonTooltip(reason: RalphStopReason): string {
  switch (reason) {
    case 'iteration_limit':
      return 'Reached the configured iteration limit with no outstanding verification or plan items.';
    case 'iteration_limit_with_gap':
      return 'Reached the configured iteration limit while the plan still has unchecked items or the last iteration had failed verifications.';
    case 'consecutive_passes':
      return 'Stopped after consecutive passing iterations and a clean plan checklist.';
    case 'done_marker':
      return 'The plan document started with a DONE marker.';
    case 'manual_stop':
      return 'The run was stopped by the user.';
    case 'iteration_error':
      return 'An iteration failed to start or run; the loop halted.';
  }
}
