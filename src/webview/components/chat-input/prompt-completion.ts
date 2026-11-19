import { createEffect, createSignal, untrack, type Accessor } from 'solid-js';

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
  private readonly dismissCurrent: (draft?: string) => void;

  constructor(options: PromptCompletionOptions) {
    const [suggestion, setSuggestion] = createSignal('');
    const [error, setError] = createSignal('');
    const [pending, setPending] = createSignal(false);
    const [dismissed, setDismissed] = createSignal<string | null>(null);
    const key = (draft = options.draft()) =>
      JSON.stringify([options.scope(), options.model(), draft]);
    let errorScope = '';

    createEffect(
      () => ({
        draft: options.draft(),
        requestKey: key(),
        eligible: options.eligible(),
        dismissedKey: dismissed(),
        scope: options.scope(),
        model: options.model(),
      }),
      ({ draft, requestKey, eligible, dismissedKey, scope, model }) => {
        const cleanups: Array<() => void> = [];

        const wasDismissed = dismissedKey === requestKey;
        setSuggestion('');
        if (!draft.trim()) setError('');
        const nextErrorScope = JSON.stringify([scope, model]);
        if (nextErrorScope !== errorScope) {
          errorScope = nextErrorScope;
          setError('');
        }
        if (
          !eligible ||
          !model.trim() ||
          wasDismissed ||
          draft.trim().length < 3 ||
          draft.length > MAX_COMPLETION_DRAFT_LENGTH ||
          draft.trimEnd().endsWith('.') ||
          draft.trimStart().startsWith('/')
        )
          return () => {
            for (const cleanup of cleanups.toReversed()) cleanup();
          };

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
        cleanups.push(() => {
          clearTimeout(timer);
          controller.abort();
          setPending(false);
        });

        return () => {
          for (const cleanup of cleanups.toReversed()) cleanup();
        };
      }
    );

    this.suggestion = suggestion;
    this.error = error;
    this.pending = pending;
    this.dismissCurrent = (draft) => {
      setDismissed(key(draft));
      setSuggestion('');
    };
  }

  dismiss(draft?: string) {
    this.dismissCurrent(draft);
  }
}
