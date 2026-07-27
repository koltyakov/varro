import { Show, createSignal, onCleanup } from 'solid-js';
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

export function SessionActionFeedback() {
  onCleanup(() => {
    reset();
    setMessage(null);
  });

  return (
    <Show when={message()}>
      {(currentMessage) => (
        <Portal>
          <div
            class={`session-action-feedback ${leaving() ? 'is-leaving' : ''}`.trim()}
            role="status"
            aria-live="polite"
          >
            <span class="session-action-feedback-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.78 4.22a.75.75 0 010 1.06l-6.5 6.5a.75.75 0 01-1.06 0l-3-3a.75.75 0 111.06-1.06l2.47 2.47 5.97-5.97a.75.75 0 011.06 0z" />
              </svg>
            </span>
            <span class="session-action-feedback-message">{currentMessage()}</span>
          </div>
        </Portal>
      )}
    </Show>
  );
}
