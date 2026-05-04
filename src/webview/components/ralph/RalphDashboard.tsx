import { For, Show, createEffect, onCleanup } from 'solid-js';
import {
  RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT,
  type RalphStatus,
  type RalphStopReason,
} from '../../../shared/ralph';
import {
  formatProviderLimitTitle,
  formatVariantLabel,
  getProviderLimitCompactBadges,
} from '../../lib/format';
import { getProviderLimit } from '../../lib/state';
import { ralphStore } from '../../lib/stores/ralph-store';
import { ralphRunner } from './ralph-runner';
import { RalphIterationCard } from './RalphIterationCard';
import { getRalphIterationLiveIssue } from './ralph-live-issue';

export function RalphDashboard(props: { sessionId: string }) {
  const run = () => ralphStore.getRun(props.sessionId);
  let listScrollRef: HTMLDivElement | undefined;

  function updateScrollbarInset() {
    if (!listScrollRef) return;
    const scrollbarInset = Math.max(0, listScrollRef.offsetWidth - listScrollRef.clientWidth);
    listScrollRef.parentElement?.style.setProperty(
      '--ralph-dashboard-scrollbar-inset',
      `${scrollbarInset}px`
    );
  }

  const isRunning = () => run()?.status === 'running';
  const isResumable = () => {
    const s = run()?.status;
    return s === 'paused' || s === 'failed' || s === 'incomplete';
  };
  const isTerminal = () => {
    const s = run()?.status;
    return s === 'done' || s === 'stopped' || s === 'failed' || s === 'incomplete';
  };
  const providerLimit = () => {
    const model = run()?.config.model;
    if (!model) return null;
    return getProviderLimit(model.providerID, model.modelID);
  };
  const providerLimitBadges = () => {
    const limit = providerLimit();
    if (!isRunning() || !limit || limit.status !== 'available') return [];
    return getProviderLimitCompactBadges(limit);
  };
  const providerLimitTitle = () => {
    const limit = providerLimit();
    return limit ? formatProviderLimitTitle(limit) : '';
  };
  const latestIteration = () => {
    const iterations = run()?.iterations;
    return iterations && iterations.length > 0 ? iterations[iterations.length - 1] : null;
  };
  const activeIssue = () => getRalphIterationLiveIssue(latestIteration());
  const latestIterationShowsOwnError = () => {
    const iteration = latestIteration();
    if (!iteration) return false;
    return iteration.status === 'failed' || (iteration.status === 'running' && !!activeIssue());
  };
  const globalIssue = () => {
    const issue = activeIssue();
    return latestIterationShowsOwnError() ? null : issue;
  };
  const modelSummary = () => {
    const model = run()?.config.model;
    if (!model) return null;
    return `${model.providerID}/${model.modelID}${formatReasoningLevel(model.variant)}`;
  };

  createEffect(() => {
    const listScroll = listScrollRef;
    if (!listScroll) return;
    updateScrollbarInset();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => updateScrollbarInset());
    observer.observe(listScroll);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div class="ralph-dashboard">
      <Show
        when={run()}
        fallback={
          <div class="ralph-dashboard-list-scroll" ref={(el) => (listScrollRef = el)}>
            <div class="ralph-dashboard-list-track">
              <div class="ralph-dashboard-empty">Ralph run not found.</div>
            </div>
          </div>
        }
      >
        {(activeRun) => (
          <>
            <div class="ralph-dashboard-fixed">
              <div class="ralph-dashboard-fixed-track">
                <header class="ralph-dashboard-header">
                  <div class="ralph-dashboard-header-left">
                    <span class="ralph-dashboard-tag">Ralph</span>
                    <span class="ralph-dashboard-plan" title={activeRun().config.planDocPath}>
                      {planLabel(activeRun().config.planDocPath)}
                    </span>
                    <span
                      class={`ralph-dashboard-status ralph-dashboard-status-${activeRun().status}`}
                    >
                      {activeRun().status}
                    </span>
                    <Show when={activeRun().stopReason}>
                      {(reason) => (
                        <span
                          class="ralph-dashboard-stop-reason"
                          title={activeIssue() || stopReasonTooltip(reason())}
                        >
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
                          <rect x="3.5" y="2.5" width="3" height="11" rx="1.25" />
                          <rect x="9.5" y="2.5" width="3" height="11" rx="1.25" />
                        </svg>
                      </button>
                    </Show>
                    <Show when={isResumable()}>
                      <button
                        type="button"
                        class={resumeButtonClass(activeRun().status)}
                        title={resumeButtonTitle(activeRun().status)}
                        aria-label={resumeButtonLabel(activeRun().status)}
                        onClick={() => void ralphRunner.resume(props.sessionId)}
                      >
                        <Show
                          when={activeRun().status === 'incomplete'}
                          fallback={resumeButtonLabel(activeRun().status)}
                        >
                          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path d="M3.5 2.5l9 5.5-9 5.5z" />
                          </svg>
                        </Show>
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
                          <rect x="2.5" y="2.5" width="11" height="11" rx="2.25" />
                        </svg>
                      </button>
                    </Show>
                  </div>
                </header>

                <section class="ralph-dashboard-meta">
                  <div class="ralph-dashboard-meta-main">
                    <span class="ralph-dashboard-meta-item">
                      Iterations: {activeRun().iterations.length} / {activeRun().config.iterations}
                    </span>
                    <Show when={modelSummary()}>
                      {(summary) => (
                        <span
                          class="ralph-dashboard-meta-item ralph-dashboard-meta-item-model"
                          title={summary()}
                        >
                          <span class="ralph-dashboard-meta-label">Model:</span>
                          <span class="ralph-dashboard-meta-value">{summary()}</span>
                        </span>
                      )}
                    </Show>
                    <Show when={activeRun().config.agent}>
                      <span class="ralph-dashboard-meta-item">
                        Agent: {activeRun().config.agent}
                      </span>
                    </Show>
                  </div>
                  <Show when={providerLimitBadges().length > 0}>
                    <div
                      class="ralph-dashboard-provider-limits"
                      title={providerLimitTitle() || undefined}
                    >
                      <span class="ralph-dashboard-provider-limits-label">Limits:</span>
                      <For each={providerLimitBadges()}>
                        {(badge, index) => (
                          <>
                            <Show when={index() > 0}>
                              <span class="ralph-dashboard-provider-limit-separator">&middot;</span>
                            </Show>
                            <span class={`ralph-dashboard-provider-limit ${badge.tone}`}>
                              {badge.label}
                            </span>
                          </>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={globalIssue()}>
                    {(issue) => (
                      <div class="ralph-dashboard-error" title={issue()}>
                        <span class="ralph-dashboard-error-label">Error</span>
                        <span class="ralph-dashboard-error-message">{issue()}</span>
                      </div>
                    )}
                  </Show>
                </section>
              </div>
            </div>

            <div class="ralph-dashboard-list-scroll" ref={(el) => (listScrollRef = el)}>
              <section class="ralph-dashboard-list-track ralph-dashboard-list">
                <Show
                  when={activeRun().iterations.length > 0}
                  fallback={<div class="ralph-dashboard-empty">No iterations yet.</div>}
                >
                  <For each={activeRun().iterations.toReversed()}>
                    {(iteration) => <RalphIterationCard iteration={iteration} />}
                  </For>
                </Show>
              </section>
            </div>
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

function resumeButtonLabel(status: RalphStatus): string {
  if (status === 'incomplete') {
    return `Add ${RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT} runs & continue`;
  }
  return 'Resume';
}

function resumeButtonTitle(status: RalphStatus): string {
  if (status === 'incomplete') {
    return `Increase the iteration limit by ${RALPH_INCOMPLETE_RESUME_ITERATION_INCREMENT} and continue the Ralph loop.`;
  }
  return 'Resume';
}

function resumeButtonClass(status: RalphStatus): string {
  if (status === 'incomplete') {
    return 'ralph-dashboard-btn ralph-dashboard-btn-icon ralph-dashboard-btn-continue';
  }
  return 'ralph-dashboard-btn';
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
