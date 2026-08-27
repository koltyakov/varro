import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Agent } from '../../types';
import type {
  AutoApproveActivity,
  PermissionMode,
  WorkspaceFolderContext,
} from '../../../shared/protocol';
import { getProviderIcon } from '../../lib/provider-icons';
import { checkIcon, navArrowDownIcon } from '../../lib/ui-icons';
import { formatModelName } from '../../lib/format';
import { FolderIcon } from '../FolderIcon';
import { Tooltip } from '../Tooltip';
import { toCssUrl, UiIcon } from '../UiIcon';
import {
  alignPopupToBoundary,
  clampPopupToViewport,
  flipPopupDownIfNeeded,
  observePopupViewport,
} from '../../lib/popup-position';
import { PermissionModeIcon } from './PermissionModeIcon';
import { isFunction } from '../../lib/runtime-values';

const FAST_MODE_COST_WARNING = 'Fast mode may consume usage limits faster and cost more.';

function isFastModelName(name: string) {
  return formatModelName(name).includes('⚡');
}

function PickerChevron() {
  return <UiIcon source={navArrowDownIcon} class="codicon-chevron" width={10} height={10} />;
}

const selectedIconStyle = { '--toolbar-selected-icon': toCssUrl(checkIcon) };

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

const WORKSPACE_NAME_WORD_PATTERN = /[A-Z]+(?=[A-Z][a-z]|[^A-Za-z0-9]|$)|[A-Z]?[a-z]+|[0-9]+/g;

function getWorkspaceNameParts(name: string) {
  const parts: Array<{ text: string; initial: boolean }> = [];
  let offset = 0;
  for (const match of name.matchAll(WORKSPACE_NAME_WORD_PATTERN)) {
    const index = match.index;
    if (index > offset) parts.push({ text: name.slice(offset, index), initial: false });
    parts.push({ text: match[0].slice(0, 1), initial: true });
    if (match[0].length > 1) parts.push({ text: match[0].slice(1), initial: false });
    offset = index + match[0].length;
  }
  if (offset < name.length) parts.push({ text: name.slice(offset), initial: false });
  return parts;
}

function formatWorkspaceAbbreviation(name: string) {
  const initials = getWorkspaceNameParts(name)
    .filter((part) => part.initial)
    .map((part) => part.text)
    .join('');
  return initials.toLowerCase() || name.slice(0, 1).toLowerCase();
}

function bindOverflowTitle(element: HTMLElement, text: string) {
  const update = () => {
    if (element.scrollWidth > element.clientWidth + 1) element.title = text;
    else element.removeAttribute('title');
  };
  queueMicrotask(update);
  window.addEventListener('resize', update);
  const observer =
    globalThis.ResizeObserver === undefined ? null : new ResizeObserver(() => update());
  observer?.observe(element);
  onCleanup(() => {
    window.removeEventListener('resize', update);
    observer?.disconnect();
  });
}

export function WorkspacePicker(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  popoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  boundaryRef?: HTMLElement;
  alignTo?: 'left' | 'right';
  folders: WorkspaceFolderContext[];
  selectedPath: string | null;
  canSelect?: boolean;
  showIcon?: boolean;
  showPicker: boolean;
  onToggle: () => void;
  onSelect: (path: string) => void;
}) {
  const selected = () => props.folders.find((folder) => folder.path === props.selectedPath);
  const selectedAbbreviation = () => {
    const folder = selected();
    if (!folder) return formatWorkspaceAbbreviation('Workspace');
    const abbreviation = formatWorkspaceAbbreviation(folder.name);
    const matches = props.folders.filter(
      (candidate) => formatWorkspaceAbbreviation(candidate.name) === abbreviation
    );
    if (matches.length < 2) return abbreviation;
    return `${abbreviation}${matches.findIndex((candidate) => candidate.path === folder.path) + 1}`;
  };
  const selectedAriaLabel = () => {
    const folder = selected();
    return folder
      ? `Selected workspace: ${folder.name}, ${selectedAbbreviation()}`
      : 'Select workspace folder';
  };
  let popupEl: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.showPicker || !popupEl) return;

    const reposition = () => {
      if (!popupEl) return;
      flipPopupDownIfNeeded(popupEl);
      if (props.boundaryRef) {
        const viewportMargin = 8;
        const boundaryBox = props.boundaryRef.getBoundingClientRect();
        const boundaryLeft = Math.max(viewportMargin, boundaryBox.left);
        const boundaryRight = Math.min(window.innerWidth - viewportMargin, boundaryBox.right);
        popupEl.style.width = `${Math.min(360, Math.max(0, boundaryRight - boundaryLeft))}px`;
        alignPopupToBoundary(popupEl, props.boundaryRef, props.alignTo ?? 'left');
      }
      clampPopupToViewport(popupEl);
    };

    onCleanup(observePopupViewport(popupEl, reposition));
  });

  const setPopoverRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.popoverRef;
    if (isFunction(forwarded)) forwarded(el);
  };

  return (
    <div class="workspace-picker" style={{ position: 'relative' }}>
      <Tooltip content={selected()?.path ?? 'Select workspace folder'}>
        <button
          ref={props.buttonRef}
          class="toolbar-picker workspace-picker-button"
          aria-label={selectedAriaLabel()}
          aria-expanded={props.showPicker}
          onClick={props.onToggle}
        >
          <Show when={props.showIcon !== false}>
            <FolderIcon class="workspace-picker-folder-icon" width={14} height={14} />
          </Show>
          <span class="toolbar-picker-label workspace-picker-full-label">
            {selected()?.name ?? 'Workspace'}
          </span>
          <span class="toolbar-picker-label workspace-picker-abbreviation" aria-hidden="true">
            {selectedAbbreviation()}
          </span>
          <PickerChevron />
        </button>
      </Tooltip>
      <Show when={props.showPicker}>
        <div
          ref={setPopoverRef}
          class="toolbar-popover workspace-popover"
          style={selectedIconStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="toolbar-popover-header">Working directory</div>
          <Show when={props.canSelect === false}>
            <div class="workspace-popover-notice">
              Workspace can't be changed in an active chat.
            </div>
          </Show>
          <For each={props.folders}>
            {(folder) => (
              <button
                class={`toolbar-popover-item ${folder.path === props.selectedPath ? 'selected' : ''}`}
                data-workspace-path={folder.path}
                aria-current={folder.path === props.selectedPath ? 'true' : undefined}
                disabled={props.canSelect === false}
                onClick={() => props.onSelect(folder.path)}
              >
                <FolderIcon width={14} height={14} />
                <span class="min-w-0">
                  <span class="workspace-popover-name block truncate">
                    <For each={getWorkspaceNameParts(folder.name)}>
                      {(part) => (
                        <span
                          class={
                            part.initial && folder.path === props.selectedPath
                              ? 'workspace-name-initial'
                              : undefined
                          }
                        >
                          {part.text}
                        </span>
                      )}
                    </For>
                  </span>
                  <span
                    ref={(element) => bindOverflowTitle(element, folder.path)}
                    class="workspace-popover-path block truncate text-[10px] text-vscode-muted"
                  >
                    {folder.path}
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

export function PermissionModePicker(props: {
  buttonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  popoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  boundaryRef?: HTMLElement;
  alignTo?: 'left' | 'right';
  alignToTriggerWhenPossible?: boolean;
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
  const tooltipContent = () => {
    const option = options.find((candidate) => candidate.mode === props.mode)!;
    const configNote =
      props.mode === 'default' ? ' Uses your OpenCode permission configuration.' : '';
    const reviewer =
      props.mode === 'auto' && props.judgeModel
        ? ` Reviewer: ${props.judgeModel.providerName} / ${props.judgeModel.modelName}.`
        : '';
    return `${option.label}: ${option.detail}.${configNote}${reviewer}`;
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
        popupEl.style.width = '';
        const viewportMargin = 8;
        const boundaryBox = props.boundaryRef.getBoundingClientRect();
        const boundaryLeft = Math.max(viewportMargin, boundaryBox.left);
        const boundaryRight = Math.min(window.innerWidth - viewportMargin, boundaryBox.right);
        const boundaryWidth = Math.max(0, boundaryRight - boundaryLeft);
        const naturalWidth = Math.min(
          288,
          popupEl.scrollWidth || popupEl.getBoundingClientRect().width
        );
        const popupWidth = Math.min(naturalWidth, boundaryWidth);
        popupEl.style.width = `${popupWidth}px`;
        const positionedAncestor =
          popupEl.offsetParent instanceof HTMLElement
            ? popupEl.offsetParent
            : popupEl.parentElement;
        const ancestorBox = positionedAncestor?.getBoundingClientRect();
        const fitsAtTrigger =
          props.alignToTriggerWhenPossible &&
          ancestorBox &&
          ancestorBox.left >= boundaryLeft &&
          ancestorBox.left + popupWidth <= boundaryRight;
        if (fitsAtTrigger) {
          popupEl.style.right = 'auto';
          popupEl.style.left = '0px';
        } else if (props.alignToTriggerWhenPossible && ancestorBox) {
          popupEl.style.right = 'auto';
          popupEl.style.left = `${Math.round(boundaryLeft + (boundaryWidth - popupWidth) / 2 - ancestorBox.left)}px`;
        } else {
          alignPopupToBoundary(popupEl, props.boundaryRef, props.alignTo ?? 'left');
        }
      }
      clampPopupToViewport(popupEl);
    };

    onCleanup(observePopupViewport(popupEl, reposition));
  });

  const setPopoverRef = (el: HTMLDivElement) => {
    popupEl = el;
    const forwarded = props.popoverRef;
    if (isFunction(forwarded)) forwarded(el);
  };

  return (
    <div class="permission-mode-picker">
      <Tooltip content={tooltipContent()} disabled={props.showPicker}>
        <button
          ref={props.buttonRef}
          class={`toolbar-picker permission-mode-button ${props.showLabel ? '' : 'icon-only'}`}
          data-permission-mode={props.mode}
          onClick={props.onToggle}
          aria-label={title()}
          aria-expanded={props.showPicker}
        >
          <PermissionModeIcon mode={props.mode} />
          <Show when={props.showLabel}>
            <span class="toolbar-picker-label">{buttonLabel()}</span>
            <PickerChevron />
          </Show>
        </button>
      </Tooltip>
      <Show when={props.showLabel && props.mode === 'auto' && props.activity?.length}>
        <span class="permission-activity" aria-label="Auto-approve activity">
          <span class="permission-activity-strip">
            <For each={props.activity?.slice(-8)}>
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
          style={selectedIconStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="toolbar-popover-header">Permissions</div>
          <For each={options}>
            {(option) => (
              <button
                class={`toolbar-popover-item ${props.mode === option.mode ? 'selected' : ''}`}
                data-permission-mode-option={option.mode}
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
  const [optionDetails, setOptionDetails] = createSignal<{
    detail: string;
    style: Record<string, string>;
  } | null>(null);
  const selectedAgent = () => props.agents.find((agent) => agent.name === props.selectedAgent);
  const tooltipContent = () => {
    const agent = selectedAgent();
    if (!agent) return 'Select agent';
    return (
      <span class="agent-picker-tooltip">
        <span class="agent-picker-tooltip-title">{props.selectedLabel}</span>
        <span class="agent-picker-tooltip-detail">{props.getDetail(agent)}</span>
      </span>
    );
  };

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
    if (isFunction(forwarded)) forwarded(el);
  };

  const showOptionDetails = (detail: string, option: HTMLElement) => {
    if (!popupEl) return;
    const gap = 7;
    const viewportMargin = 8;
    const panelWidth = 220;
    const popupBox = popupEl.getBoundingClientRect();
    const optionBox = option.getBoundingClientRect();
    let left: number;
    let top: number;
    let width = panelWidth;

    if (popupBox.right + gap + panelWidth <= window.innerWidth - viewportMargin) {
      left = popupBox.right + gap;
      top = Math.min(optionBox.top, window.innerHeight - viewportMargin - 100);
    } else if (popupBox.left - gap - panelWidth >= viewportMargin) {
      left = popupBox.left - gap - panelWidth;
      top = Math.min(optionBox.top, window.innerHeight - viewportMargin - 100);
    } else {
      left = Math.max(viewportMargin, popupBox.left);
      width = Math.max(0, Math.min(popupBox.width, window.innerWidth - left - viewportMargin));
      setOptionDetails({
        detail,
        style: {
          bottom: `${Math.round(window.innerHeight - popupBox.top + gap)}px`,
          left: `${Math.round(left)}px`,
          width: `${Math.round(width)}px`,
        },
      });
      return;
    }

    setOptionDetails({
      detail,
      style: {
        left: `${Math.round(left)}px`,
        top: `${Math.round(Math.max(viewportMargin, top))}px`,
        width: `${Math.round(width)}px`,
      },
    });
  };

  return (
    <div style={{ position: 'relative' }}>
      <Tooltip content={tooltipContent()}>
        <button
          ref={props.buttonRef}
          class={`toolbar-picker ${props.selectedAgent === 'plan' ? 'plan-agent-selected' : ''}`}
          onClick={props.onToggle}
          aria-label="Select agent"
          aria-expanded={props.showPicker}
        >
          <span class="toolbar-picker-label">{props.selectedLabel}</span>
          <PickerChevron />
        </button>
      </Tooltip>
      <Show when={props.showPicker}>
        <div
          ref={setPopoverRef}
          class="toolbar-popover agent-popover"
          style={selectedIconStyle}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="toolbar-popover-header">Agent</div>
          <For each={props.agents}>
            {(agent, index) => (
              <AgentPickerOption
                label={props.getLabel(agent)}
                detail={props.getDetail(agent)}
                selected={props.selectedAgent === agent.name}
                focused={props.focusIndex === index()}
                onSelect={() => props.onSelect(agent)}
                onFocus={() => props.onFocusIndex(index())}
                onShowDetails={showOptionDetails}
                onHideDetails={() => setOptionDetails(null)}
              />
            )}
          </For>
        </div>
      </Show>
      <Show when={props.showPicker && optionDetails()}>
        {(details) => (
          <Portal>
            <div
              class="model-picker-details agent-picker-details"
              style={details().style}
              aria-live="polite"
            >
              <div class="agent-picker-details-description">{details().detail}</div>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}

function AgentPickerOption(props: {
  label: string;
  detail: string;
  selected: boolean;
  focused: boolean;
  onSelect: () => void;
  onFocus: () => void;
  onShowDetails: (detail: string, option: HTMLElement) => void;
  onHideDetails: () => void;
}) {
  let detailElement: HTMLSpanElement | undefined;
  const updateDetails = (option: HTMLElement) => {
    if (detailElement && detailElement.scrollWidth > detailElement.clientWidth) {
      props.onShowDetails(props.detail, option);
    } else {
      props.onHideDetails();
    }
  };

  return (
    <button
      class={`toolbar-popover-item ${props.selected ? 'selected' : ''} ${props.focused ? 'keyboard-focus' : ''}`}
      onClick={props.onSelect}
      onMouseEnter={(event) => {
        updateDetails(event.currentTarget);
        props.onFocus();
      }}
      onMouseLeave={props.onHideDetails}
      onFocus={(event) => updateDetails(event.currentTarget)}
      onBlur={props.onHideDetails}
    >
      <span class="min-w-0">
        <span class="block truncate">{props.label}</span>
        <span
          ref={(element) => (detailElement = element)}
          class="block truncate text-[10px] font-normal text-vscode-muted"
        >
          {props.detail}
        </span>
      </span>
    </button>
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
  const isMaximumReasoning = () => {
    const variant = props.selectedVariant?.trim().toLowerCase();
    return variant === 'max' || variant === 'ultra';
  };

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
    if (isFunction(forwarded)) forwarded(el);
  };

  const popoverStyle = () =>
    props.popupGap === undefined ? undefined : { 'margin-bottom': `${props.popupGap}px` };

  return (
    <div style={{ position: 'relative' }}>
      <Tooltip
        content={
          isMaximumReasoning() ? 'Maximum reasoning may be more expensive.' : 'Thinking level'
        }
      >
        <button
          ref={props.buttonRef}
          class={`toolbar-picker ${isMaximumReasoning() ? 'maximum-reasoning-selected' : ''}`}
          onClick={props.onToggle}
          aria-label="Thinking level"
          aria-expanded={props.showPicker}
        >
          <span class="toolbar-picker-label">{props.selectedLabel}</span>
          <PickerChevron />
        </button>
      </Tooltip>
      <Show when={props.showPicker}>
        <div
          ref={setPopoverRef}
          class="toolbar-popover variant-popover"
          onClick={(e) => e.stopPropagation()}
          style={{ ...popoverStyle(), ...selectedIconStyle }}
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
  modelID?: string | null;
  providerName: string;
  modelName: string;
  canEllipsize: boolean;
  expanded?: boolean;
  onToggle: () => void;
}) {
  const label = () =>
    props.modelName ? `${props.providerName} / ${props.modelName}` : 'Choose model';
  const isFastModel = () => isFastModelName(props.modelName);
  const tooltipContent = () =>
    isFastModel() ? (
      <span class="model-picker-tooltip">
        <span>{label()}</span>
        <span class="model-picker-tooltip-detail">{FAST_MODE_COST_WARNING}</span>
      </span>
    ) : (
      label()
    );

  return (
    <Tooltip content={tooltipContent()}>
      <button
        ref={props.buttonRef}
        class={`toolbar-picker model-picker-btn ${props.canEllipsize ? 'model-ellipsis' : ''} ${isFastModel() ? 'fast-model-selected' : ''}`}
        data-provider-id={props.providerID ?? undefined}
        data-model-id={props.modelID ?? undefined}
        onClick={props.onToggle}
        aria-label={label()}
        aria-expanded={props.expanded ?? false}
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
              <FormattedModelName name={props.modelName} showFastTooltip={false} />
            </span>
          </span>
        </Show>
        <PickerChevron />
      </button>
    </Tooltip>
  );
}

export function FormattedModelName(props: { name: string; showFastTooltip?: boolean }) {
  return (
    <For each={formatModelName(props.name).split(/(⚡)/)}>
      {(part) =>
        part === '⚡' ? (
          <Show
            when={props.showFastTooltip !== false}
            fallback={<span aria-label={FAST_MODE_COST_WARNING}>{part}</span>}
          >
            <Tooltip content={FAST_MODE_COST_WARNING} delay={300}>
              <span aria-label={FAST_MODE_COST_WARNING}>{part}</span>
            </Tooltip>
          </Show>
        ) : (
          part
        )
      }
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
      <Tooltip
        content={props.title ?? props.ariaLabel ?? 'Provider limits'}
        disabled={!props.title}
      >
        <button
          ref={props.buttonRef}
          type="button"
          class="toolbar-limit-chip"
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
      </Tooltip>
    </Show>
  );
}
