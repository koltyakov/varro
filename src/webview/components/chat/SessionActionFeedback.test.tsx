import { flush as flushSolid, createSignal } from 'solid-js';
import { render } from '@solidjs/web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionActionFeedback, showSessionActionFeedback } from './SessionActionFeedback';

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
});

describe('SessionActionFeedback compact copy', () => {
  it.each([
    ['Permission automation ownership changed', 'Approval handler moved'],
    ['Failed to respond to permission', 'Permission reply failed'],
    ['PDFs must be valid and total 20 MiB or less', 'Valid PDFs, max 20 MiB'],
    ['Table attachment timed out. Try selecting it again.', 'Table timed out. Reselect'],
    ['Session renamed', 'Session renamed'],
    ['Side questions support text only', 'Text-only side questions'],
    ['Unexpected server error: keep this detail', 'Unexpected server error: keep this detail'],
  ])('renders %s with the full detail preserved', (original, compact) => {
    cleanup = render(() => <SessionActionFeedback error={() => original} />, document.body);
    flushSolid();

    const text = document.body.querySelector('.session-action-feedback-message');
    expect(text?.textContent).toBe(compact);
    expect(text?.getAttribute('title')).toBe(original);
    expect(text?.getAttribute('aria-label')).toBe(original);
    expect(document.body.querySelector('.session-action-feedback')?.getAttribute('role')).toBe(
      'alert'
    );
  });

  it('updates compact copy without losing retry or dismissal', () => {
    const [error, setError] = createSignal('Permission automation ownership changed');
    const retry = vi.fn();
    const dismiss = vi.fn();
    cleanup = render(
      () => (
        <SessionActionFeedback error={error} errorRetry={() => retry} onDismissError={dismiss} />
      ),
      document.body
    );
    flushSolid();

    const feedback = document.body.querySelector('.session-action-feedback')!;
    feedback.querySelector<HTMLButtonElement>('button')!.click();
    flushSolid();
    feedback.querySelector<HTMLButtonElement>('.session-action-feedback-dismiss')!.click();
    flushSolid();
    expect(retry).toHaveBeenCalledOnce();
    expect(dismiss).toHaveBeenCalledOnce();

    setError('Failed to update permissions');
    flushSolid();
    const text = feedback.querySelector('.session-action-feedback-message');
    expect(text?.textContent).toBe('Permission update failed');
    expect(text?.getAttribute('title')).toBe('Failed to update permissions');
  });

  it('compacts warning feedback too', () => {
    cleanup = render(() => <SessionActionFeedback />, document.body);
    flushSolid();
    showSessionActionFeedback('Wait for pending image pastes to finish', 'warning');
    flushSolid();

    const feedback = document.body.querySelector('.session-action-feedback');
    expect(feedback?.classList).toContain('is-warning');
    expect(feedback?.getAttribute('role')).toBe('status');
    expect(feedback?.querySelector('.session-action-feedback-message')?.textContent).toBe(
      'Wait for image pastes'
    );
  });

  it('shows the vision warning anchored to the composer with the full detail preserved', () => {
    cleanup = render(
      () => (
        <>
          <div class="chat-input-container" />
          <SessionActionFeedback />
        </>
      ),
      document.body
    );
    flushSolid();
    const composer = document.body.querySelector<HTMLDivElement>('.chat-input-container')!;
    const detail = 'Image attached; use a vision-capable model or vision subagent to send it';
    showSessionActionFeedback(detail, 'warning', composer);
    flushSolid();

    const feedback = composer.querySelector('.session-action-feedback');
    expect(feedback?.classList).toContain('is-input-anchored');
    expect(feedback?.classList).toContain('is-warning');
    const text = feedback?.querySelector('.session-action-feedback-message');
    expect(text?.textContent).toBe('Use vision model');
    expect(text?.getAttribute('title')).toBe(detail);
    expect(text?.getAttribute('aria-label')).toBe(detail);
  });
});
