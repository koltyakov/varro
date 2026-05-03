import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { RalphIteration, RalphVerificationVerdict } from '../../../shared/ralph';
import { selectSession } from '../../hooks/useOpenCode';
import { getRalphIterationLiveIssue } from './ralph-live-issue';

// Shared ticker so any in-progress iteration card refreshes its displayed
// duration roughly once per second without each card spawning its own timer.
const [tickNow, setTickNow] = createSignal(Date.now());
let tickerSubscribers = 0;
let tickerHandle: ReturnType<typeof setInterval> | null = null;

function acquireTicker(): () => void {
  tickerSubscribers += 1;
  if (tickerHandle === null) {
    tickerHandle = setInterval(() => setTickNow(Date.now()), 1000);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    tickerSubscribers -= 1;
    if (tickerSubscribers <= 0 && tickerHandle !== null) {
      clearInterval(tickerHandle);
      tickerHandle = null;
      tickerSubscribers = 0;
    }
  };
}

const STATUS_LABELS: Record<RalphIteration['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  aborted: 'Aborted',
};

export function RalphIterationCard(props: { iteration: RalphIteration }) {
  // Acquire the shared ticker only while this iteration is still in flight,
  // so completed iterations don't keep an interval alive.
  createEffect(() => {
    const { startedAt, endedAt } = props.iteration;
    if (startedAt && !endedAt) {
      const release = acquireTicker();
      onCleanup(release);
    }
  });

  const durationMs = () => {
    const { startedAt, endedAt } = props.iteration;
    if (!startedAt) return null;
    if (endedAt) return endedAt - startedAt;
    return tickNow() - startedAt;
  };

  const liveIssue = () => getRalphIterationLiveIssue(props.iteration);
  const hasLiveIssue = () => liveIssue() !== null;
  const showExplicitErrorState = () => props.iteration.status === 'failed';
  const showLiveRunningErrorState = () => props.iteration.status === 'running' && hasLiveIssue();
  const open = () => {
    const id = props.iteration.childSessionId;
    if (id) void selectSession(id);
  };
  const note = () => liveIssue() || props.iteration.note;
  const showNote = () => hasErrorState() || !!props.iteration.note;
  const hasErrorState = () => showExplicitErrorState() || showLiveRunningErrorState();
  const hidesDuration = () => hasErrorState();
  const statusClass = () => (hasErrorState() ? 'error' : props.iteration.status);
  const statusLabel = () => (hasErrorState() ? 'Error' : STATUS_LABELS[props.iteration.status]);

  return (
    <button
      type="button"
      class={`ralph-iter-card ralph-iter-${props.iteration.status}${hasErrorState() ? ' ralph-iter-error' : ''}`}
      onClick={open}
      disabled={!props.iteration.childSessionId}
      title={note() || undefined}
    >
      <span class="ralph-iter-index">#{props.iteration.index}</span>
      <span class={`ralph-iter-status ralph-iter-status-${statusClass()}`}>{statusLabel()}</span>
      <Show when={props.iteration.tokens}>
        {(tokens) => (
          <span
            class="ralph-iter-tokens"
            title={`input ${tokens().input} · output ${tokens().output}${tokens().reasoning ? ` · reasoning ${tokens().reasoning}` : ''}${tokens().cacheRead || tokens().cacheWrite ? ` · cache r${tokens().cacheRead}/w${tokens().cacheWrite}` : ''} · total ${tokens().total} (sub-agents included)`}
          >
            ↓{formatTokens(tokens().input)} ↑{formatTokens(tokens().output)}
          </span>
        )}
      </Show>
      <span class="ralph-iter-verdicts">
        <span class="ralph-iter-verdicts-track">
          <For each={Object.entries(props.iteration.verification)}>
            {([name, value]) => (
              <Verdict label={shortenVerdictLabel(name)} fullName={name} value={value} />
            )}
          </For>
        </span>
      </span>
      <Show when={!hidesDuration() && durationMs() !== null}>
        <span class="ralph-iter-duration">{formatDuration(durationMs()!)}</span>
      </Show>
      <Show when={showNote() && note()}>
        {(value) => <span class="ralph-iter-note">{value()}</span>}
      </Show>
    </button>
  );
}

function Verdict(props: { label: string; fullName: string; value: RalphVerificationVerdict }) {
  return (
    <span
      class={`ralph-iter-verdict ralph-iter-verdict-${props.value}`}
      title={`${props.fullName}: ${props.value}`}
    >
      {props.label}:{props.value}
    </span>
  );
}

/**
 * Compress long verification names so the iteration row stays scannable.
 * Multi-word names get initialised (`cargo build` → `cb`); single words
 * keep their first 6 chars. The full name is shown in the tooltip.
 */
function shortenVerdictLabel(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length > 1)
    return parts
      .map((p) => p[0])
      .join('')
      .slice(0, 4);
  const single = parts[0] ?? name;
  return single.length <= 6 ? single : single.slice(0, 6);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m${remainder > 0 ? ` ${remainder}s` : ''}`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
