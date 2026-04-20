import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { QuestionRequest } from '../types';
import { rejectQuestion, respondQuestion } from '../hooks/useOpenCode';

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const questions = () => props.request.questions || [];
  const isCustomEnabled = (questionIndex: number) => questions()[questionIndex]?.custom !== false;
  const [selected, setSelected] = createSignal<Array<Array<string>>>([]);
  const [customValues, setCustomValues] = createSignal<string[]>([]);

  createEffect(() => {
    const count = questions().length;
    setSelected((prev) => {
      if (prev.length === count) return prev;
      return Array.from({ length: count }, (_, i) => prev[i] || []);
    });
    setCustomValues((prev) => {
      if (prev.length === count) return prev;
      return Array.from({ length: count }, (_, i) => prev[i] || '');
    });
  });
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [currentStep, setCurrentStep] = createSignal(0);

  const normalizedAnswers = createMemo(() =>
    questions().map((question, index) => {
      const picks = selected()[index] || [];
      const custom = (customValues()[index] || '').trim();
      if (!isCustomEnabled(index) || !custom) return picks;
      return question.multiple ? [...picks.filter((item) => item !== custom), custom] : [custom];
    })
  );

  const canSubmit = createMemo(() => normalizedAnswers().every((answer) => answer.length > 0));
  const currentQuestion = createMemo(() => questions()[currentStep()]);
  const currentAnswer = createMemo(() => normalizedAnswers()[currentStep()] || []);
  const isLastStep = createMemo(() => currentStep() >= questions().length - 1);
  const canAdvance = createMemo(() => currentAnswer().length > 0);

  const toggleOption = (questionIndex: number, label: string, multiple?: boolean) => {
    setSelected((prev) =>
      prev.map((entry, index) => {
        if (index !== questionIndex) return entry;
        if (multiple) {
          return entry.includes(label) ? entry.filter((item) => item !== label) : [...entry, label];
        }
        return entry[0] === label ? [] : [label];
      })
    );
    if (!multiple && isCustomEnabled(questionIndex)) {
      setCustomValues((prev) => prev.map((entry, index) => (index === questionIndex ? '' : entry)));
    }
  };

  const updateCustom = (questionIndex: number, value: string) => {
    setCustomValues((prev) =>
      prev.map((entry, index) => (index === questionIndex ? value : entry))
    );
    if (value.trim() && !questions()[questionIndex]?.multiple) {
      setSelected((prev) => prev.map((entry, index) => (index === questionIndex ? [] : entry)));
    }
  };

  const goBack = () => {
    if (isSubmitting()) return;
    setCurrentStep((step) => Math.max(0, step - 1));
  };

  const goNext = () => {
    if (!canAdvance() || isSubmitting()) return;
    setCurrentStep((step) => Math.min(questions().length - 1, step + 1));
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

  const handlePrimaryAction = async () => {
    if (!canAdvance() || isSubmitting()) return;
    if (!isLastStep()) {
      goNext();
      return;
    }
    await submit();
  };

  return (
    <div class="question-prompt animate-fade-in">
      <div class="question-prompt-header">
        <div class="question-prompt-header-main">
          <svg class="question-prompt-icon" viewBox="0 0 16 16" fill="currentColor">
            <path
              fill-rule="evenodd"
              clip-rule="evenodd"
              d="M8 15A7 7 0 108 1a7 7 0 000 14zm0-1A6 6 0 108 2a6 6 0 000 12zM7.25 4.5a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4zM8 11a.75.75 0 100 1.5.75.75 0 000-1.5z"
            />
          </svg>
          <div class="question-prompt-heading">
            <span class="question-prompt-label">Input Needed</span>
            <Show when={currentQuestion()?.header}>
              <span class="question-prompt-title">{currentQuestion()!.header}</span>
            </Show>
          </div>
        </div>
        <Show when={questions().length > 1}>
          <span class="question-prompt-step">
            {currentStep() + 1} / {questions().length}
          </span>
        </Show>
      </div>

      <Show when={currentQuestion()}>
        {(question) => {
          const questionIndex = () => currentStep();
          return (
            <div class="question-prompt-panel">
              <div class="question-prompt-text">{question().question}</div>
              <div class="question-prompt-options">
                <For each={question().options}>
                  {(option) => {
                    const checked = () =>
                      (selected()[questionIndex()] || []).includes(option.label);
                    const isMultiple = () => question().multiple;
                    return (
                      <button
                        class={`question-option ${checked() ? 'selected' : ''}`}
                        onClick={() =>
                          toggleOption(questionIndex(), option.label, question().multiple)
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
              <Show when={question().custom !== false}>
                <div class="question-custom-row">
                  <Show
                    when={question().multiple}
                    fallback={
                      <div
                        class={`question-radio ${(customValues()[questionIndex()] || '').trim() ? 'checked' : ''}`}
                      >
                        <Show when={(customValues()[questionIndex()] || '').trim()}>
                          <div class="question-radio-dot" />
                        </Show>
                      </div>
                    }
                  >
                    <div
                      class={`question-checkbox ${(customValues()[questionIndex()] || '').trim() ? 'checked' : ''}`}
                    >
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.isComposing) {
                        e.preventDefault();
                        void handlePrimaryAction();
                      }
                    }}
                  />
                </div>
              </Show>
            </div>
          );
        }}
      </Show>

      <div class="question-prompt-actions">
        <button
          class="question-btn question-btn-secondary"
          disabled={isSubmitting()}
          onClick={skip}
        >
          Skip
        </button>
        <Show when={currentStep() > 0}>
          <button
            class="question-btn question-btn-secondary"
            disabled={isSubmitting()}
            onClick={goBack}
          >
            Back
          </button>
        </Show>
        <button
          class="question-btn question-btn-primary"
          disabled={!canAdvance() || isSubmitting()}
          onClick={() => void handlePrimaryAction()}
        >
          {isLastStep() ? 'Submit' : 'Next'}
        </button>
      </div>
    </div>
  );
}
