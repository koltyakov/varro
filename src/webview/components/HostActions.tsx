import { For, createSignal } from 'solid-js';
import { getHostExtension } from '../host/extensions';
import type { HostAction } from '../host/extensions';
import { setError } from '../lib/app-state';

export function HostActions(props: {
  slot: HostAction['slot'];
  sessionId?: string;
  directory?: string;
  onComplete(): void;
}) {
  const [running, setRunning] = createSignal(false);
  const run = async (action: HostAction) => {
    if (running()) return;
    setRunning(true);
    try {
      await action.run({ sessionId: props.sessionId, directory: props.directory });
      props.onComplete();
    } catch (error) {
      setError(`${action.label}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRunning(false);
    }
  };
  return (
    <For each={getHostExtension()?.actions?.filter((action) => action.slot === props.slot)}>
      {(action) => (
        <button
          type="button"
          role="menuitem"
          disabled={running()}
          onClick={() => {
            void run(action);
          }}
        >
          {action.label}
        </button>
      )}
    </For>
  );
}
