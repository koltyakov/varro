import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import {
  getMessageBlockExpanded,
  setMessageBlockExpanded,
} from '../../lib/tool-call-expansion-state';
import type { FileDiff } from '../../types';
import { DiffView } from '../DiffView';

export function DiffSummary(props: { diffs: FileDiff[]; stateKey: string }) {
  let currentStateKey = props.stateKey;
  const [expanded, setExpanded] = createSignal(getMessageBlockExpanded(currentStateKey) ?? false);
  const summary = createMemo(() =>
    props.diffs.reduce((acc, d) => ({ add: acc.add + d.additions, del: acc.del + d.deletions }), {
      add: 0,
      del: 0,
    })
  );

  createEffect(() => {
    const nextStateKey = props.stateKey;
    if (nextStateKey === currentStateKey) return;
    currentStateKey = nextStateKey;
    setExpanded(getMessageBlockExpanded(nextStateKey) ?? false);
  });

  const toggleExpanded = () => {
    const nextExpanded = !expanded();
    setMessageBlockExpanded(props.stateKey, nextExpanded);
    setExpanded(nextExpanded);
  };

  return (
    <div class="diff-summary">
      <button onClick={toggleExpanded} class="diff-summary-btn" aria-expanded={expanded()}>
        <svg
          class={`transition-transform ${expanded() ? 'rotate-90' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span>
          {props.diffs.length} file{props.diffs.length !== 1 ? 's' : ''} changed ·{' '}
          <span class="diff-lines-added">+{summary().add}</span>{' '}
          <span class="diff-lines-removed">-{summary().del}</span>
        </span>
      </button>
      <Show when={expanded()}>
        <div class="diff-summary-content animate-fade-in">
          <DiffView diffs={props.diffs} />
        </div>
      </Show>
    </div>
  );
}
