import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js';
import { redoSession } from '../../hooks/useOpenCode';
import { client } from '../../lib/client';
import { state } from '../../lib/state';
import { checkIcon, redoIcon, undoIcon } from '../../lib/ui-icons';
import { isMessageBehindStagedRevert } from '../message-list/thread-visibility';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';

/**
 * A rewind staged by `/undo` here or in another client. OpenCode keeps the hidden messages until
 * the next prompt commits the rewind, so offer to restore them or remove them now.
 */
export function SessionRewindRow(props: { sessionID: string | null; directory?: string }) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // oxlint-disable-next-line no-unassigned-vars
  let rewindRow: HTMLDivElement | undefined;
  const revert = createMemo(() => {
    const sessionID = props.sessionID;
    if (!sessionID) return undefined;
    return state.sessions.find((session) => session.id === sessionID)?.revert;
  });
  const boundary = () => revert()?.messageID;
  const rewoundPrompts = createMemo(() => {
    const sessionID = props.sessionID;
    const messageID = boundary();
    if (!sessionID || !messageID) return 0;
    return state.messages.filter(
      (entry) =>
        entry.info.sessionID === sessionID &&
        entry.info.role === 'user' &&
        isMessageBehindStagedRevert(entry, messageID)
    ).length;
  });
  const filesRolledBack = () => {
    const current = revert();
    return Boolean(current?.diff) || (current?.files?.length ?? 0) > 0;
  };
  const canApply = () =>
    state.serverStatus.state === 'running' && state.serverStatus.apiVersion === 2;
  const label = () => {
    const count = rewoundPrompts();
    return count > 0 ? `Rewound ${count} ${count === 1 ? 'prompt' : 'prompts'}` : 'Rewound';
  };

  createEffect(boundary, () => {
    setPending(false);
    setError(null);
  });

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const run = async (action: 'restore' | 'apply') => {
    const sessionID = props.sessionID;
    if (!sessionID || pending()) return;
    setPending(true);
    setError(null);
    try {
      if (action === 'restore') await redoSession();
      else await client.session.commitRevert(sessionID, { directory: props.directory });
    } catch (cause) {
      if (!disposed && props.sessionID === sessionID)
        setError(cause instanceof Error ? cause.message : 'Failed to update the rewind');
    } finally {
      if (!disposed && props.sessionID === sessionID) setPending(false);
    }
  };

  return (
    <Show when={boundary()}>
      <div
        ref={rewindRow}
        class="chat-queue-container chat-session-rewind"
        role="group"
        aria-label="Staged rewind"
      >
        <div class="chat-queue-item">
          <Tooltip
            variant="panel"
            anchor={() => rewindRow}
            content={
              <>
                Hidden until your next message removes them for good.
                {filesRolledBack() ? ' Their file changes were rolled back too.' : ''}
              </>
            }
          >
            <span class="chat-queue-body" tabindex={0}>
              <UiIcon
                class="chat-session-row-icon"
                source={undoIcon}
                width={14}
                height={14}
                aria-hidden="true"
              />
              <span class="chat-queue-label">{label()}</span>
            </span>
          </Tooltip>
          <div class="chat-session-row-controls">
            <Tooltip
              content={filesRolledBack() ? 'Restore messages and file changes' : 'Restore messages'}
            >
              <button
                type="button"
                class="chat-queue-control"
                aria-label="Restore rewound messages"
                disabled={pending()}
                onClick={() => void run('restore')}
              >
                <UiIcon source={redoIcon} width={14} height={14} />
              </button>
            </Tooltip>
            <Show when={canApply()}>
              <Tooltip content="Remove rewound messages now">
                <button
                  type="button"
                  class="chat-queue-control"
                  aria-label="Apply rewind"
                  disabled={pending()}
                  onClick={() => void run('apply')}
                >
                  <UiIcon source={checkIcon} width={14} height={14} />
                </button>
              </Tooltip>
            </Show>
          </div>
        </div>
        <Show when={error()}>
          <div class="chat-session-row-error" role="alert">
            {error()}
          </div>
        </Show>
      </div>
    </Show>
  );
}
