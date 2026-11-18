import { Show, createEffect, createSignal, onCleanup } from 'solid-js';
import { client } from '../../lib/client';
import { state } from '../../lib/state';
import { manageChildTask } from '../../hooks/useOpenCode';

/** Mount only inside expanded details, never in a task's summary row. */
export function ChildTaskControls(props: { sessionId: string }) {
  let controller: AbortController | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    controller?.abort();
  });
  const [controls, setControls] =
    createSignal<Awaited<ReturnType<typeof client.session.childTaskControls>>>();
  const [controlsFailed, setControlsFailed] = createSignal(false);
  const [controlsRefresh, setControlsRefresh] = createSignal(0);
  createEffect(
    () => {
      controlsRefresh();
      const id = props.sessionId;
      return { id, directory: state.sessions.find((session) => session.id === id)?.directory };
    },
    ({ id, directory }) => {
      let cancelled = false;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setControlsFailed(false);
      void client.session.childTaskControls(id, directory, request.signal).then(
        (value) => {
          if (!cancelled) setControls(value);
        },
        () => {
          if (!cancelled) setControlsFailed(true);
        }
      );
      return () => {
        cancelled = true;
        request.abort();
      };
    }
  );
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const childWorking = () => {
    const status = state.sessionStatus[props.sessionId];
    return status?.type === 'busy' || status?.type === 'retry';
  };
  const run = async (action: 'stop' | 'background') => {
    if (busy()) return;
    const id = props.sessionId;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const result = await manageChildTask(id, action);
      if (!disposed && props.sessionId === id) setMessage(result);
    } catch (cause) {
      if (!disposed && props.sessionId === id)
        setError(cause instanceof Error ? cause.message : 'Could not manage child work');
    } finally {
      if (!disposed && props.sessionId === id) {
        setBusy(false);
        setControlsRefresh((value) => value + 1);
      }
    }
  };
  return (
    <>
      <Show when={controlsFailed() || controls()?.stopChild || controls()?.backgroundEligible}>
        <div class="structured-tool-row child-task-controls">
          <span class="structured-tool-label">actions</span>
          <div class="structured-tool-value-line child-task-control-actions">
            <Show when={!controlsFailed() && controls()?.stopChild}>
              <button
                type="button"
                disabled={busy() || !childWorking()}
                onClick={() => void run('stop')}
                title="Stops this child and its blocking work, not its parent or siblings. Independent background descendants keep running."
              >
                Stop task
              </button>
            </Show>
            <Show when={!controlsFailed() && controls()?.backgroundEligible && childWorking()}>
              <button
                type="button"
                disabled={busy()}
                onClick={() => void run('background')}
                title="Moves all eligible blocking tools in the parent session to native background observation. This does not stop the child."
              >
                Background
              </button>
            </Show>
            <Show when={controlsFailed()}>
              <span role="alert">Could not load actions. Reopen details to retry.</span>
            </Show>
          </div>
        </div>
      </Show>
      <Show when={message() || error()}>
        <div class="structured-tool-row">
          <span class="structured-tool-label">status</span>
          <span class="structured-tool-value" role={error() ? 'alert' : 'status'}>
            {error() || message()}
          </span>
        </div>
      </Show>
    </>
  );
}
