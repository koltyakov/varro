import { Show } from 'solid-js';
import type { Agent } from '../../types';
import type { ContextBreakdownSegment } from '../../../shared/context-breakdown';
import type {
  AutoApproveActivity,
  PermissionMode,
  ProviderLimitStatus,
  WorkspaceFolderContext,
} from '../../../shared/protocol';
import { Tooltip } from '../Tooltip';
import { AttachButton } from './AttachButton';
import { BusyIndicator } from './BusyIndicator';
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
  WorkspacePicker,
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
  autoPermissionActivity?: AutoApproveActivity[];
  autoApproveJudgeModel?: { providerName: string; modelName: string } | null;
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
  showBusyIndicator: boolean;
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
  onSelectVariant: (variant: string | null) => void;
  contextUsage: ContextUsageInfo | null;
  contextBreakdown: ContextBreakdownSegment[];
  nestedContextBreakdown: ContextBreakdownSegment[];
  showContextControl: boolean;
  contextButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  contextPopupRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  showContextPopup: boolean;
  sessionTokens: SessionTokensInfo;
  sessionCost: number | null;
  subagentTokens: SessionTokensInfo;
  subagentCount: number;
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
  showBusySendOptions: boolean;
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
  workspaceFolders: WorkspaceFolderContext[];
  selectedWorkspacePath: string | null;
  showWorkspacePicker: boolean;
  showModelPicker: boolean;
  selectionCostWarning: {
    providerName: string;
    modelName: string;
    reasoningLabel: string;
  } | null;
  workspaceButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  workspacePopoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  onToggleWorkspacePicker: () => void;
  onSelectWorkspace: (path: string) => void;
};

const SELECTION_COST_WARNING =
  'Switching the model or reasoning level mid-session may make this request more expensive.';

function SelectionCostWarning(props: {
  providerName: string;
  modelName: string;
  reasoningLabel: string;
}) {
  const detail = `Current session: ${props.providerName} / ${props.modelName} · ${props.reasoningLabel}`;
  return (
    <Tooltip
      content={
        <span class="model-selection-cost-tooltip">
          <span>{SELECTION_COST_WARNING}</span>
          <span class="model-selection-cost-tooltip-detail">{detail}</span>
        </span>
      }
    >
      <span
        class="model-selection-cost-warning"
        role="img"
        aria-label={`${SELECTION_COST_WARNING} ${detail}`}
        tabIndex={0}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" aria-hidden="true">
          <path
            d="M20.0429 21H3.95705C2.41902 21 1.45658 19.3364 2.22324 18.0031L10.2662 4.01533C11.0352 2.67792 12.9648 2.67791 13.7338 4.01532L21.7768 18.0031C22.5434 19.3364 21.581 21 20.0429 21Z"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
          <path d="M12 9V13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <path
            d="M12 17.01L12.01 16.9989"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
    </Tooltip>
  );
}

type ChatInputMetaToolbarProps = ToolbarSharedProps & {
  showMcpControl: boolean;
  showMcpPicker: boolean;
  enabledMcpCount: number;
  availableMcpCount: number;
  activeLspNames: string[];
  showLspPicker: boolean;
  lspButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  onToggleLsps: () => void;
  mcpButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  onToggleMcps: () => void;
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
        <Show when={props.workspaceFolders.length > 1}>
          <WorkspacePicker
            buttonRef={props.workspaceButtonRef}
            popoverRef={props.workspacePopoverRef}
            folders={props.workspaceFolders}
            selectedPath={props.selectedWorkspacePath}
            showPicker={props.showWorkspacePicker}
            onToggle={props.onToggleWorkspacePicker}
            onSelect={props.onSelectWorkspace}
          />
        </Show>

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
          expanded={props.showModelPicker}
          onToggle={props.onToggleModelPicker}
        />

        <Show when={props.showBusyIndicator}>
          <BusyIndicator />
        </Show>

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

        <Show when={props.selectionCostWarning}>
          {(warning) => <SelectionCostWarning {...warning()} />}
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
              showBusyOptions={props.showBusySendOptions}
              busyMenuOpen={props.showBusyMenu}
              canSend={props.canSend}
              busyToggleRef={props.busyToggleRef}
              onSend={props.onSend}
              onToggleBusyMenu={props.onToggleBusyMenu}
            />

            <Show
              when={props.showBusyMenu && props.showBusySendControls && props.showBusySendOptions}
            >
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

export function ChatInputMetaToolbar(props: ChatInputMetaToolbarProps) {
  const hasContextControl = () => props.showContextControl && !!props.contextUsage;
  const showMetaRow = () =>
    props.showPermissionControl ||
    props.showMcpControl ||
    props.activeLspNames.length > 0 ||
    hasContextControl() ||
    props.providerLimitBadges.length > 0;

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
              activity={props.autoPermissionActivity}
              judgeModel={props.autoApproveJudgeModel}
              showPicker={props.showPermissionPicker}
              showLabel={true}
              onToggle={props.onTogglePermissionPicker}
              onSelect={props.onSelectPermissionMode}
            />
          </Show>
        </div>

        <div class="toolbar-meta-right">
          <Show when={props.activeLspNames.length > 0}>
            <Tooltip
              content={`${props.activeLspNames.length} active LSP${props.activeLspNames.length === 1 ? '' : 's'}: ${props.activeLspNames.join(', ')}`}
            >
              <button
                ref={props.lspButtonRef}
                type="button"
                class="toolbar-lsp-count"
                aria-label={`${props.activeLspNames.length} active LSP${props.activeLspNames.length === 1 ? '' : 's'}: ${props.activeLspNames.join(', ')}`}
                aria-expanded={props.showLspPicker}
                onClick={props.onToggleLsps}
              >
                <span class="toolbar-lsp-count-label">
                  <span class="toolbar-meta-full-label">LSPs:</span>
                  <span class="toolbar-meta-compact-label" aria-hidden="true">
                    L
                  </span>
                </span>
                <span class="toolbar-lsp-count-value">{props.activeLspNames.length}</span>
              </button>
            </Tooltip>
          </Show>

          <Show when={props.showMcpControl}>
            <Tooltip
              content={`${props.enabledMcpCount} of ${props.availableMcpCount} MCP${props.availableMcpCount === 1 ? '' : 's'} enabled`}
            >
              <button
                ref={props.mcpButtonRef}
                type="button"
                class="toolbar-mcp-count"
                aria-label={`${props.enabledMcpCount} of ${props.availableMcpCount} MCP${props.availableMcpCount === 1 ? '' : 's'} enabled`}
                aria-expanded={props.showMcpPicker}
                onClick={props.onToggleMcps}
              >
                <span class="toolbar-mcp-count-label">
                  <span class="toolbar-meta-full-label">MCPs:</span>
                  <span class="toolbar-meta-compact-label" aria-hidden="true">
                    M
                  </span>
                </span>
                <span class="toolbar-mcp-count-value">
                  {props.enabledMcpCount}
                  <Show when={props.enabledMcpCount !== props.availableMcpCount}>
                    <span class="toolbar-mcp-count-separator">/</span>
                    {props.availableMcpCount}
                  </Show>
                </span>
              </button>
            </Tooltip>
          </Show>

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
                  providerName={props.currentModel.providerName}
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
                  available={contextUsage().used > 0}
                  title={
                    props.showContextPopup
                      ? undefined
                      : formatContextUsageTitle(contextUsage().percent, contextUsage().used > 0)
                  }
                  onClick={props.onToggleContextPopup}
                />
                <Show when={props.showContextPopup}>
                  <ContextPopup
                    ref={props.contextPopupRef}
                    boundaryRef={props.inputFrameRef}
                    alignTo="right"
                    usage={contextUsage()}
                    breakdown={props.contextBreakdown}
                    nestedBreakdown={props.nestedContextBreakdown}
                    tokens={props.sessionTokens}
                    cost={props.sessionCost}
                    subagentTokens={props.subagentTokens}
                    subagentCount={props.subagentCount}
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
