import { For, Show, createUniqueId } from 'solid-js';
import { ariaBoolean } from '../lib/aria';
import type { NativeFormField, NativeFormValue } from '../../shared/protocol';
import type { NativeMultiSelectDraftRow } from '../lib/native-form-drafts';
import { checkIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

export function NativeMultiSelect(props: {
  field: Extract<NativeFormField, { type: 'multiselect' }>;
  id: string;
  value: NativeFormValue | undefined;
  rows: NativeMultiSelectDraftRow[];
  invalid: boolean;
  disabled: boolean;
  describedBy?: string;
  onChange(value: string[]): void;
  onRowsChange(rows: NativeMultiSelectDraftRow[]): void;
}) {
  const label = () => props.field.title ?? props.field.key;
  const selected = (): string[] => (Array.isArray(props.value) ? props.value : []);
  let root: HTMLDivElement | undefined;

  function toggle(value: string, checked: boolean) {
    props.onChange(checked ? [...selected(), value] : selected().filter((item) => item !== value));
  }

  function updateRow(
    id: string,
    change: Partial<Pick<NativeMultiSelectDraftRow, 'value' | 'selected'>>
  ) {
    if (props.disabled) return;
    if (change.value === '' && props.rows.at(-1)?.id !== id) {
      removeRow(id);
      return;
    }
    const rows = props.rows.map((row) => {
      if (row.id !== id) return row;
      const next = { ...row, ...change };
      return { ...next, selected: !!next.value && next.selected };
    });
    if (props.field.custom && rows.at(-1)?.value)
      rows.push({ id: createUniqueId(), value: '', selected: false });
    props.onRowsChange(rows);
  }

  function removeRow(id: string) {
    if (props.disabled) return;
    const index = props.rows.findIndex((row) => row.id === id);
    const rows = props.rows.filter((row) => row.id !== id);
    props.onRowsChange(rows);
    queueMicrotask(() => {
      const inputs = root?.querySelectorAll<HTMLTextAreaElement>('[data-custom-input]');
      const next = inputs?.[Math.min(index, inputs.length - 1)];
      (next ?? root?.querySelector<HTMLInputElement>('input[type="checkbox"]'))?.focus();
    });
  }

  return (
    <div
      class="native-multiselect"
      ref={(el) => {
        root = el;
      }}
    >
      <Show when={props.field.required}>
        <span class="sr-only" id={`${props.id}-selection-hint`}>
          Select at least one option
        </span>
      </Show>
      <div
        class="native-form-choices"
        role="group"
        aria-label={`${label()}: choices`}
        aria-describedby={
          [props.describedBy, props.field.required ? `${props.id}-selection-hint` : undefined]
            .filter(Boolean)
            .join(' ') || undefined
        }
      >
        <For each={props.field.options}>
          {(option, index) => {
            const descriptionID = () => `${props.id}-option-${index()}-description`;
            return (
              <label
                class={[
                  'question-option native-question-choice native-multiselect-choice',
                  { selected: selected().includes(option.value) },
                ]}
              >
                <span class="native-multiselect-indicator">
                  <input
                    class="native-multiselect-checkbox"
                    type="checkbox"
                    value={option.value}
                    aria-label={option.label}
                    aria-invalid={ariaBoolean(props.invalid)}
                    disabled={props.disabled}
                    aria-describedby={
                      [props.describedBy, option.description ? descriptionID() : undefined]
                        .filter(Boolean)
                        .join(' ') || undefined
                    }
                    checked={selected().includes(option.value)}
                    onChange={(event) => toggle(option.value, event.currentTarget.checked)}
                  />
                  <Show when={selected().includes(option.value)}>
                    <UiIcon
                      class="native-multiselect-check"
                      source={checkIcon}
                      width={10}
                      height={10}
                      aria-hidden="true"
                    />
                  </Show>
                </span>
                <span class="question-option-text">
                  <span class="question-option-label">{option.label}</span>
                  <Show when={option.description}>
                    <span class="question-option-desc" id={descriptionID()}>
                      {' '}
                      {option.description}
                    </span>
                  </Show>
                </span>
              </label>
            );
          }}
        </For>
        <For each={props.rows.map((row) => row.id)}>
          {(id, index) => {
            const row = () => props.rows.find((item) => item.id === id);
            return (
              <Show when={row()}>
                {(current) => (
                  <div
                    class={[
                      'question-option native-question-choice native-multiselect-custom-row',
                      { selected: current().selected && !!current().value },
                    ]}
                    data-custom-row={id}
                  >
                    <span class="native-multiselect-indicator">
                      <input
                        type="checkbox"
                        class="native-multiselect-checkbox"
                        aria-label={`${label()}: select custom value ${index() + 1}`}
                        aria-invalid={ariaBoolean(props.invalid)}
                        aria-describedby={props.describedBy}
                        disabled={props.disabled || !current().value}
                        checked={current().selected && !!current().value}
                        onChange={(event) =>
                          updateRow(id, { selected: event.currentTarget.checked })
                        }
                      />
                      <Show when={current().selected && current().value}>
                        <UiIcon
                          class="native-multiselect-check"
                          source={checkIcon}
                          width={10}
                          height={10}
                          aria-hidden="true"
                        />
                      </Show>
                    </span>
                    <textarea
                      rows={1}
                      autocomplete="off"
                      data-custom-input
                      class="question-custom-input native-form-text-input"
                      aria-label={`${label()}: custom option${index() ? ` ${index() + 1}` : ''}`}
                      aria-invalid={ariaBoolean(props.invalid)}
                      aria-describedby={props.describedBy}
                      placeholder="Type your own answer"
                      disabled={props.disabled || !props.field.custom}
                      value={current().value}
                      onInput={(event) => updateRow(id, { value: event.currentTarget.value })}
                    />
                  </div>
                )}
              </Show>
            );
          }}
        </For>
      </div>
      <Show when={!props.field.options.length && !props.field.custom}>
        <button
          type="button"
          class="question-btn question-btn-secondary native-multiselect-empty"
          aria-label={label()}
          aria-invalid={ariaBoolean(props.invalid)}
          aria-describedby={props.describedBy}
          disabled={props.disabled}
          onClick={() => props.onChange([])}
        >
          Use empty selection
        </button>
      </Show>
    </div>
  );
}
