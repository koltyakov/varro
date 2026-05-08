import { For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import { implementPlan, openPlan } from '../../hooks/useOpenCode';
import { getMessageById, isLoading, skipPlanSession, state } from '../../lib/state';
import { formatAgentLabel } from '../../lib/format';
import { formatDuration, formatNumber, isAssistantMessage } from '../../lib/message-metrics';
import type { ToolCallPermissionMatch } from '../../lib/tool-call-matching';
import type { AssistantMessage, Message, Part, QuestionRequest, ToolPart } from '../../types';
import {
  Message as MessageComponent,
  getCompactSubagentHandoffDescription,
  type AssistantFileEditStackGroup,
} from '../Message';

export type AssistantDialogSummaryInfo = {
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  agentCount: number;
};

export type MessageRowSharedProps = {
  modelChangeMap: Map<string, string>;
  lastAssistantID: string | null;
  nearViewport?: boolean;
  outerListVirtualized?: boolean;
  previousTrailingFileEventSignatureMap: Map<string, string | null>;
  fileEditStackGroupMap: Map<string, AssistantFileEditStackGroup | null>;
  assistantDialogSummaryMap: Map<string, AssistantDialogSummaryInfo>;
  highlightedAssistantMessageIds?: ReadonlySet<string>;
  hasBuildAgent: boolean;
  latestPlanImplementationMessageId: string | null;
  observeMeasuredRow?: (element: HTMLDivElement, messageId: string, active: boolean) => void;
  isPlanningAssistantMessage: (info: AssistantMessage) => boolean;
  questionRequestForTool: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool: (part: ToolPart) => ToolCallPermissionMatch | null;
  shouldShowPlanImplementationAction: (args: {
    hasBuildAgent: boolean;
    info: Message;
    latestPlanImplementationMessageId: string | null;
  }) => boolean;
  buildPlanImplementationPrompt: (parts: Part[]) => string;
  buildPlanDocumentContent: (parts: Part[]) => string;
};

export function MessageRows(
  props: { messages: Array<{ info: Message; parts: Part[] }> } & MessageRowSharedProps
) {
  return <For each={props.messages}>{(msg) => <MessageRow msg={msg} {...props} />}</For>;
}

export function MessageRow(
  props: { msg: { info: Message; parts: Part[] } } & MessageRowSharedProps
) {
  let rowRef: HTMLDivElement | undefined;
  const changeLabel = () => props.modelChangeMap.get(props.msg.info.id) ?? null;
  const fileEditStackGroup = () => props.fileEditStackGroupMap.get(props.msg.info.id) ?? null;
  const summary = () => props.assistantDialogSummaryMap.get(props.msg.info.id);
  const highlightFinalAnswer = () =>
    props.highlightedAssistantMessageIds?.has(props.msg.info.id) ??
    props.assistantDialogSummaryMap.has(props.msg.info.id);
  const streamingPartId = createMemo(() => {
    const partId = state.streamingPartId;
    if (!partId) return null;
    return props.msg.parts.some((part) => part.id === partId) ? partId : null;
  });
  const streamingText = () => (streamingPartId() ? state.streamingText : '');
  const highlightPlanningAnswer = () =>
    props.assistantDialogSummaryMap.has(props.msg.info.id) &&
    isAssistantMessage(props.msg.info) &&
    props.isPlanningAssistantMessage(props.msg.info as AssistantMessage);
  const compactSubagentHandoff = createMemo(() => {
    if (props.msg.info.role !== 'user') return null;

    const session = state.sessions.find((item) => item.id === props.msg.info.sessionID);
    if (!session?.parentID) return null;

    const childAssistant = state.messages.find(
      (entry) =>
        entry.info.sessionID === props.msg.info.sessionID &&
        isAssistantMessage(entry.info) &&
        (entry.info as AssistantMessage).mode === 'subagent'
    );
    const childInfo = childAssistant?.info as AssistantMessage | undefined;
    const parentInfo = childInfo ? getMessageById(childInfo.parentID)?.info : null;
    const agentLabel = formatAgentLabel(childInfo?.agent || 'subagent');
    const detailParts = [
      parentInfo && isAssistantMessage(parentInfo)
        ? `from ${parentInfo.agent || 'assistant'}`
        : null,
      session.title !== 'New Session' ? session.title : null,
    ].filter(Boolean);
    return {
      label: `Handed off to ${agentLabel}`,
      description: getCompactSubagentHandoffDescription(props.msg.parts),
      detail: detailParts.join(' · '),
    };
  });

  onMount(() => {
    if (rowRef) props.observeMeasuredRow?.(rowRef, props.msg.info.id, true);
  });
  onCleanup(() => {
    if (rowRef) props.observeMeasuredRow?.(rowRef, props.msg.info.id, false);
  });

  return (
    <div
      ref={(el) => {
        rowRef = el;
      }}
      data-msg-id={props.msg.info.id}
      class={`interactive-item-container ${
        props.msg.info.role === 'user' ? 'interactive-request' : 'interactive-response'
      } ${
        fileEditStackGroup()
          ? `interactive-response-file-edit-group interactive-response-file-edit-group-${fileEditStackGroup()}`
          : ''
      }`}
    >
      <Show when={changeLabel()}>
        <div class="model-change-indicator">
          <span class="model-change-label">Switched to {changeLabel()}</span>
        </div>
      </Show>
      <MessageComponent
        info={props.msg.info}
        parts={props.msg.parts}
        isLastAssistant={props.msg.info.id === props.lastAssistantID}
        nearViewport={props.nearViewport}
        outerListVirtualized={props.outerListVirtualized}
        highlightFinalAnswer={highlightFinalAnswer()}
        highlightPlanningAnswer={highlightPlanningAnswer()}
        previousTrailingFileEventSignature={
          props.previousTrailingFileEventSignatureMap.get(props.msg.info.id) ?? null
        }
        fileEditStackGroup={fileEditStackGroup()}
        streamingPartId={streamingPartId()}
        streamingText={streamingText()}
        questionRequestForTool={props.questionRequestForTool}
        permissionMatchForTool={props.permissionMatchForTool}
        compactSubagentHandoff={compactSubagentHandoff()}
      />
      <Show when={summary()}>
        {(assistantSummary) => (
          <AssistantDialogSummary
            summary={assistantSummary()}
            showImplementPlanAction={props.shouldShowPlanImplementationAction({
              hasBuildAgent: props.hasBuildAgent,
              info: props.msg.info,
              latestPlanImplementationMessageId: props.latestPlanImplementationMessageId,
            })}
            onImplementPlan={() =>
              void implementPlan(
                props.buildPlanImplementationPrompt(props.msg.parts),
                props.msg.info.sessionID
              )
            }
            onOpenPlan={() =>
              void openPlan(
                props.buildPlanDocumentContent(props.msg.parts),
                props.msg.info.sessionID
              )
            }
            onSkipPlan={() => skipPlanSession(props.msg.info.sessionID)}
          />
        )}
      </Show>
    </div>
  );
}

function AssistantDialogSummary(props: {
  summary: AssistantDialogSummaryInfo;
  showImplementPlanAction?: boolean;
  onOpenPlan?: () => void;
  onImplementPlan?: () => void;
  onSkipPlan?: () => void;
}) {
  const agentSuffix =
    props.summary.agentCount > 0 ? ` - Agents ${formatNumber(props.summary.agentCount)}` : '';

  return (
    <div class="model-change-indicator assistant-dialog-summary">
      <div class="assistant-dialog-summary-content">
        <span class="model-change-label">
          {`Worked for ${formatDuration(props.summary.durationMs)} - Tokens ↑ ${formatNumber(props.summary.inputTokens)} · ↓ ${formatNumber(props.summary.outputTokens)}${agentSuffix}`}
        </span>
      </div>
      <Show when={props.showImplementPlanAction}>
        <div class="assistant-dialog-summary-actions">
          <button
            type="button"
            class="assistant-dialog-summary-action assistant-dialog-summary-action-neutral"
            disabled={isLoading()}
            onClick={() => props.onOpenPlan?.()}
          >
            Open plan
          </button>
          <button
            type="button"
            class="assistant-dialog-summary-action assistant-dialog-summary-action-implement"
            disabled={isLoading()}
            onClick={() => props.onImplementPlan?.()}
          >
            Implement the plan
          </button>
          <button
            type="button"
            class="assistant-dialog-summary-action assistant-dialog-summary-action-danger"
            onClick={() => props.onSkipPlan?.()}
          >
            Skip for now
          </button>
        </div>
      </Show>
    </div>
  );
}
