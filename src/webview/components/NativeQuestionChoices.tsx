import { createEffect, For, Show, createSignal } from 'solid-js';
import { ariaBoolean } from '../lib/aria';
import type { NativeFormValue } from '../../shared/protocol';
import { isString } from '../../shared/type-utils';

type QuestionChoice = { value: string | boolean; label: string; description?: string };

export function NativeQuestionChoices(props: {
  id: string;
  label: string;
  options: QuestionChoice[];
  value: NativeFormValue | undefined;
  required: boolean;
  invalid: boolean;
  describedBy?: string;
  disabled: boolean;
  custom?: boolean;
  customValue?: string;
  onChange(value: string | boolean): void;
  onCustomChange?(value: string): void;
}) {
  const unmatchedValue = () =>
    isString(props.value) && !props.options.some((option) => option.value === props.value);
  const [customSelected, setCustomSelected] = createSignal(!!props.custom && unmatchedValue());
  const customText = () =>
    unmatchedValue() && isString(props.value) ? props.value : (props.customValue ?? '');
  const name = () => `native-question-${props.id}`;
  let customInput: HTMLTextAreaElement | undefined;

  createEffect(
    () => ({ value: props.value, custom: props.custom, unmatched: unmatchedValue() }),
    ({ value, custom, unmatched }) => {
      if (value === undefined) setCustomSelected(false);
      else if (custom && unmatched) setCustomSelected(true);
    }
  );

  function choose(option: QuestionChoice) {
    if (customSelected()) props.onCustomChange?.(customText());
    setCustomSelected(false);
    props.onChange(option.value);
  }

  function chooseCustom() {
    setCustomSelected(true);
    props.onChange(props.customValue ?? '');
    customInput?.focus();
  }

  return (
    <div
      class="native-form-choices"
      role="radiogroup"
      aria-label={props.label}
      aria-required={ariaBoolean(props.required)}
      aria-describedby={props.describedBy}
    >
      <For each={props.options}>
        {(option, index) => {
          const descriptionID = `${props.id}-choice-${index()}-description`;
          return (
            <label
              class={[
                'question-option native-question-choice',
                { selected: !customSelected() && props.value === option.value },
              ]}
            >
              <input
                class="native-question-choice-input"
                type="radio"
                name={name()}
                value={String(option.value)}
                aria-label={option.label}
                aria-invalid={ariaBoolean(props.invalid)}
                aria-required={ariaBoolean(props.required)}
                aria-describedby={
                  [props.describedBy, option.description ? descriptionID : undefined]
                    .filter(Boolean)
                    .join(' ') || undefined
                }
                disabled={props.disabled}
                checked={!customSelected() && props.value === option.value}
                onChange={() => choose(option)}
              />
              <span class="question-option-text">
                <span class="question-option-label">{option.label}</span>
                <Show when={option.description}>
                  <span id={descriptionID} class="question-option-desc">
                    {' '}
                    {option.description}
                  </span>
                </Show>
              </span>
            </label>
          );
        }}
      </For>
      <Show when={props.custom}>
        <div
          class={[
            'question-option question-option-custom native-question-choice',
            { selected: customSelected() },
          ]}
        >
          <input
            class="native-question-choice-input"
            id={`${props.id}-custom`}
            type="radio"
            name={name()}
            aria-label="Custom answer"
            aria-invalid={ariaBoolean(props.invalid)}
            disabled={props.disabled}
            aria-describedby={props.describedBy}
            checked={customSelected()}
            onChange={chooseCustom}
          />
          <div class="question-option-text question-custom-content">
            <textarea
              ref={(el) => {
                customInput = el;
              }}
              rows={1}
              class="question-custom-input native-form-text-input"
              aria-label={`${props.label}: custom answer`}
              aria-invalid={ariaBoolean(props.invalid)}
              aria-describedby={props.describedBy}
              placeholder="Type your own answer"
              autocomplete="off"
              disabled={props.disabled}
              value={customText()}
              onInput={(event) => {
                setCustomSelected(true);
                props.onCustomChange?.(event.currentTarget.value);
                props.onChange(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }}
            />
          </div>
        </div>
      </Show>
    </div>
  );
}
