import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { DictationAction, DictationProvider, WebviewMessage } from '../../../shared/protocol';
import { onMessage, postMessage } from '../../lib/bridge';
import { microphoneIcon, microphoneSpeakingSolidIcon } from '../../lib/ui-icons';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';
import { showSessionActionFeedback } from '../chat/SessionActionFeedback';

const REQUEST_TIMEOUT_MS = 25_000;

export function DictationButton(props: {
  focusComposer: () => void;
  remote: boolean;
  onAvailabilityChange?: () => void;
  onActivationChange?: (requested: boolean) => void;
}) {
  const [available, setAvailable] = createSignal(false);
  const [running, setRunning] = createSignal(false);
  const [provider, setProvider] = createSignal<DictationProvider>();
  const providerName = () => (provider() === 'hex' ? 'Hex' : 'Handy');
  // Prefer observed app state; Handy can fall back to the requested state
  // when its optional lifecycle logs are unavailable.
  const [activationRequested, setActivationRequested] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let queuedAction: Exclude<DictationAction, 'status'> | undefined;
  let watchedRequestId: string | undefined;
  let lastRevision = -1;
  let pending:
    | { id: string; action: DictationAction; timer: ReturnType<typeof setTimeout> }
    | undefined;

  const label = () => `${activationRequested() ? 'Stop' : 'Start'} ${providerName()} dictation`;
  const tooltip = () =>
    !running()
      ? `Open ${providerName()} to dictate`
      : activationRequested()
        ? 'Click to finish dictation'
        : 'Click to dictate. Click again when done.';

  function updateActivationRequested(requested: boolean) {
    if (activationRequested() === requested) return;
    setActivationRequested(requested);
    props.onActivationChange?.(requested);
  }

  function request(action: DictationAction) {
    if (props.remote) return;
    if (pending) {
      if (action !== 'status' && pending.action === 'status' && !queuedAction) {
        props.focusComposer();
        queuedAction = action;
        setBusy(true);
      }
      return;
    }
    if (action !== 'status') props.focusComposer();
    const id = crypto.randomUUID();
    if (action !== 'status') watchedRequestId = id;
    setBusy(action !== 'status');
    const timer = setTimeout(() => {
      pending = undefined;
      setBusy(false);
      if (action !== 'status') {
        updateActivationRequested(false);
        showSessionActionFeedback(
          `${providerName()} did not respond. Check its recording state before trying again.`,
          'warning'
        );
      } else {
        dispatchQueuedAction();
      }
    }, REQUEST_TIMEOUT_MS);
    pending = { id, action, timer };
    const payload: Extract<WebviewMessage, { type: 'dictation/request' }>['payload'] = {
      requestId: id,
      action,
    };
    if ((action === 'stop' || action === 'cancel') && provider()) payload.provider = provider();
    if (!postMessage({ type: 'dictation/request', payload })) {
      clearTimeout(timer);
      pending = undefined;
      setBusy(false);
      updateActivationRequested(false);
      if (action !== 'status')
        showSessionActionFeedback(`${providerName()} integration is unavailable.`, 'warning');
    }
  }

  function dispatchQueuedAction() {
    const action = queuedAction;
    queuedAction = undefined;
    if (action) request(action);
  }

  const unsubscribe = onMessage((message) => {
    if (message.type !== 'dictation/result') return;
    const command = message.payload.requestId === pending?.id ? pending : undefined;
    if (!command && message.payload.requestId !== watchedRequestId) return;
    if (command) {
      clearTimeout(command.timer);
      pending = undefined;
      setBusy(false);
    }
    const revision = message.payload.revision;
    if (revision !== undefined && revision < lastRevision) {
      if (command) dispatchQueuedAction();
      return;
    }
    if (revision !== undefined) lastRevision = revision;
    setProvider(message.payload.provider);
    const availabilityChanged = available() !== message.payload.available;
    setAvailable(message.payload.available);
    if (availabilityChanged) props.onAvailabilityChange?.();
    setRunning(message.payload.running);
    updateActivationRequested(
      message.payload.available && message.payload.running && message.payload.state === 'recording'
    );
    if (message.payload.state === 'idle' || message.payload.state === 'unknown')
      watchedRequestId = undefined;
    if (message.payload.error) {
      if (command && command.action !== 'status')
        showSessionActionFeedback(message.payload.error, 'warning');
    }
    if (command) dispatchQueuedAction();
  });
  const refresh = () => {
    if (document.visibilityState !== 'hidden') request('status');
  };
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  onMount(() => {
    if (props.remote) return;
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    refreshTimer = setInterval(refresh, 30_000);
  });
  onCleanup(() => {
    updateActivationRequested(false);
    unsubscribe();
    if (pending) clearTimeout(pending.timer);
    clearInterval(refreshTimer);
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', refresh);
  });

  return (
    <Show when={available() && !props.remote}>
      <Tooltip content={tooltip()}>
        <button
          type="button"
          class="toolbar-dictation-button"
          classList={{ 'activation-requested': activationRequested() }}
          aria-label={label()}
          aria-pressed={activationRequested()}
          aria-busy={busy()}
          disabled={!running() || busy()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => request(activationRequested() ? 'stop' : 'start')}
          onContextMenu={(event) => {
            event.preventDefault();
            if (running() && !busy()) request('cancel');
          }}
        >
          <UiIcon
            source={activationRequested() ? microphoneSpeakingSolidIcon : microphoneIcon}
            width={15}
            height={15}
          />
        </button>
      </Tooltip>
    </Show>
  );
}
