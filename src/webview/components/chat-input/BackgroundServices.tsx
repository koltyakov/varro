import { For, Show, createEffect, createSignal, onCleanup } from 'solid-js';
import type { BackgroundProcess } from '../../../shared/background-process';
import { client } from '../../lib/client';
import { openBackgroundProcessView } from '../../lib/background-process-view';
import { terminalIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';

export function BackgroundServices(props: {
  sessionID: string | null;
  directory?: string;
  count: number;
}) {
  const [services, setServices] = createSignal<BackgroundProcess[]>([]);
  const [visible, setVisible] = createSignal(!document.hidden);
  const onVisibilityChange = () => setVisible(!document.hidden);
  document.addEventListener('visibilitychange', onVisibilityChange);
  onCleanup(() => document.removeEventListener('visibilitychange', onVisibilityChange));

  createEffect(() => {
    const sessionID = props.sessionID;
    const directory = props.directory;
    const count = props.count;
    setServices([]);
    if (!sessionID || count <= 0 || !visible()) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    // Commands are immutable. Refresh on service-count changes, not on a timer, and never fetch logs.
    void client.session
      .backgroundProcesses(sessionID, { directory, signal: controller.signal })
      .then((processes) => {
        if (!controller.signal.aborted)
          setServices(
            processes.filter((process) => process.service && process.status === 'running')
          );
      })
      .catch(() => {
        // Keep a disclosure row when the list cannot load. The details dialog exposes errors and Retry.
      });
  });

  const inspect = (processID?: string) => {
    if (props.sessionID) openBackgroundProcessView(props.sessionID, props.directory, processID);
  };
  return (
    <Show when={props.sessionID && props.count > 0}>
      <div class="chat-queue-container chat-background-services">
        <div class="chat-queue-list" role="list" aria-label="Background services">
          <Show
            when={services().length > 0}
            fallback={
              <div role="listitem">
                <button
                  type="button"
                  class="chat-queue-item chat-background-service"
                  onClick={() => inspect()}
                >
                  <span class="chat-queue-body">
                    <span class="chat-background-service-icon" aria-hidden="true">
                      <UiIcon source={terminalIcon} width={12} height={12} />
                    </span>
                    <span class="chat-queue-label">
                      {props.count} background {props.count === 1 ? 'service' : 'services'}
                    </span>
                  </span>
                  <span class="chat-background-service-status">Running</span>
                </button>
              </div>
            }
          >
            <For each={services()}>
              {(process) => (
                <div role="listitem">
                  <button
                    type="button"
                    class="chat-queue-item chat-background-service"
                    aria-label={`Inspect background service: ${process.command}`}
                    title={process.command}
                    onClick={() => inspect(process.id)}
                  >
                    <span class="chat-queue-body">
                      <span class="chat-background-service-icon" aria-hidden="true">
                        <UiIcon source={terminalIcon} width={12} height={12} />
                      </span>
                      <span class="chat-queue-label">{process.command}</span>
                    </span>
                    <span class="chat-background-service-status">Running</span>
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Show>
  );
}
