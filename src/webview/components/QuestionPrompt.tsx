import { For, Show, createMemo, createSignal } from 'solid-js';
import type { QuestionRequest } from '../types';
import { rejectQuestion, respondQuestion } from '../hooks/useOpenCode';

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const questions = () => props.request.questions || [];
  const [selected, setSelected] = createSignal<Array<Array<string>>>(
    questions().map(() => [])
  );
  const [customValues, setCustomValues] = createSignal<string[]>(
    questions().map(() => '')
  );
  const [isSubmitting, setIsSubmitting] = createSignal(false);

  const normalizedAnswers = createMemo(() =>
    questions().map((question, index) => {
      const picks = selected()[index] || [];
      const custom = (customValues()[index] || '').trim();
      if (!question.custom || !custom) return picks;
      return [...picks.filter((item) => item !== custom), custom];
    })
  );

  const canSubmit = createMemo(() =>
    normalizedAnswers().every((answer) => answer.length > 0)
  );

  const toggleOption = (questionIndex: number, label: string, multiple?: boolean) => {
    setSelected((prev) =>
      prev.map((entry, index) => {
        if (index !== questionIndex) return entry;
        if (multiple) {
          return entry.includes(label)
            ? entry.filter((item) => item !== label)
            : [...entry, label];
        }
        return entry[0] === label ? [] : [label];
      })
    );
  };

  const updateCustom = (questionIndex: number, value: string) => {
    setCustomValues((prev) => prev.map((entry, index) => (index === questionIndex ? value : entry)));
  };

  const submit = async () => {
    if (!canSubmit() || isSubmitting()) return;
    setIsSubmitting(true);
    try {
      await respondQuestion(props.request.id, normalizedAnswers());
    } finally {
      setIsSubmitting(false);
    }
  };

  const skip = async () => {
    if (isSubmitting()) return;
    setIsSubmitting(true);
    try {
      await rejectQuestion(props.request.id);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div class="question-prompt animate-fade-in">
      <div class="question-prompt-header">
        <svg class="question-prompt-icon" viewBox="0 0 16 16" fill="currentColor">
          <path fill-rule="evenodd" clip-rule="evenodd" d="M8 15A7 7 0 108 1a7 7 0 000 14zm0-1A6 6 0 108 2a6 6 0 000 12zM7.25 4.5a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4zM8 11a.75.75 0 100 1.5.75.75 0 000-1.5z" />
        </svg>
        <span class="question-prompt-label">Input Needed</span>
      </div>

      <For each={questions()}>
        {(question, questionIndex) => (
          <div class={questionIndex() > 0 ? 'question-prompt-separator' : ''}>
            <div class="question-prompt-text">{question.question}</div>
            <div class="question-prompt-options">
              <For each={question.options}>
                {(option) => {
                  const checked = () => (selected()[questionIndex()] || []).includes(option.label);
                  const isMultiple = () => question.multiple;
                  return (
                    <button
                      class={`question-option ${checked() ? 'selected' : ''}`}
                      onClick={() =>
                        toggleOption(questionIndex(), option.label, question.multiple)
                      }
                    >
                      <Show
                        when={isMultiple()}
                        fallback={
                          <div class={`question-radio ${checked() ? 'checked' : ''}`}>
                            <Show when={checked()}>
                              <div class="question-radio-dot" />
                            </Show>
                          </div>
                        }
                      >
                        <div class={`question-checkbox ${checked() ? 'checked' : ''}`}>
                          <Show when={checked()}>
                            <svg width="10" height="10" viewBox="0 0 16 16" fill="white">
                              <path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4z" />
                            </svg>
                          </Show>
                        </div>
                      </Show>
                      <div class="question-option-text">
                        <span class="question-option-label">{option.label}</span>
                        <Show when={option.description}>
                          <span class="question-option-desc">{option.description}</span>
                        </Show>
                      </div>
                    </button>
                  );
                }}
              </For>
            </div>
            <Show when={question.custom !== false}>
              <div class="question-custom-row">
                <Show
                  when={question.multiple}
                  fallback={
                    <div class={`question-radio ${(customValues()[questionIndex()] || '').trim() ? 'checked' : ''}`}>
                      <Show when={(customValues()[questionIndex()] || '').trim()}>
                        <div class="question-radio-dot" />
                      </Show>
                    </div>
                  }
                >
                  <div class={`question-checkbox ${(customValues()[questionIndex()] || '').trim() ? 'checked' : ''}`}>
                    <Show when={(customValues()[questionIndex()] || '').trim()}>
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="white">
                        <path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4z" />
                      </svg>
                    </Show>
                  </div>
                </Show>
                <input
                  type="text"
                  value={customValues()[questionIndex()] || ''}
                  placeholder="Other..."
                  class="question-custom-input"
                  onInput={(e) => updateCustom(questionIndex(), e.currentTarget.value)}
                />
              </div>
            </Show>
          </div>
        )}
      </For>

      <div class="question-prompt-actions">
        <button
          class="question-btn question-btn-secondary"
          disabled={isSubmitting()}
          onClick={skip}
        >
          Skip
        </button>
        <button
          class="question-btn question-btn-primary"
          disabled={!canSubmit() || isSubmitting()}
          onClick={submit}
        >
          Submit
        </button>
      </div>
    </div>
  );
}
