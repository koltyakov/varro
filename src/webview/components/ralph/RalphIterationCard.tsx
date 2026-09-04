import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type {
  RalphIteration,
  RalphVerificationEvidence,
  RalphVerificationVerdict,
} from '../../../shared/ralph';
import { selectSession } from '../../hooks/useOpenCode';
import { client } from '../../lib/client';
import { postMessage } from '../../lib/bridge';
import { isString } from '../../lib/runtime-values';
import { formatDuration } from '../../lib/message-metrics';
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

type RalphIterationStatusLabels = Record<RalphIteration['status'], string>;

const STATUS_LABELS = {
  pending: 'Pending',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  unverified: 'Unverified',
  aborted: 'Aborted',
} satisfies RalphIterationStatusLabels;

export function RalphIterationCard(props: { iteration: RalphIteration }) {
  const [openingEvidence, setOpeningEvidence] = createSignal(false);
  const [evidenceError, setEvidenceError] = createSignal<string | null>(null);
  const openEvidence = async (name: string, evidence: RalphVerificationEvidence) => {
    if (openingEvidence()) return;
    setOpeningEvidence(true);
    setEvidenceError(null);
    try {
      const messages = await client.session.messages(evidence.sessionId);
      const message = messages.find((entry) => entry.info.id === evidence.messageId);
      const part = message?.parts.find((entry) => entry.id === evidence.partId);
      if (
        part?.type !== 'tool' ||
        part.tool !== 'bash' ||
        part.state.status !== 'completed' ||
        !isString(part.state.input.command) ||
        part.state.input.command.trim().replace(/ +/g, ' ') !== evidence.command
      ) {
        throw new Error(
          'Command output is no longer available. Open the session to inspect its history.'
        );
      }
      if (
        !postMessage({
          type: 'vscode/open-text',
          payload: {
            title: `Ralph ${name} command output`,
            content: `${evidence.command}\nRecorded exit: ${evidence.exitCode}\nModel reported: ${evidence.reportedVerdict}\n\n${part.state.output}`,
            language: 'plaintext',
          },
        })
      )
        throw new Error('Could not open command output in the editor.');
    } catch (error) {
      setEvidenceError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningEvidence(false);
    }
  };
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
    <>
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
                <Verdict
                  label={shortenVerdictLabel(name)}
                  fullName={name}
                  value={value}
                  evidence={props.iteration.verificationEvidence?.[name]}
                />
              )}
            </For>
          </span>
        </span>
        <Show when={showNote() && note()}>
          {(value) => <span class="ralph-iter-note">{value()}</span>}
        </Show>
        <Show when={!hidesDuration() && durationMs() !== null}>
          <span class="ralph-iter-duration">{formatDuration(durationMs()!)}</span>
        </Show>
      </button>
      <Show when={Object.keys(props.iteration.verificationEvidence ?? {}).length > 0}>
        <details class="ralph-verification-evidence">
          <summary>Verification command evidence</summary>
          <For each={Object.entries(props.iteration.verificationEvidence ?? {})}>
            {([name, evidence]) => (
              <div>
                <button
                  type="button"
                  disabled={openingEvidence()}
                  onClick={() => void openEvidence(name, evidence)}
                  title="Open recorded command output"
                >
                  {name}: <code>{evidence.command}</code> - exit {evidence.exitCode}
                  <Show when={evidence.reportedVerdict === 'pass' && evidence.exitCode !== 0}>
                    {' '}
                    (model reported PASS; command failed)
                  </Show>
                </button>
                <button type="button" onClick={() => void selectSession(evidence.sessionId)}>
                  Open {name} session
                </button>
              </div>
            )}
          </For>
          <Show when={evidenceError()}>{(message) => <p role="alert">{message()}</p>}</Show>
        </details>
      </Show>
    </>
  );
}

function Verdict(props: {
  label: string;
  fullName: string;
  value: RalphVerificationVerdict;
  evidence?: RalphVerificationEvidence;
}) {
  const source = () =>
    props.evidence
      ? `command exit ${props.evidence.exitCode}; model reported ${props.evidence.reportedVerdict}`
      : 'model-reported';
  return (
    <span
      class={`ralph-iter-verdict ralph-iter-verdict-${props.value}`}
      title={`${props.fullName}: ${props.value} (${source()})`}
    >
      {props.label}:{props.value}
      {props.evidence ? ' (command)' : ' (reported)'}
    </span>
  );
}

/**
 * Compress long verification names so the iteration row stays scannable.
 * Multi-word names get initialised (`cargo build` → `cb`); single words up to
 * 9 chars (e.g. `typecheck`) stay whole so they don't read like typos, longer
 * ones are trimmed. The full name is shown in the tooltip.
 */
function shortenVerdictLabel(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length > 1)
    return parts
      .map((p) => p[0])
      .join('')
      .slice(0, 4);
  const single = parts[0] ?? name;
  return single.length <= 9 ? single : single.slice(0, 8);
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
