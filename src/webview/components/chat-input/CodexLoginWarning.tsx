import { createEffect, createMemo, onCleanup, onMount, Show, untrack } from 'solid-js';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { codexLoginWarningDismissal } from '../../lib/codex-login-warning';
import { requestProviderConnection } from '../../lib/provider-connection-state';
import { STORAGE_KEYS } from '../../lib/state-storage';
import { xmarkIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';

export function CodexLoginWarning(props: { limit: ProviderLimitStatus | null }) {
  const connectionID = createMemo(() => {
    const limit = props.limit;
    return limit?.providerID === 'openai' && limit.status === 'unsupported'
      ? limit.codexLoginRequired?.connectionID
      : undefined;
  });
  createEffect(() => {
    const id = connectionID();
    const limit = props.limit;
    // Other composers may still have older snapshots. Storage changes must not
    // make them repeatedly overwrite each other's connection observations.
    untrack(() => {
      if (id) codexLoginWarningDismissal.observe(id);
      else if (limit?.providerID === 'openai' && limit.status !== 'error')
        codexLoginWarningDismissal.reset();
    });
  });
  const visible = createMemo(() => {
    const id = connectionID();
    const dismissal = codexLoginWarningDismissal.read();
    return id && !(dismissal?.connectionID === id && dismissal.dismissed);
  });
  onMount(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEYS.codexLoginWarningDismissal)
        codexLoginWarningDismissal.reload();
    };
    window.addEventListener('storage', onStorage);
    onCleanup(() => window.removeEventListener('storage', onStorage));
  });

  return (
    <Show when={visible()}>
      <div class="chat-quota-warning chat-codex-login-warning">
        <div class="chat-quota-warning-copy" role="status" aria-live="polite">
          <button
            type="button"
            class="chat-quota-warning-usage"
            title="Switch your OpenAI sign-in method through Codex browser authorization"
            onClick={() => requestProviderConnection('openai', 'chatgpt-browser')}
          >
            Sign in via Codex to see usage limits
          </button>
        </div>
        <div class="chat-quota-warning-actions">
          <button
            type="button"
            class="chat-quota-warning-close"
            aria-label="Dismiss Codex sign-in notice"
            title="Dismiss until you reauthenticate or change accounts"
            onClick={() => codexLoginWarningDismissal.dismiss(connectionID()!)}
          >
            <UiIcon source={xmarkIcon} width="12" height="12" />
          </button>
        </div>
      </div>
    </Show>
  );
}
