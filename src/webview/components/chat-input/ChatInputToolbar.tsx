import { Show } from 'solid-js';
import type { Agent } from '../../types';
import type { PermissionMode, ProviderLimitStatus } from '../../../shared/protocol';
import { AttachButton } from './AttachButton';
import { BusySendMenu } from './BusySendMenu';
import { ContextPopup, ContextUsageButton, formatContextUsageTitle } from './ContextPopup';
import { ProviderLimitPopup } from './ProviderLimitPopup';
import { SendControls } from './SendControls';
import { StopButton } from './StopButton';
import {
  AgentPicker,
  ModelPickerButton,
  PermissionModePicker,
  ProviderLimitChip,
  VariantPicker,
} from './ToolbarPickers';

type CurrentModelInfo = {
  providerID: string | null;
  modelID: string | null;
  variant: string | null;
  providerName: string;
  modelName: string;
  contextLimit: number | null;
};

type ContextUsageInfo = {
  used: number;
  limit: number;
  percent: number;
};

type SessionTokensInfo = {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

type ToolbarSharedProps = {
  compactTight: boolean;
  inputFrameRef?: HTMLElement;
  showPermissionControl: boolean;
  permissionButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  permissionPopoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  permissionMode: PermissionMode;
  showPermissionPicker: boolean;
  onTogglePermissionPicker: () => void;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  agents: Agent[];
  selectedAgent: string | null;
  selectedAgentLabel: string;
  agentFocusIndex: number;
  showAgentPicker: boolean;
  showAgentControl: boolean;
  agentButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  agentPopoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  getAgentLabel: (agent: Agent) => string;
  getAgentDetail: (agent: Agent) => string;
  onToggleAgentPicker: () => void;
  onSelectAgent: (agent: Agent) => void;
  onAgentFocusIndex: (index: number) => void;
  modelButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  currentModel: CurrentModelInfo;
  modelCanEllipsize: boolean;
  onToggleModelPicker: () => void;
  providerLimitBadges: Array<{ label: string; tone: string }>;
  providerLimitTitle: string | null;
  providerLimit: ProviderLimitStatus | null;
  showProviderLimitPopup: boolean;
  providerLimitButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  providerLimitPopupRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  onToggleProviderLimitPopup: () => void;
  onCloseProviderLimitPopup: () => void;
  availableVariants: string[];
  selectedVariant: string | null;
  selectedVariantLabel: string;
  showVariantPicker: boolean;
  showReasoningControl: boolean;
  variantButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  variantPopoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  getVariantLabel: (variant: string) => string;
  onToggleVariantPicker: () => void;
  onSelectVariant: (variant: string) => void;
  contextUsage: ContextUsageInfo | null;
  showContextControl: boolean;
  contextButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  contextPopupRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  showContextPopup: boolean;
  sessionTokens: SessionTokensInfo;
  contextCompactDisabled: boolean;
  onToggleContextPopup: () => void;
  onCloseContextPopup: () => void;
  onCompactSession: () => void;
  showAttachmentsControl: boolean;
  onAttach: () => void;
  showStopButton: boolean;
  onStop: () => void;
  showSendControl: boolean;
  showBusySendControls: boolean;
  canSend: boolean;
  busyToggleRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  showBusyMenu: boolean;
  onSend: () => void;
  onToggleBusyMenu: () => void;
  busyMenuRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  onQueue: () => void;
  onSteer: () => void;
  onStopAndSend: () => void;
};

type ChatInputMainToolbarProps = ToolbarSharedProps & {
  toolbarRef: (el: HTMLDivElement) => void;
  toolbarLeftRef: (el: HTMLDivElement) => void;
  toolbarRightRef: (el: HTMLDivElement) => void;
  showLeftPopupState: boolean;
};

export function ChatInputMainToolbar(props: ChatInputMainToolbarProps) {
  return (
    <div
      ref={props.toolbarRef}
      class={`chat-input-toolbars toolbar-main ${props.compactTight ? 'compact-tight' : ''}`}
    >
      <div
        ref={props.toolbarLeftRef}
        class={`toolbar-left${props.showLeftPopupState ? ' showing-context-popup' : ''}`}
      >
        <Show when={props.agents.length > 0 && props.showAgentControl}>
          <AgentPicker
            buttonRef={props.agentButtonRef}
            popoverRef={props.agentPopoverRef}
            agents={props.agents}
            selectedAgent={props.selectedAgent}
            selectedLabel={props.selectedAgentLabel}
            focusIndex={props.agentFocusIndex}
            showPicker={props.showAgentPicker}
            getLabel={props.getAgentLabel}
            getDetail={props.getAgentDetail}
            onToggle={props.onToggleAgentPicker}
            onSelect={props.onSelectAgent}
            onFocusIndex={props.onAgentFocusIndex}
          />
        </Show>

        <ModelPickerButton
          buttonRef={props.modelButtonRef}
          providerID={props.currentModel.providerID}
          providerName={props.currentModel.providerName}
          modelName={props.currentModel.modelName}
          canEllipsize={props.modelCanEllipsize}
          onToggle={props.onToggleModelPicker}
        />

        <Show when={props.availableVariants.length > 0 && props.showReasoningControl}>
          <VariantPicker
            buttonRef={props.variantButtonRef}
            popoverRef={props.variantPopoverRef}
            variants={props.availableVariants}
            selectedVariant={props.selectedVariant}
            selectedLabel={props.selectedVariantLabel}
            showPicker={props.showVariantPicker}
            getLabel={props.getVariantLabel}
            onToggle={props.onToggleVariantPicker}
            onSelect={props.onSelectVariant}
          />
        </Show>
      </div>

      <div ref={props.toolbarRightRef} class="toolbar-right">
        <Show when={props.showAttachmentsControl}>
          <AttachButton onAttach={props.onAttach} />
        </Show>

        <Show when={props.showStopButton}>
          <StopButton onStop={props.onStop} />
        </Show>

        <Show when={props.showSendControl}>
          <div style={{ position: 'relative' }}>
            <SendControls
              showBusyControls={props.showBusySendControls}
              canSend={props.canSend}
              busyToggleRef={props.busyToggleRef}
              onSend={props.onSend}
              onToggleBusyMenu={props.onToggleBusyMenu}
            />

            <Show when={props.showBusyMenu && props.showBusySendControls}>
              <BusySendMenu
                ref={props.busyMenuRef}
                onQueue={props.onQueue}
                onSteer={props.onSteer}
                onStopAndSend={props.onStopAndSend}
              />
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}

export function ChatInputMetaToolbar(props: ToolbarSharedProps) {
  const hasContextControl = () => props.showContextControl && !!props.contextUsage;
  const showMetaRow = () =>
    props.showPermissionControl || hasContextControl() || props.providerLimitBadges.length > 0;

  return (
    <Show when={showMetaRow()}>
      <div class={`chat-input-toolbars toolbar-meta ${props.compactTight ? 'compact-tight' : ''}`}>
        <div class="toolbar-meta-left">
          <Show when={props.showPermissionControl}>
            <PermissionModePicker
              buttonRef={props.permissionButtonRef}
              popoverRef={props.permissionPopoverRef}
              boundaryRef={props.inputFrameRef}
              alignTo="left"
              mode={props.permissionMode}
              showPicker={props.showPermissionPicker}
              showLabel={true}
              onToggle={props.onTogglePermissionPicker}
              onSelect={props.onSelectPermissionMode}
            />
          </Show>
        </div>

        <div class="toolbar-meta-right">
          <Show when={props.providerLimitBadges.length > 0}>
            <div class="provider-limit-anchor" style={{ position: 'relative' }}>
              <ProviderLimitChip
                buttonRef={props.providerLimitButtonRef}
                badges={props.providerLimitBadges}
                title={props.showProviderLimitPopup ? null : props.providerLimitTitle}
                ariaLabel={props.providerLimitTitle}
                onClick={props.onToggleProviderLimitPopup}
              />
              <Show when={props.showProviderLimitPopup}>
                <ProviderLimitPopup
                  ref={props.providerLimitPopupRef}
                  boundaryRef={props.inputFrameRef}
                  alignTo="right"
                  limit={props.providerLimit}
                  model={{
                    providerName: props.currentModel.providerName,
                    modelName: props.currentModel.modelName,
                  }}
                  onClose={props.onCloseProviderLimitPopup}
                />
              </Show>
            </div>
          </Show>

          <Show when={props.showContextControl && props.contextUsage}>
            {(contextUsage) => (
              <div class="context-anchor" style={{ position: 'relative' }}>
                <ContextUsageButton
                  ref={props.contextButtonRef}
                  percent={contextUsage().percent}
                  title={
                    props.showContextPopup
                      ? undefined
                      : formatContextUsageTitle(contextUsage().percent)
                  }
                  onClick={props.onToggleContextPopup}
                />
                <Show when={props.showContextPopup}>
                  <ContextPopup
                    ref={props.contextPopupRef}
                    boundaryRef={props.inputFrameRef}
                    alignTo="right"
                    usage={contextUsage()}
                    tokens={props.sessionTokens}
                    model={props.currentModel}
                    compactDisabled={props.contextCompactDisabled}
                    onClose={props.onCloseContextPopup}
                    onCompact={props.onCompactSession}
                  />
                </Show>
              </div>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}
