import { Show, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';

const VISIBLE_MS = 1_600;
/* Matches the `session-action-feedback-out` animation duration, so the toast
   finishes fading before it leaves the DOM. */
const LEAVE_MS = 160;

const [message, setMessage] = createSignal<string | null>(null);
const [leaving, setLeaving] = createSignal(false);
let leaveTimeout: ReturnType<typeof setTimeout> | undefined;
let clearTimeoutHandle: ReturnType<typeof setTimeout> | undefined;

function reset() {
  clearTimeout(leaveTimeout);
  clearTimeout(clearTimeoutHandle);
  setLeaving(false);
}

export function showSessionActionFeedback(nextMessage: string) {
  reset();
  setMessage(nextMessage);
  leaveTimeout = setTimeout(() => setLeaving(true), VISIBLE_MS);
  clearTimeoutHandle = setTimeout(() => {
    setMessage(null);
    setLeaving(false);
  }, VISIBLE_MS + LEAVE_MS);
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
  });

  return (
    <Show when={currentMessage()}>
      {(visibleMessage) => (
        <Portal>
          <div
            class={`session-action-feedback ${currentError() ? 'is-error' : ''} ${!currentError() && leaving() ? 'is-leaving' : ''}`.trim()}
            role={currentError() ? 'alert' : 'status'}
            aria-live={currentError() ? 'assertive' : 'polite'}
          >
            <span class="session-action-feedback-icon" aria-hidden="true">
              <Show
                when={currentError()}
                fallback={
                  <svg viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.78 4.22a.75.75 0 010 1.06l-6.5 6.5a.75.75 0 01-1.06 0l-3-3a.75.75 0 111.06-1.06l2.47 2.47 5.97-5.97a.75.75 0 011.06 0z" />
                  </svg>
                }
              >
                <svg viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.5 3h1v5h-1V4zm.5 8a.75.75 0 110-1.5.75.75 0 010 1.5z" />
                </svg>
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
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                  </svg>
                </button>
              </span>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );
}
