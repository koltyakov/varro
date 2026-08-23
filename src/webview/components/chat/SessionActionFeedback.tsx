import { Show, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';
import { checkIcon, priorityHighIcon, xmarkIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';

const SUCCESS_VISIBLE_MS = 1_600;
const WARNING_VISIBLE_MS = 5_000;
/* Matches the `session-action-feedback-out` animation duration, so the toast
   finishes fading before it leaves the DOM. */
const LEAVE_MS = 160;

const [message, setMessage] = createSignal<string | null>(null);
const [kind, setKind] = createSignal<'success' | 'warning'>('success');
const [leaving, setLeaving] = createSignal(false);
let leaveTimeout: ReturnType<typeof setTimeout> | undefined;
let clearTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

function reset() {
  clearTimeout(leaveTimeout);
  clearTimeout(clearTimeoutHandle);
  setLeaving(false);
}

export function showSessionActionFeedback(
  nextMessage: string,
  nextKind: 'success' | 'warning' = 'success'
) {
  reset();
  setKind(nextKind);
  setMessage(nextMessage);
  const visibleMs = nextKind === 'warning' ? WARNING_VISIBLE_MS : SUCCESS_VISIBLE_MS;
  leaveTimeout = setTimeout(() => setLeaving(true), visibleMs);
  clearTimeoutHandle = setTimeout(() => {
    setMessage(null);
    setLeaving(false);
  }, visibleMs + LEAVE_MS);
}

interface SessionActionFeedbackProps {
  error?: Accessor<string | null>;
  errorRetry?: Accessor<(() => void) | null>;
  onDismissError?: () => void;
}

export function SessionActionFeedback(props: SessionActionFeedbackProps = {}) {
  const currentError = () => props.error?.() ?? null;
  const currentMessage = () => currentError() ?? message();

  onCleanup(() => {
    reset();
    setMessage(null);
    setKind('success');
  });

  return (
    <Show when={currentMessage()}>
      {(visibleMessage) => (
        <Portal>
          <div
            class={`session-action-feedback ${currentError() ? 'is-error' : kind() === 'warning' ? 'is-warning' : ''} ${!currentError() && leaving() ? 'is-leaving' : ''}`.trim()}
            role={currentError() ? 'alert' : 'status'}
            aria-live={currentError() ? 'assertive' : 'polite'}
          >
            <span class="session-action-feedback-icon" aria-hidden="true">
              <Show
                when={currentError() || kind() === 'warning'}
                fallback={
                  <UiIcon
                    source={checkIcon}
                    class="session-action-feedback-glyph"
                    width={11}
                    height={11}
                  />
                }
              >
                <UiIcon
                  source={priorityHighIcon}
                  class="session-action-feedback-glyph"
                  width={11}
                  height={11}
                />
              </Show>
            </span>
            <span class="session-action-feedback-message" title={visibleMessage()}>
              {visibleMessage()}
            </span>
            <Show when={currentError()}>
              <span class="session-action-feedback-actions">
                <Show when={props.errorRetry?.()}>
                  {(retry) => (
                    <button type="button" onClick={() => retry()()}>
                      Retry
                    </button>
                  )}
                </Show>
                <button
                  type="button"
                  class="session-action-feedback-dismiss"
                  onClick={() => props.onDismissError?.()}
                  aria-label="Dismiss error"
                  title="Dismiss"
                >
                  <UiIcon
                    source={xmarkIcon}
                    class="session-action-feedback-dismiss-icon"
                    width={13}
                    height={13}
                  />
                </button>
              </span>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );
}
