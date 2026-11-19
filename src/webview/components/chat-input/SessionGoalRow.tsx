import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { parseSessionGoal } from '../../../shared/session-goal';
import type { SessionGoal } from '../../../shared/session-goal';
import { client, serverEvents } from '../../lib/client';
import { pauseIcon, playIcon, trashIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';

export function SessionGoalRow(props: { sessionID: string | null; directory?: string }) {
  const [goal, setGoal] = createSignal<SessionGoal | null>(null);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(
    () => ({ sessionID: props.sessionID, directory: props.directory }),
    ({ sessionID, directory }) => {
      setGoal(null);
      setPending(false);
      setError(null);
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

  return (
    <Show when={goal()}>
      {(current) => (
        <div class="chat-queue-container chat-session-goal" role="group" aria-label="Session goal">
          <div class="chat-queue-item">
            <span class="chat-queue-body">
              <span class="chat-queue-label" title={current().objective}>
                Goal: {current().objective}
              </span>
            </span>
            <span class="chat-background-service-status" title={current().reason}>
              {current().status === 'active'
                ? 'Active'
                : current().status === 'paused'
                  ? 'Paused'
                  : 'Complete'}
            </span>
            <div class="chat-goal-controls">
              <Show when={current().status !== 'complete'}>
                <button
                  type="button"
                  class="chat-queue-control"
                  aria-label={current().status === 'paused' ? 'Resume goal' : 'Pause goal'}
                  title={current().status === 'paused' ? 'Resume goal' : 'Pause goal'}
                  disabled={pending()}
                  onClick={() => void control(current().status === 'paused' ? 'resume' : 'pause')}
                >
                  <UiIcon
                    source={current().status === 'paused' ? playIcon : pauseIcon}
                    width={14}
                    height={14}
                  />
                </button>
              </Show>
              <button
                type="button"
                class="chat-queue-control chat-queue-remove"
                aria-label="Clear goal"
                title="Clear goal"
                disabled={pending()}
                onClick={() => void control('clear')}
              >
                <UiIcon source={trashIcon} width={14} height={14} />
              </button>
            </div>
          </div>
          <Show when={current().status !== 'active' && current().reason}>
            <div class="chat-goal-reason" aria-label="Goal reason">
              {current().reason}
            </div>
          </Show>
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
