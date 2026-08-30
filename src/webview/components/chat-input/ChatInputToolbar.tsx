import { Show } from 'solid-js';
import packageJson from '../../../../package.json';
import type { Agent } from '../../types';
import type { ContextBreakdownSegment } from '../../../shared/context-breakdown';
import type {
  AutoApproveActivity,
  PermissionMode,
  ProviderLimitStatus,
  WorkspaceFolderContext,
} from '../../../shared/protocol';
import { postMessage } from '../../lib/bridge';
import { warningTriangleIcon } from '../../lib/ui-icons';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';
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
  permissionModeRecovering?: boolean;
  autoPermissionActivity?: AutoApproveActivity[];
  autoApproveJudgeModel?: { providerName: string; modelName: string } | null;
  showPermissionPicker: boolean;
  onTogglePermissionPicker: () => void;
  onSelectPermissionMode: (mode: PermissionMode) => void;
  agents: Agent[];
  selectedAgent: string | null;
  selectedAgentLabel: string;
  agentCompacted?: boolean;
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
  showModelPicker: boolean;
  selectionCostWarning: {
    providerName: string;
    modelName: string;
    reasoningLabel: string;
  } | null;
};

const SELECTION_COST_WARNING =
  'Switching the model or reasoning level mid-session may make this request more expensive.';
const VARRO_REPOSITORY_URL = packageJson.repository;

function openVarroRepository(event: MouseEvent) {
  event.preventDefault();
  postMessage({
    type: 'vscode/open-external',
    payload: { url: VARRO_REPOSITORY_URL },
  });
}

function VarroRepositoryLink() {
  return (
    <a
      class="toolbar-repository-link"
      href={VARRO_REPOSITORY_URL}
      aria-label={`Varro v${packageJson.version} on GitHub`}
      onClick={openVarroRepository}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">
        <path d="M12 .7C5.75.7.7 5.77.7 12.04c0 5.01 3.24 9.26 7.73 10.76.56.1.77-.25.77-.55v-2.19c-3.15.69-3.81-1.34-3.81-1.34-.51-1.31-1.26-1.66-1.26-1.66-1.03-.71.08-.7.08-.7 1.14.08 1.74 1.17 1.74 1.17 1.01 1.74 2.65 1.24 3.3.95.1-.74.4-1.24.72-1.52-2.51-.29-5.15-1.26-5.15-5.6 0-1.24.44-2.25 1.17-3.04-.12-.29-.51-1.44.11-3 0 0 .95-.31 3.11 1.16a10.8 10.8 0 0 1 5.66 0C17.03 5.38 17.98 5.69 17.98 5.69c.62 1.56.23 2.71.11 3 .73.79 1.17 1.8 1.17 3.04 0 4.35-2.65 5.3-5.17 5.59.41.35.77 1.04.77 2.1v2.83c0 .3.2.66.78.55a11.35 11.35 0 0 0 7.66-10.76C23.3 5.77 18.24.7 12 .7Z" />
      </svg>
      <span>v{packageJson.version}</span>
    </a>
  );
}

function SelectionCostWarning(props: {
  providerName: string;
  modelName: string;
  reasoningLabel: string;
}) {
  const detail = `Current session: ${props.providerName} / ${props.modelName} · ${props.reasoningLabel}`;
  return (
    <Tooltip
      delay={0}
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
        <UiIcon source={warningTriangleIcon} width={16} height={16} />
      </span>
    </Tooltip>
  );
}

type ChatInputMetaToolbarProps = ToolbarSharedProps & {
  allowRepositoryLink: boolean;
  showWorkspaceControl: boolean;
  workspaceFolders: WorkspaceFolderContext[];
  selectedWorkspacePath: string | null;
  canSelectWorkspace: boolean;
  showWorkspacePicker: boolean;
  workspaceButtonRef?: HTMLButtonElement | ((el: HTMLButtonElement) => void);
  workspacePopoverRef?: HTMLDivElement | ((el: HTMLDivElement) => void);
  onToggleWorkspacePicker: () => void;
  onSelectWorkspace: (path: string) => void;
  onSelectWorkspaceScope: () => void;
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
        <Show when={props.agents.length > 0 && props.showAgentControl}>
          <AgentPicker
            buttonRef={props.agentButtonRef}
            popoverRef={props.agentPopoverRef}
            agents={props.agents}
            selectedAgent={props.selectedAgent}
            selectedLabel={props.selectedAgentLabel}
            compact={props.agentCompacted}
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
          modelID={props.currentModel.modelID}
          providerName={props.currentModel.providerName}
          modelName={props.currentModel.modelName}
          canEllipsize={props.modelCanEllipsize}
          expanded={props.showModelPicker}
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
  const showRepositoryLink = () =>
    props.allowRepositoryLink &&
    !props.showMcpControl &&
    props.activeLspNames.length === 0 &&
    !hasContextControl() &&
    props.providerLimitBadges.length === 0;
  const showMetaRow = () =>
    props.showPermissionControl ||
    (props.showWorkspaceControl && props.workspaceFolders.length > 1) ||
    props.showMcpControl ||
    props.activeLspNames.length > 0 ||
    hasContextControl() ||
    props.providerLimitBadges.length > 0 ||
    showRepositoryLink();

  return (
    <Show when={showMetaRow()}>
      <div class={`chat-input-toolbars toolbar-meta ${props.compactTight ? 'compact-tight' : ''}`}>
        <div class="toolbar-meta-left">
          <Show when={props.showWorkspaceControl && props.workspaceFolders.length > 1}>
            <WorkspacePicker
              buttonRef={props.workspaceButtonRef}
              popoverRef={props.workspacePopoverRef}
              boundaryRef={props.inputFrameRef}
              alignTo="left"
              folders={props.workspaceFolders}
              selectedPath={props.selectedWorkspacePath}
              canSelect={props.canSelectWorkspace}
              allLabel="Workspace"
              showPicker={props.showWorkspacePicker}
              onToggle={props.onToggleWorkspacePicker}
              onSelect={props.onSelectWorkspace}
              onSelectAll={props.onSelectWorkspaceScope}
            />
          </Show>

          <Show when={props.showPermissionControl}>
            <PermissionModePicker
              buttonRef={props.permissionButtonRef}
              popoverRef={props.permissionPopoverRef}
              boundaryRef={props.inputFrameRef}
              alignTo="left"
              alignToTriggerWhenPossible={
                props.showWorkspaceControl && props.workspaceFolders.length > 1
              }
              mode={props.permissionMode}
              recovering={props.permissionModeRecovering}
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
          <Show when={showRepositoryLink()}>
            <VarroRepositoryLink />
          </Show>

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
