import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { parseSessionGoal } from '../../../shared/session-goal';
import type { SessionGoal } from '../../../shared/session-goal';
import { client, serverEvents } from '../../lib/client';
import {
  clipboardCheckIcon,
  pasteClipboardIcon,
  pauseIcon,
  playIcon,
  trashIcon,
  xmarkIcon,
} from '../../lib/ui-icons';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';

export function SessionGoalRow(props: {
  sessionID: string | null;
  directory?: string;
  /** Reports the shown goal's status, or `null` without a goal, for grouping composer blocks. */
  onStatusChange?: (status: SessionGoal['status'] | null) => void;
}) {
  const [goal, setGoal] = createSignal<SessionGoal | null>(null);
  createEffect(
    () =>
      props.onStatusChange
        ? { notify: props.onStatusChange, status: goal()?.status ?? null }
        : null,
    (result) => {
      result?.notify(result.status);
    }
  );
  onCleanup(() => props.onStatusChange?.(null));
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [objectiveClipped, setObjectiveClipped] = createSignal(false);
  // oxlint-disable-next-line no-unassigned-vars
  let goalRow: HTMLDivElement | undefined;

  createEffect(
    () => ({ sessionID: props.sessionID, directory: props.directory }),
    ({ sessionID, directory }) => {
      setGoal(null);
      setPending(false);
      setError(null);
      setObjectiveClipped(false);
      if (!sessionID) return;
      const controller = new AbortController();
      let turn = 0;
      const load = async () => {
        const current = ++turn;
        try {
          const next = await client.session.goal(sessionID, {
            directory,
            signal: controller.signal,
          });
          if (!controller.signal.aborted && current === turn) setGoal(next);
        } catch {
          // Older servers and locations without the goal plugin have no goal RPC.
          // Keep event-delivered state if a reconnect read fails.
        }
      };
      const unsubscribe = serverEvents.on('session.goal.updated', (event) => {
        if (event.properties?.sessionID !== sessionID) return;
        const next = parseSessionGoal(event.properties.goal);
        if (event.properties.goal !== null && !next) return;
        turn++;
        setGoal(next);
        setError(null);
      });
      const reconnect = serverEvents.on('server.connected', () => void load());
      void load();
      return () => {
        controller.abort();
        unsubscribe();
        reconnect();
      };
    }
  );

  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const control = async (action: 'pause' | 'resume' | 'clear') => {
    const sessionID = props.sessionID;
    const directory = props.directory;
    if (!sessionID || pending()) return;
    setPending(true);
    setError(null);
    try {
      // Do not send picker routing or a second prompt. Controls update the existing
      // goal without changing the model, agent, draft, or the current turn.
      await client.session.command(
        sessionID,
        { command: 'goal', arguments: action },
        { directory }
      );
    } catch (cause) {
      if (!disposed && props.sessionID === sessionID && props.directory === directory)
        setError(cause instanceof Error ? cause.message : 'Failed to update goal');
    } finally {
      if (!disposed && props.sessionID === sessionID && props.directory === directory)
        setPending(false);
    }
  };

  const measureObjective = (element: HTMLElement) => {
    const label = element.querySelector<HTMLElement>('.chat-queue-label');
    setObjectiveClipped(
      !!label && (label.scrollWidth > label.clientWidth || label.scrollHeight > label.clientHeight)
    );
  };

  return (
    <Show when={goal()}>
      {(current) => (
        <div
          ref={goalRow}
          class="chat-queue-container chat-session-goal"
          role="group"
          aria-label="Session goal"
        >
          <div class={`chat-queue-item${current().status === 'paused' ? ' is-paused' : ''}`}>
            <Tooltip
              variant="panel"
              anchor={() => goalRow}
              disabled={!current().reason && !objectiveClipped()}
              content={
                <>
                  <Show when={objectiveClipped()}>
                    <div class="chat-goal-tooltip-objective">{current().objective}</div>
                  </Show>
                  <Show when={current().reason}>
                    <div class="chat-goal-tooltip-reason">{current().reason}</div>
                  </Show>
                </>
              }
            >
              <span
                class="chat-queue-body"
                tabindex={0}
                onMouseEnter={(event) => measureObjective(event.currentTarget)}
                onFocus={(event) => measureObjective(event.currentTarget)}
              >
                <UiIcon
                  class="chat-goal-icon"
                  source={current().status === 'complete' ? clipboardCheckIcon : pasteClipboardIcon}
                  width={14}
                  height={14}
                  role="img"
                  aria-label={current().status === 'complete' ? 'Goal complete' : 'Goal'}
                />
                <span class="chat-queue-label">{current().objective}</span>
              </span>
            </Tooltip>
            <Show when={current().status === 'paused'}>
              <Tooltip content={current().reason || 'Paused'}>
                <span class="chat-queue-paused-label">Paused</span>
              </Tooltip>
            </Show>
            {/* Revealed on hover or keyboard focus, like the controls of a queued message. */}
            <div class="chat-goal-controls chat-queue-actions">
              <Show when={current().status !== 'complete'}>
                <Tooltip content={current().status === 'paused' ? 'Resume goal' : 'Pause goal'}>
                  <button
                    type="button"
                    class="chat-queue-control"
                    aria-label={current().status === 'paused' ? 'Resume goal' : 'Pause goal'}
                    disabled={pending()}
                    onClick={() => void control(current().status === 'paused' ? 'resume' : 'pause')}
                  >
                    <UiIcon
                      source={current().status === 'paused' ? playIcon : pauseIcon}
                      width={14}
                      height={14}
                    />
                  </button>
                </Tooltip>
              </Show>
              <Tooltip content={current().status === 'complete' ? 'Close goal' : 'Clear goal'}>
                <button
                  type="button"
                  class={[
                    'chat-queue-control',
                    current().status === 'complete' ? 'chat-goal-close' : 'chat-queue-remove',
                  ]}
                  aria-label={current().status === 'complete' ? 'Close goal' : 'Clear goal'}
                  disabled={pending()}
                  onClick={() => void control('clear')}
                >
                  <UiIcon
                    source={current().status === 'complete' ? xmarkIcon : trashIcon}
                    width={14}
                    height={14}
                  />
                </button>
              </Tooltip>
            </div>
          </div>
          <Show when={error()}>
            <div class="chat-goal-error" role="alert">
              {error()}
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}
