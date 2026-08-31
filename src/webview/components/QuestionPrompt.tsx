import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import type { QuestionRequest } from '../types';
import { rejectQuestion, respondQuestion } from '../hooks/useOpenCode';
import { defaultAppState } from '../lib/state';
import { chatBubbleQuestionIcon, checkIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

type QuestionDraft = {
  selected: Array<Array<string>>;
  customValues: string[];
  currentStep: number;
};

const QUESTION_DRAFT_LIMIT = 100;
const questionDrafts = new Map<string, QuestionDraft>();

function saveQuestionDraft(id: string, draft: QuestionDraft): void {
  questionDrafts.delete(id);
  questionDrafts.set(id, draft);
  if (questionDrafts.size <= QUESTION_DRAFT_LIMIT) return;

  const oldestID = questionDrafts.keys().next().value;
  if (oldestID !== undefined) questionDrafts.delete(oldestID);
}

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const questions = () => props.request.questions || [];
  const isCustomEnabled = (questionIndex: number) => questions()[questionIndex]?.custom !== false;
  const ensureAnswerSlots = <T,>(values: T[], fallback: T) =>
    Array.from({ length: questions().length }, (_, index) => values[index] ?? fallback);
  const savedDraft = () => questionDrafts.get(props.request.id);
  const [selected, setSelected] = createSignal<Array<Array<string>>>(savedDraft()?.selected || []);
  const [customValues, setCustomValues] = createSignal<string[]>(savedDraft()?.customValues || []);
  const [currentStep, setCurrentStep] = createSignal(savedDraft()?.currentStep || 0);

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
    setCurrentStep((step) => Math.min(step, Math.max(0, count - 1)));
  });

  createEffect(() => {
    saveQuestionDraft(props.request.id, {
      selected: selected().map((entry) => [...entry]),
      customValues: [...customValues()],
      currentStep: currentStep(),
    });
  });

  onCleanup(() => {
    queueMicrotask(() => {
      if (!defaultAppState.state.questions.some((question) => question.id === props.request.id)) {
        questionDrafts.delete(props.request.id);
      }
    });
  });

  const [isSubmitting, setIsSubmitting] = createSignal(false);

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
      ensureAnswerSlots(prev, []).map((entry, index) => {
        if (index !== questionIndex) return entry;
        if (multiple) {
          return entry.includes(label) ? entry.filter((item) => item !== label) : [...entry, label];
        }
        return entry[0] === label ? [] : [label];
      })
    );
    if (!multiple && isCustomEnabled(questionIndex)) {
      setCustomValues((prev) =>
        ensureAnswerSlots(prev, '').map((entry, index) => (index === questionIndex ? '' : entry))
      );
    }
  };

  const updateCustom = (questionIndex: number, value: string) => {
    setCustomValues((prev) =>
      ensureAnswerSlots(prev, '').map((entry, index) => (index === questionIndex ? value : entry))
    );
    if (value.trim() && !questions()[questionIndex]?.multiple) {
      setSelected((prev) =>
        ensureAnswerSlots(prev, []).map((entry, index) => (index === questionIndex ? [] : entry))
      );
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
      await respondQuestion(props.request.id, normalizedAnswers(), { rethrow: true });
      questionDrafts.delete(props.request.id);
    } catch {
      // The helper has already surfaced the error; retain the draft for retry.
    } finally {
      setIsSubmitting(false);
    }
  };

  const skip = async () => {
    if (isSubmitting()) return;
    setIsSubmitting(true);
    try {
      await rejectQuestion(props.request.id, { rethrow: true });
      questionDrafts.delete(props.request.id);
    } catch {
      // The helper has already surfaced the error; retain the draft for retry.
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
    <div class="chat-tool-invocation-part question-prompt-card animate-fade-in">
      <div class="question-prompt">
        <div class="question-prompt-header">
          <div class="question-prompt-header-main">
            <UiIcon
              source={chatBubbleQuestionIcon}
              class="question-prompt-icon"
              width={16}
              height={16}
            />
            <div class="question-prompt-heading">
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
              <div class="question-prompt-body">
                <div class="question-prompt-text">{question().question}</div>
                <div class="question-prompt-hint">
                  {question().multiple ? 'Select one or more options.' : 'Select one option.'}
                  <Show when={question().custom !== false}>
                    {' '}
                    You can also type your own answer.
                  </Show>
                </div>
                <div
                  class="question-prompt-options"
                  role={question().multiple ? 'group' : 'radiogroup'}
                >
                  <For each={question().options}>
                    {(option) => {
                      const checked = () =>
                        (selected()[questionIndex()] || []).includes(option.label);
                      const isMultiple = () => question().multiple;
                      return (
                        <div
                          class={`question-option ${checked() ? 'selected' : ''}`}
                          role={isMultiple() ? 'checkbox' : 'radio'}
                          aria-checked={checked()}
                          tabIndex={0}
                          onClick={() =>
                            toggleOption(questionIndex(), option.label, question().multiple)
                          }
                          onKeyDown={(event) => {
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            toggleOption(questionIndex(), option.label, question().multiple);
                          }}
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
                                <UiIcon source={checkIcon} width={10} height={10} />
                              </Show>
                            </div>
                          </Show>
                          <div class="question-option-text">
                            <span class="question-option-label">{option.label}</span>
                            <Show when={option.description}>
                              <span class="question-option-desc">{option.description}</span>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                  <Show when={question().custom !== false}>
                    {(() => {
                      let customInputRef: HTMLTextAreaElement | undefined;
                      return (
                        <div
                          class={`question-option question-option-custom ${(customValues()[questionIndex()] || '').trim() ? 'selected' : ''}`}
                          role={question().multiple ? 'checkbox' : 'radio'}
                          aria-checked={!!(customValues()[questionIndex()] || '').trim()}
                          tabIndex={0}
                          onClick={(event) => {
                            if (event.target === customInputRef) return;
                            if (!question().multiple) {
                              setSelected((prev) =>
                                ensureAnswerSlots(prev, []).map((entry, index) =>
                                  index === questionIndex() ? [] : entry
                                )
                              );
                            }
                            customInputRef?.focus();
                          }}
                          onKeyDown={(event) => {
                            if (event.target === customInputRef) return;
                            if (event.key !== 'Enter' && event.key !== ' ') return;
                            event.preventDefault();
                            customInputRef?.focus();
                          }}
                        >
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
                                <UiIcon source={checkIcon} width={10} height={10} />
                              </Show>
                            </div>
                          </Show>
                          <div class="question-option-text question-custom-content">
                            <span class="question-option-label">Custom answer</span>
                            <textarea
                              rows={1}
                              value={customValues()[questionIndex()] || ''}
                              placeholder="Type your own answer"
                              class="question-custom-input"
                              ref={(el) => {
                                customInputRef = el;
                              }}
                              onInput={(event) =>
                                updateCustom(questionIndex(), event.currentTarget.value)
                              }
                              onChange={(event) =>
                                updateCustom(questionIndex(), event.currentTarget.value)
                              }
                              onKeyDown={(event) => {
                                if (
                                  event.key === 'Enter' &&
                                  (event.metaKey || event.ctrlKey) &&
                                  !event.isComposing
                                ) {
                                  event.preventDefault();
                                  void handlePrimaryAction();
                                }
                              }}
                            />
                          </div>
                        </div>
                      );
                    })()}
                  </Show>
                </div>
              </div>
            );
          }}
        </Show>

        <div class="question-prompt-actions">
          <Show when={currentStep() > 0}>
            <button
              type="button"
              class="question-btn question-btn-secondary"
              disabled={isSubmitting()}
              onClick={goBack}
            >
              Back
            </button>
          </Show>
          <button
            type="button"
            class="question-btn question-btn-tertiary"
            disabled={isSubmitting()}
            onClick={skip}
          >
            Skip
          </button>
          <button
            type="button"
            class="question-btn question-btn-primary"
            disabled={!canAdvance() || isSubmitting()}
            onClick={() => void handlePrimaryAction()}
          >
            {isLastStep() ? 'Submit' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
