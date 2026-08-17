import { createEffect, For, onCleanup, Show } from 'solid-js';
import type { Agent } from '../../types';
import type {
  AutoApproveActivity,
  PermissionMode,
  WorkspaceFolderContext,
} from '../../../shared/protocol';
import { getProviderIcon } from '../../lib/provider-icons';
import { formatModelName } from '../../lib/format';
import { FolderIcon } from '../FolderIcon';
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

function getAutoApproveActivityTitle(activity: AutoApproveActivity) {
  const label = {
    reviewing: 'Automatic review in progress',
    'auto-approved': 'Auto-approved',
    'approval-required': 'Manual approval requested',
    'auto-review-failed': 'Automatic review did not pass',
    'manually-approved': 'Manually approved',
    'manually-rejected': 'Manually rejected',
  }[activity.status];
  return `${label}: ${activity.title}${activity.detail ? `. ${activity.detail}` : ''}`;
}

export function WorkspacePicker(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  popoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  folders: WorkspaceFolderContext[];
  selectedPath: string | null;
  showPicker: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
}) {
  const selected = () => props.folders.find((folder) => folder.path === props.selectedPath);
  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={props.buttonRef}
        class="toolbar-picker"
        title={selected()?.path ?? 'Select workspace folder'}
        aria-label="Select workspace folder"
        onClick={props.onToggle}
      >
        <FolderIcon width={14} height={14} />
        <span class="toolbar-picker-label">{selected()?.name ?? 'Workspace'}</span>
        <PickerChevron />
      </button>
      <Show when={props.showPicker}>
        <div ref={props.popoverRef} class="toolbar-popover" onClick={(e) => e.stopPropagation()}>
          <div class="toolbar-popover-header">Working directory</div>
          <For each={props.folders}>
            {(folder) => (
              <button
                class={`toolbar-popover-item ${folder.path === props.selectedPath ? 'selected' : ''}`}
                title={folder.path}
                onClick={() => props.onSelect(folder.path)}
              >
                <FolderIcon width={14} height={14} />
                <span class="min-w-0">
                  <span class="block truncate">{folder.name}</span>
                  <span class="block truncate text-[10px] text-vscode-muted">{folder.path}</span>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

export function PermissionModePicker(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  popoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  boundaryRef?: HTMLElement;
  alignTo?: 'left' | 'right';
  mode: PermissionMode;
  activity?: AutoApproveActivity[];
  judgeModel?: { providerName: string; modelName: string } | null;
  showPicker: boolean;
  showLabel?: boolean;
  onToggle: () => void;
  onSelect: (mode: PermissionMode) => void;
}) {
  const options: Array<{ mode: PermissionMode; label: string; detail: string }> = [
    { mode: 'default', label: 'Default', detail: 'Ask before commands and file changes' },
    {
      mode: 'edits',
      label: 'Auto-accept edits',
      detail: 'Auto-approve edits, ask before other actions',
    },
    {
      mode: 'auto',
      label: 'Auto approve',
      detail: 'AI reviewer approves routine actions; risky ones still ask',
    },
    { mode: 'full', label: 'Full access', detail: 'Allow commands and edits without prompts' },
  ];
  const title = () => {
    if (props.mode === 'full') return 'Full access permissions';
    if (props.mode === 'edits') return 'Auto-accept edits permissions';
    if (props.mode === 'auto') {
      const model = props.judgeModel;
      return model
        ? `Auto-approve permissions - ${model.providerName} / ${model.modelName}`
        : 'Auto-approve permissions';
    }
    return 'Default permissions';
  };
  const buttonLabel = () => {
    if (props.mode === 'full') return 'Full access';
    if (props.mode === 'edits') return 'Auto-accept edits';
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
    <div class="permission-mode-picker">
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
      <Show when={props.showLabel && props.mode === 'auto' && props.activity?.length}>
        <span class="permission-activity" aria-label="Auto-approve activity">
          <span class="permission-activity-strip">
            <For each={props.activity?.slice(-13)}>
              {(activity) => (
                <span
                  class={`permission-activity-item ${activity.status}`}
                  title={getAutoApproveActivityTitle(activity)}
                  aria-label={getAutoApproveActivityTitle(activity)}
                >
                  <span class="permission-activity-dot" aria-hidden="true" />
                </span>
              )}
            </For>
          </span>
        </span>
      </Show>
      <Show when={props.showPicker}>
        <div
          ref={setPopoverRef}
          class="toolbar-popover permission-mode-popover"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="toolbar-popover-header">Permissions</div>
          <For each={options}>
            {(option) => (
              <button
                class={`toolbar-popover-item ${props.mode === option.mode ? 'selected' : ''}`}
                onClick={() => props.onSelect(option.mode)}
              >
                <PermissionModeIcon mode={option.mode} />
                <span class="permission-mode-option-copy">
                  <span>
                    {option.label}
                    <Show when={option.mode === 'default'}>
                      <span class="permission-mode-option-note"> (OpenCode config-based)</span>
                    </Show>
                  </span>
                  <span>{option.detail}</span>
                </span>
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
      const trigger = popupEl.parentElement?.querySelector<HTMLElement>('.toolbar-picker');
      const boundary = popupEl.closest<HTMLElement>('.chat-input-container');
      const positionedParent = popupEl.offsetParent;
      if (!trigger || !boundary || !(positionedParent instanceof HTMLElement)) {
        clampPopupToViewport(popupEl);
        return;
      }

      popupEl.style.width = '';
      popupEl.style.left = '0px';
      popupEl.style.right = 'auto';
      popupEl.style.transform = '';
      const viewportMargin = 8;
      const boundaryBox = boundary.getBoundingClientRect();
      const triggerBox = trigger.getBoundingClientRect();
      const parentBox = positionedParent.getBoundingClientRect();
      const boundaryLeft = Math.max(viewportMargin, boundaryBox.left);
      const boundaryRight = Math.min(window.innerWidth - viewportMargin, boundaryBox.right);
      const boundaryWidth = Math.max(0, boundaryRight - boundaryLeft);
      const naturalWidth = Math.min(
        288,
        popupEl.scrollWidth || popupEl.getBoundingClientRect().width
      );
      const maximumWidth = Math.min(naturalWidth, boundaryWidth);
      const triggerLeft = Math.max(boundaryLeft, triggerBox.left);
      const availableRightWidth = boundaryRight - triggerLeft;
      const canRemainRightOpening = availableRightWidth >= Math.min(220, maximumWidth);
      const width = canRemainRightOpening
        ? Math.min(maximumWidth, availableRightWidth)
        : maximumWidth;
      const left = canRemainRightOpening
        ? triggerLeft
        : Math.max(boundaryLeft, Math.min(triggerBox.right - width, boundaryRight - width));
      popupEl.style.width = `${width}px`;
      popupEl.style.left = `${Math.round(left - parentBox.left)}px`;
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
                  <span class="block truncate text-[10px] text-vscode-muted">
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
  onSelect: (variant: string | null) => void;
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
          class="toolbar-popover variant-popover"
          onClick={(e) => e.stopPropagation()}
          style={popoverStyle()}
        >
          <div class="toolbar-popover-header">Reasoning</div>
          <button
            class={`toolbar-popover-item ${props.selectedVariant === null ? 'selected' : ''}`}
            onClick={() => props.onSelect(null)}
          >
            Default
          </button>
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
  return (
    <button
      ref={props.buttonRef}
      class={`toolbar-picker model-picker-btn ${props.canEllipsize ? 'model-ellipsis' : ''}`}
      onClick={props.onToggle}
      title={props.modelName ? `${props.providerName} / ${props.modelName}` : 'Choose model'}
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
          <span class="model-name-text">
            <FormattedModelName name={props.modelName} />
          </span>
        </span>
      </Show>
      <PickerChevron />
    </button>
  );
}

export function FormattedModelName(props: { name: string }) {
  return (
    <For each={formatModelName(props.name).split(/(⚡)/)}>
      {(part) => (part === '⚡' ? <span title="Fast (more expensive)">{part}</span> : part)}
    </For>
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
        on:click={props.onClick}
      >
        <span class="toolbar-limit-chip-label">
          <span class="toolbar-meta-full-label">Limits:</span>
          <span class="toolbar-meta-compact-label" aria-hidden="true">
            L
          </span>
        </span>
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
