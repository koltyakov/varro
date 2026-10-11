import { createEffect, createSignal, onCleanup, untrack } from 'solid-js';
import type { Accessor } from 'solid-js';
import {
  MAX_COMPLETION_DRAFT_LENGTH,
  MAX_COMPLETION_RESPONSE_LENGTH,
  normalizePromptSuffix,
  recentCompletionPrompts,
  type PromptCompletionRequest,
} from '../../../shared/prompt-completion';

type PromptCompletionOptions = {
  draft: () => string;
  model: () => string;
  eligible: () => boolean;
  scope: () => string;
  history: () => readonly string[];
  lastAssistantResponse?: () => string | undefined;
  request: (input: PromptCompletionRequest, signal: AbortSignal) => Promise<{ suffix: string }>;
};

export class PromptCompletion {
  readonly suggestion: Accessor<string>;
  readonly error: Accessor<string>;
  readonly pending: Accessor<boolean>;
  private readonly dismissCurrent: () => void;

  constructor(options: PromptCompletionOptions) {
    const [suggestion, setSuggestion] = createSignal('');
    const [error, setError] = createSignal('');
    const [pending, setPending] = createSignal(false);
    const [dismissed, setDismissed] = createSignal<string | null>(null);
    const key = () => JSON.stringify([options.scope(), options.model(), options.draft()]);
    let errorScope = '';

    createEffect(() => {
      const draft = options.draft();
      const requestKey = key();
      const eligible = options.eligible();
      const wasDismissed = dismissed() === requestKey;
      setSuggestion('');
      if (!draft.trim()) setError('');
      const nextErrorScope = JSON.stringify([options.scope(), options.model()]);
      if (nextErrorScope !== errorScope) {
        errorScope = nextErrorScope;
        setError('');
      }
      if (
        !eligible ||
        !options.model().trim() ||
        wasDismissed ||
        draft.trim().length < 3 ||
        draft.length > MAX_COMPLETION_DRAFT_LENGTH ||
        draft.trimEnd().endsWith('.') ||
        draft.trimStart().startsWith('/')
      )
        return;

      const controller = new AbortController();
      const timer = setTimeout(() => {
        const history = untrack(() => recentCompletionPrompts(options.history()));
        // Read context only after the typing pause; streamed replies must not restart the debounce.
        const lastAssistantResponse = untrack(() =>
          options.lastAssistantResponse?.()?.trim().slice(-MAX_COMPLETION_RESPONSE_LENGTH)
        );
        const input: PromptCompletionRequest = { draft, history };
        if (lastAssistantResponse) input.lastAssistantResponse = lastAssistantResponse;
        setPending(true);
        void options.request(input, controller.signal).then(
          (result) => {
            if (!controller.signal.aborted && key() === requestKey && options.eligible()) {
              setPending(false);
              setError('');
              setSuggestion(normalizePromptSuffix(result.suffix, draft));
            }
          },
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection values are untrusted and narrowed before display.
          (failure: unknown) => {
            if (!controller.signal.aborted && key() === requestKey && options.eligible()) {
              setPending(false);
              setError(
                failure instanceof Error && failure.message
                  ? failure.message.slice(0, 500)
                  : 'Could not generate a prompt suggestion.'
              );
            }
          }
        );
      }, 600);
      onCleanup(() => {
        clearTimeout(timer);
        controller.abort();
        setPending(false);
      });
    });

    this.suggestion = suggestion;
    this.error = error;
    this.pending = pending;
    this.dismissCurrent = () => {
      setDismissed(key());
      setSuggestion('');
    };
  }

  dismiss() {
    this.dismissCurrent();
  }
}
