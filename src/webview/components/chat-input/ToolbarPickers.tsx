import { createEffect, For, onCleanup, Show } from 'solid-js';
import type { Agent } from '../../types';
import type { PermissionMode } from '../../../shared/protocol';
import { getProviderIcon } from '../../lib/provider-icons';
import { formatModelName } from '../../lib/format';
import {
  alignPopupToBoundary,
  clampPopupToViewport,
  flipPopupDownIfNeeded,
  observePopupViewport,
} from '../../lib/popup-position';
import { PermissionModeIcon } from './PermissionModeIcon';

function PickerChevron() {
  return (
    <svg
      class="codicon-chevron"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

export function PermissionModePicker(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  popoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  boundaryRef?: HTMLElement;
  alignTo?: 'left' | 'right';
  mode: PermissionMode;
  showPicker: boolean;
  showLabel?: boolean;
  onToggle: () => void;
  onSelect: (mode: PermissionMode) => void;
}) {
  const options: Array<{ mode: PermissionMode; label: string }> = [
    { mode: 'default', label: 'Default' },
    { mode: 'auto', label: 'Auto approve' },
    { mode: 'full', label: 'Full access' },
  ];
  const title = () => {
    if (props.mode === 'full') return 'Full access permissions';
    if (props.mode === 'auto') return 'Auto-approve permissions';
    return 'Default permissions';
  };
  const buttonLabel = () => {
    if (props.mode === 'full') return 'Full access';
    if (props.mode === 'auto') return 'Auto approve';
    return 'Default';
  };
  let popupEl: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.showPicker || !popupEl) return;

    const reposition = () => {
      if (!popupEl) return;
      flipPopupDownIfNeeded(popupEl);
      if (props.boundaryRef) {
        alignPopupToBoundary(popupEl, props.boundaryRef, props.alignTo ?? 'left');
      }
      clampPopupToViewport(popupEl);
    };

    onCleanup(observePopupViewport(popupEl, reposition));
  });

  const setPopoverRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.popoverRef;
    if (typeof forwarded === 'function') forwarded(el);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={props.buttonRef}
        class={`toolbar-picker permission-mode-button ${props.showLabel ? '' : 'icon-only'}`}
        onClick={props.onToggle}
        title={title()}
        aria-label={title()}
      >
        <PermissionModeIcon mode={props.mode} />
        <Show when={props.showLabel}>
          <span class="toolbar-picker-label">{buttonLabel()}</span>
          <PickerChevron />
        </Show>
      </button>
      <Show when={props.showPicker}>
        <div ref={setPopoverRef} class="toolbar-popover" onClick={(e) => e.stopPropagation()}>
          <div class="toolbar-popover-header">Permissions</div>
          <For each={options}>
            {(option) => (
              <button
                class={`toolbar-popover-item ${props.mode === option.mode ? 'selected' : ''}`}
                onClick={() => props.onSelect(option.mode)}
              >
                <PermissionModeIcon mode={option.mode} />
                <span class="min-w-0">{option.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function AgentPicker(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  popoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  agents: Agent[];
  selectedAgent: string | null;
  selectedLabel: string;
  focusIndex: number;
  showPicker: boolean;
  getLabel: (agent: Agent) => string;
  getDetail: (agent: Agent) => string;
  onToggle: () => void;
  onSelect: (agent: Agent) => void;
  onFocusIndex: (index: number) => void;
}) {
  let popupEl: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.showPicker || !popupEl) return;

    const reposition = () => {
      if (!popupEl) return;
      flipPopupDownIfNeeded(popupEl);
      clampPopupToViewport(popupEl);
    };

    onCleanup(observePopupViewport(popupEl, reposition));
  });

  const setPopoverRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.popoverRef;
    if (typeof forwarded === 'function') forwarded(el);
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={props.buttonRef}
        class="toolbar-picker"
        onClick={props.onToggle}
        title="Select agent"
      >
        <span class="toolbar-picker-label">{props.selectedLabel}</span>
        <PickerChevron />
      </button>
      <Show when={props.showPicker}>
        <div
          ref={setPopoverRef}
          class="toolbar-popover agent-popover"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="toolbar-popover-header">Agent</div>
          <For each={props.agents}>
            {(agent, index) => (
              <button
                class={`toolbar-popover-item ${props.selectedAgent === agent.name ? 'selected' : ''} ${props.focusIndex === index() ? 'keyboard-focus' : ''}`}
                onClick={() => props.onSelect(agent)}
                onMouseEnter={() => props.onFocusIndex(index())}
              >
                <span class="min-w-0">
                  <span class="block truncate">{props.getLabel(agent)}</span>
                  <span class="block truncate text-[10px] text-vscode-muted/80">
                    {props.getDetail(agent)}
                  </span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function VariantPicker(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  popoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  boundaryRef?: HTMLElement;
  alignTo?: 'left' | 'right';
  popupGap?: number;
  variants: string[];
  selectedVariant: string | null;
  selectedLabel: string;
  showPicker: boolean;
  getLabel: (variant: string) => string;
  onToggle: () => void;
  onSelect: (variant: string) => void;
}) {
  let popupEl: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.showPicker || !popupEl) return;

    const reposition = () => {
      if (!popupEl) return;
      flipPopupDownIfNeeded(popupEl);
      if (props.boundaryRef) {
        alignPopupToBoundary(popupEl, props.boundaryRef, props.alignTo ?? 'left');
      }
      clampPopupToViewport(popupEl);
    };

    onCleanup(observePopupViewport(popupEl, reposition));
  });

  const setPopoverRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.popoverRef;
    if (typeof forwarded === 'function') forwarded(el);
  };

  const popoverStyle = () =>
    props.popupGap === undefined ? undefined : { 'margin-bottom': `${props.popupGap}px` };

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={props.buttonRef}
        class="toolbar-picker"
        onClick={props.onToggle}
        title="Thinking level"
      >
        <span class="toolbar-picker-label">{props.selectedLabel}</span>
        <PickerChevron />
      </button>
      <Show when={props.showPicker}>
        <div
          ref={setPopoverRef}
          class="toolbar-popover"
          onClick={(e) => e.stopPropagation()}
          style={popoverStyle()}
        >
          <div class="toolbar-popover-header">Reasoning</div>
          <For each={props.variants}>
            {(variant) => (
              <button
                class={`toolbar-popover-item ${props.selectedVariant === variant ? 'selected' : ''}`}
                onClick={() => props.onSelect(variant)}
              >
                {props.getLabel(variant)}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function ModelPickerButton(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  providerID: string | null;
  providerName: string;
  modelName: string;
  canEllipsize: boolean;
  onToggle: () => void;
}) {
  const displayModelName = () => formatModelName(props.modelName);

  return (
    <button
      ref={props.buttonRef}
      class={`toolbar-picker model-picker-btn ${props.canEllipsize ? 'model-ellipsis' : ''}`}
      onClick={props.onToggle}
      title={props.modelName ? `${props.providerName} / ${displayModelName()}` : 'Choose model'}
    >
      <Show
        when={props.modelName}
        fallback={<span class="toolbar-picker-label model-name">Model</span>}
      >
        <span class="toolbar-picker-label model-name">
          <Show when={getProviderIcon(props.providerID)}>
            {(icon) => (
              <span
                class="provider-icon"
                style={{ '--provider-icon-mask': `url("${icon()}")` }}
                aria-hidden="true"
              />
            )}
          </Show>
          <span class="model-name-text">{displayModelName()}</span>
        </span>
      </Show>
      <PickerChevron />
    </button>
  );
}

export function ProviderLimitChip(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  badges: Array<{ label: string; tone: string }>;
  title: string | null;
  ariaLabel?: string | null;
  onClick: () => void;
}) {
  return (
    <Show when={props.badges.length > 0}>
      <button
        ref={props.buttonRef}
        type="button"
        class="toolbar-limit-chip"
        title={props.title ?? undefined}
        aria-label={props.ariaLabel ?? props.title ?? 'Provider limits'}
        onClick={props.onClick}
      >
        <span class="toolbar-limit-chip-label">Limits:</span>
        <For each={props.badges}>
          {(badge, index) => (
            <>
              <Show when={index() > 0}>
                <span class="toolbar-limit-chip-separator">&middot;</span>
              </Show>
              <span
                class={`toolbar-limit-chip-badge ${badge.tone !== 'default' ? badge.tone : ''}`}
              >
                <span class="toolbar-limit-chip-badge-value">{badge.label}</span>
              </span>
            </>
          )}
        </For>
      </button>
    </Show>
  );
}
