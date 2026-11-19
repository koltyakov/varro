import { ariaBoolean } from '../../lib/aria';
import { Show, createMemo, createSignal } from 'solid-js';
import {
  getMessageBlockExpanded,
  setMessageBlockExpanded,
} from '../../lib/tool-call-expansion-state';
import type { FileDiff } from '../../types';
import { navArrowRightIcon } from '../../lib/ui-icons';
import { DiffView } from '../DiffView';
import { UiIcon } from '../UiIcon';

export function DiffSummary(props: { diffs: FileDiff[]; stateKey: string }) {
  // Writable derived state: the remembered expansion is the seed, and it follows a new key.
  const [expanded, setExpanded] = createSignal(
    () => getMessageBlockExpanded(props.stateKey) ?? false
  );
  const summary = createMemo(() =>
    props.diffs.reduce((acc, d) => ({ add: acc.add + d.additions, del: acc.del + d.deletions }), {
      add: 0,
      del: 0,
    })
  );

  const toggleExpanded = () => {
    const nextExpanded = !expanded();
    setMessageBlockExpanded(props.stateKey, nextExpanded);
    setExpanded(nextExpanded);
  };

  return (
    <div class="diff-summary">
      <button
        onClick={toggleExpanded}
        class="diff-summary-btn"
        aria-expanded={ariaBoolean(expanded())}
      >
        <UiIcon
          source={navArrowRightIcon}
          class={`transition-transform ${expanded() ? 'rotate-90' : ''}`}
          width="10"
          height="10"
        />
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
