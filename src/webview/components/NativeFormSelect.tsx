import { ariaBoolean } from '../lib/aria';
import { createEffect, For, Show, createSignal, createUniqueId } from 'solid-js';
import { Portal } from '@solidjs/web';
import { getPopupTopBound } from '../lib/popup-position';
import { checkIcon, navArrowDownIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

type FormSelectOption = { value: string; label: string; description?: string };

export function NativeFormSelect(props: {
  label: string;
  value: string;
  options: FormSelectOption[];
  invalid: boolean;
  required?: boolean;
  describedBy?: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const listID = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  let trigger: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const selected = () => props.options.find((option) => option.value === props.value);

  function openMenu() {
    if (props.disabled) return;
    setActiveIndex(
      Math.max(
        0,
        props.options.findIndex((option) => option.value === props.value)
      )
    );
    setOpen(true);
  }

  function choose(index: number) {
    const option = props.options[index];
    if (!option || props.disabled) return;
    props.onChange(option.value);
    setOpen(false);
    trigger?.focus();
  }

  function positionMenu() {
    if (!trigger || !menu || !open()) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(rect.width, window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    const above = Math.max(0, rect.top - getPopupTopBound(trigger, 8) - 4);
    const below = Math.max(0, window.innerHeight - rect.bottom - 12);
    const naturalHeight = menu.scrollHeight + 2;
    const up = below < Math.min(220, naturalHeight) && above > below;
    const height = Math.min(220, naturalHeight, up ? above : below);
    menu.style.maxHeight = `${height}px`;
    menu.style.top = `${up ? rect.top - height - 4 : rect.bottom + 4}px`;
    menu.removeAttribute('data-popup-position-pending');
  }

  createEffect(
    () => props.disabled,
    (disabled) => {
      if (disabled) setOpen(false);
    }
  );

  createEffect(open, (shown) => {
    if (!shown) return;
    queueMicrotask(positionMenu);
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !trigger?.contains(event.target) &&
        !menu?.contains(event.target)
      )
        setOpen(false);
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && menu?.contains(event.target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', close);
    };
  });

  createEffect(
    () => (open() ? activeIndex() : undefined),
    (index) => {
      if (index === undefined) return;
      queueMicrotask(() => {
        const option = menu?.children[index];
        if (!open() || !menu || !(option instanceof HTMLElement)) return;
        // Scroll only the menu, never the transcript or its virtual anchor.
        if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
        else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
          menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
      });
    }
  );

  function handleKeyDown(event: KeyboardEvent) {
    if (props.disabled || event.isComposing) return;
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Escape' && open()) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open()) {
        openMenu();
        return;
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((index) => (index + direction + props.options.length) % props.options.length);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!open()) openMenu();
      setActiveIndex(event.key === 'Home' ? 0 : props.options.length - 1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open()) choose(activeIndex());
      else openMenu();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const start = open()
        ? activeIndex()
        : Math.max(
            0,
            props.options.findIndex((option) => option.value === props.value)
          );
      const index = props.options.findIndex((_, offset) =>
        props.options[(start + offset + 1) % props.options.length]?.label
          .toLocaleLowerCase()
          .startsWith(event.key.toLocaleLowerCase())
      );
      if (index < 0) return;
      event.preventDefault();
      if (!open()) openMenu();
      setActiveIndex((start + index + 1) % props.options.length);
    }
  }

  return (
    <>
      <button
        ref={(el) => {
          trigger = el;
        }}
        type="button"
        role="combobox"
        class="native-form-select-trigger"
        value={props.value}
        aria-label={props.label}
        aria-invalid={ariaBoolean(props.invalid)}
        aria-required={ariaBoolean(props.required)}
        aria-describedby={props.describedBy}
        aria-haspopup="listbox"
        aria-expanded={ariaBoolean(open())}
        aria-controls={listID}
        aria-activedescendant={open() ? `${listID}-${activeIndex()}` : undefined}
        disabled={props.disabled}
        onClick={() => (open() ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
      >
        <span>{selected()?.label ?? 'Unanswered'}</span>
        <UiIcon
          class="native-form-select-chevron"
          source={navArrowDownIcon}
          width={14}
          height={14}
          aria-hidden="true"
        />
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={(el) => {
              menu = el;
            }}
            id={listID}
            role="listbox"
            aria-label={props.label}
            class="native-form-select-options"
            data-popup-position-pending="true"
            onPointerDown={(event) => event.preventDefault()}
          >
            <For each={props.options}>
              {(option, index) => (
                <button
                  type="button"
                  role="option"
                  tabindex={-1}
                  id={`${listID}-${index()}`}
                  data-value={option.value}
                  aria-selected={ariaBoolean(option.value === props.value)}

                  class={['native-form-select-option', { 'is-active': index() === activeIndex() }]}
                  onPointerMove={() => setActiveIndex(index())}
                  onClick={() => choose(index())}
                >
                  <span>{option.label}</span>
                  <Show when={option.description}>
                    <span class="native-form-select-description">{option.description}</span>
                  </Show>
                  <Show when={option.value === props.value}>
                    <UiIcon source={checkIcon} width={13} height={13} aria-hidden="true" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  );
}
