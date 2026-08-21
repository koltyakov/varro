import { Show, createSignal, onCleanup } from 'solid-js';
import { formatLoadingElapsed } from '../../lib/time-format';
import { loadingStartedAt } from '../../lib/state';

export function BusyIndicator() {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(timer));

  const elapsedLabel = () => {
    const startedAt = loadingStartedAt();
    if (startedAt === null) return null;
    return formatLoadingElapsed(Math.max(0, (now() - startedAt) / 1000));
  };

  return (
    <div class="chat-busy-indicator" role="status" title="Agent is working">
      <span class="chat-busy-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <Show when={elapsedLabel()}>
        <span class="chat-busy-elapsed">{elapsedLabel()}</span>
      </Show>
    </div>
  );
}
