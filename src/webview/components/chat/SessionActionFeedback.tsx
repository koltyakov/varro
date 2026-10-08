import { Show, batch, createSignal, onCleanup } from 'solid-js';
import type { Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';
import { checkIcon, xmarkIcon } from '../../lib/ui-icons';
import { UiIcon } from '../UiIcon';

const SUCCESS_VISIBLE_MS = 1_600;
const WARNING_VISIBLE_MS = 5_000;
/* Matches the `session-action-feedback-out` animation duration, so the toast
   finishes fading before it leaves the DOM. */
const LEAVE_MS = 160;

// Keep toast copy short without changing errors used by recovery logic or losing
// the original detail in the tooltip and accessible label.
const COMPACT_MESSAGES = new Map<string, string>([
  ['Permission automation ownership changed', 'Approval handler moved'],
  ['Failed to respond to permission', 'Permission reply failed'],
  ['Failed to update permissions', 'Permission update failed'],
  ['Wait for the permission mode update to finish before forking', 'Wait for mode update'],
  ['Select a model before compacting the session', 'Select model to compact'],
  [
    'This conversation is unavailable on the connected OpenCode server.',
    'Conversation unavailable',
  ],
  ['Init is only available for blank sessions', 'Init needs a blank chat'],
  ['Problems context is disabled in settings', 'Problems context disabled'],
  ['Problems already added to context', 'Problems already added'],
  ['PDFs must be valid and total 20 MiB or less', 'Valid PDFs, max 20 MiB'],
  ['PDFs must total 20 MiB or less', 'PDF limit is 20 MiB'],
  ['Table attachment timed out. Try selecting it again.', 'Table timed out. Reselect'],
  ['Wait for pending image pastes to finish', 'Wait for image pastes'],
  ['Image attached; use a vision-capable model or vision subagent to send it', 'Use vision model'],
  [
    'This paste remains inline. Text attachments support 64 KB per paste and 256 KB per draft.',
    'Large paste kept inline',
  ],
]);

const [message, setMessage] = createSignal<string | null>(null);
const [kind, setKind] = createSignal<'success' | 'warning'>('success');
const [anchor, setAnchor] = createSignal<HTMLElement | undefined>();
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
  nextKind: 'success' | 'warning' = 'success',
  nextAnchor?: HTMLElement
) {
  reset();
  batch(() => {
    setKind(nextKind);
    setAnchor(nextAnchor);
    setMessage(nextMessage);
  });
  const visibleMs = nextKind === 'warning' ? WARNING_VISIBLE_MS : SUCCESS_VISIBLE_MS;
  leaveTimeout = setTimeout(() => setLeaving(true), visibleMs);
  clearTimeoutHandle = setTimeout(() => {
    setMessage(null);
    setAnchor(undefined);
    setLeaving(false);
  }, visibleMs + LEAVE_MS);
}

interface SessionActionFeedbackProps {
  error?: Accessor<string | null>;
  errorRetry?: Accessor<(() => void) | null>;
  onDismissError?: () => void;
  status?: Accessor<{ message: string; icon: string; tone?: 'warning' } | null>;
}

export function SessionActionFeedback(props: SessionActionFeedbackProps = {}) {
  const currentError = () => props.error?.() ?? null;
  const currentStatus = () => props.status?.() ?? null;
  const currentMessage = () => currentError() ?? message() ?? currentStatus()?.message ?? null;
  const currentAnchor = () => (currentError() || !message() ? undefined : anchor());
  const currentStatusIcon = () =>
    currentError() || message() ? null : (currentStatus()?.icon ?? null);
  const isWarning = () => !currentError() && message() !== null && kind() === 'warning';
  const hasWarningTone = () =>
    isWarning() || (!currentError() && message() === null && currentStatus()?.tone === 'warning');

  onCleanup(() => {
    reset();
    setMessage(null);
    setAnchor(undefined);
    setKind('success');
  });

  return (
    <Show when={currentMessage()}>
      {(visibleMessage) => (
        <Portal mount={currentAnchor()} ref={(el) => (el.style.display = 'contents')}>
          <div
            class={`session-action-feedback ${currentAnchor() ? 'is-input-anchored' : ''} ${currentError() ? 'is-error' : hasWarningTone() ? 'is-warning' : ''} ${!currentError() && leaving() ? 'is-leaving' : ''}`.trim()}
            role={currentError() ? 'alert' : 'status'}
            aria-live={currentError() ? 'assertive' : 'polite'}
          >
            <span class="session-action-feedback-icon" aria-hidden="true">
              <Show
                when={currentError() || isWarning()}
                fallback={
                  <UiIcon
                    source={currentStatusIcon() ?? checkIcon}
                    class="session-action-feedback-glyph"
                    width={11}
                    height={11}
                  />
                }
              >
                <span class="session-action-feedback-attention-glyph">!</span>
              </Show>
            </span>
            <span
              class="session-action-feedback-message"
              title={visibleMessage()}
              aria-label={visibleMessage()}
            >
              {COMPACT_MESSAGES.get(visibleMessage()) ?? visibleMessage()}
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
