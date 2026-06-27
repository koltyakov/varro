import { For, Show, createMemo, onCleanup, onMount } from 'solid-js';
import { implementPlan, openPlan } from '../../hooks/useOpenCode';
import { isAbortedAssistantError } from '../../lib/aborted';
import {
  editingMessage,
  registerInlineEditMount,
  unregisterInlineEditMount,
} from '../../lib/message-edit-state';
import { isLoading, skipPlanSession, state } from '../../lib/state';
import { formatDuration, formatNumber, isAssistantMessage } from '../../lib/message-metrics';
import type { ToolCallPermissionMatch } from '../../lib/tool-call-matching';
import type { AssistantMessage, Message, Part, QuestionRequest, ToolPart } from '../../types';
import { Message as MessageComponent, type AssistantFileEditStackGroup } from '../Message';

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

// Mount point for the relocated composer while this row's message is edited.
function InlineEditComposerSlot() {
  let slotRef: HTMLDivElement | undefined;

  onMount(() => {
    if (slotRef) registerInlineEditMount(slotRef);
  });
  onCleanup(() => {
    if (slotRef) unregisterInlineEditMount(slotRef);
  });

  return (
    <div
      ref={(el) => {
        slotRef = el;
      }}
      class="inline-edit-composer-slot"
    />
  );
}

export function MessageRow(
  props: { msg: { info: Message; parts: Part[] } } & MessageRowSharedProps
) {
  let rowRef: HTMLDivElement | undefined;
  const changeLabel = () => props.modelChangeMap.get(props.msg.info.id) ?? null;
  const isEditingThisMessage = () =>
    props.msg.info.role === 'user' && editingMessage()?.messageId === props.msg.info.id;
  const isAbandonedByEdit = createMemo(() => {
    const editing = editingMessage();
    if (!editing) return false;
    const messages = state.messages;
    const editedIndex = messages.findIndex((entry) => entry.info.id === editing.messageId);
    if (editedIndex < 0) return false;
    const ownIndex = messages.findIndex((entry) => entry.info.id === props.msg.info.id);
    return ownIndex > editedIndex;
  });
  const fileEditStackGroup = () => props.fileEditStackGroupMap.get(props.msg.info.id) ?? null;
  const summary = () => props.assistantDialogSummaryMap.get(props.msg.info.id);
  const highlightFinalAnswer = () => {
    const info = props.msg.info;
    if (isAssistantMessage(info) && isAbortedAssistantError(info.error)) {
      return false;
    }

    return (
      props.highlightedAssistantMessageIds?.has(info.id) ??
      props.assistantDialogSummaryMap.has(info.id)
    );
  };
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
      }${isAbandonedByEdit() ? ' interactive-item-edit-abandoned' : ''}${
        isEditingThisMessage() ? ' interactive-request-editing' : ''
      }`}
    >
      <Show when={changeLabel()}>
        <div class="model-change-indicator">
          <span class="model-change-label">Switched to {changeLabel()}</span>
        </div>
      </Show>
      <Show when={!isEditingThisMessage()} fallback={<InlineEditComposerSlot />}>
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
        />
      </Show>
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
  const tokenSuffix =
    props.summary.inputTokens > 0 || props.summary.outputTokens > 0
      ? ` - Tokens ↑ ${formatNumber(props.summary.inputTokens)} · ↓ ${formatNumber(props.summary.outputTokens)}`
      : '';
  const agentSuffix =
    props.summary.agentCount > 0 ? ` - Agents ${formatNumber(props.summary.agentCount)}` : '';

  return (
    <div class="model-change-indicator assistant-dialog-summary">
      <div class="assistant-dialog-summary-content">
        <span class="model-change-label">
          {`Worked for ${formatDuration(props.summary.durationMs)}${tokenSuffix}${agentSuffix}`}
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
