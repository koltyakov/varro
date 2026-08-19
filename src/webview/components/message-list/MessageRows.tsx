import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { isAbortedAssistantError } from '../../../shared/error-classification';
import { forkSession, implementPlan, openPlan } from '../../hooks/useOpenCode';
import {
  editingMessage,
  registerInlineEditMount,
  unregisterInlineEditMount,
} from '../../lib/message-edit-state';
import { isLoading, skipPlanSession, state } from '../../lib/state';
import { prepareMeasuredEntrance } from '../../lib/measured-entrance';
import type { AssistantActivityGroupInfo } from '../../lib/assistant-activity';
import { formatNumber, formatTurnDuration, isAssistantMessage } from '../../lib/message-metrics';
import type { ToolCallPermissionMatch } from '../../lib/tool-call-matching';
import type { MessageEntry, QuestionRequest, ToolPart } from '../../types';
import { ForkIcon } from '../ForkIcon';
import { Message as MessageComponent } from '../Message';
import {
  buildPlanDocumentContent,
  buildPlanImplementationPrompt,
  isPlanningAssistantMessage,
  shouldShowPlanImplementationAction,
} from './plan-actions';
import type { AssistantDialogSummaryInfo } from './assistant-dialog';

export type MessageRowSharedProps = {
  modelChangeMap: Map<string, string>;
  promptNumberMap: ReadonlyMap<string, number>;
  showPromptNumbers: boolean;
  showSentTimestamps: boolean;
  lastAssistantID: string | null;
  nearViewport?: boolean;
  outerListVirtualized?: boolean;
  previousTrailingFileEventSignatureMap: Map<string, string | null>;
  assistantDialogSummaryMap: Map<string, AssistantDialogSummaryInfo>;
  isFinalAssistantMessage(messageId: string): boolean;
  assistantActivityGroupMap?: ReadonlyMap<string, readonly AssistantActivityGroupInfo[]>;
  retainedActivityPartKeys?: ReadonlySet<string>;
  exitingActivityPartKeys?: ReadonlySet<string>;
  visibleActiveActivityPartKeys?: ReadonlySet<string>;
  hasBuildAgent: boolean;
  latestPlanImplementationMessageId: string | null;
  claimMessageEntrance?: (messageId: string) => boolean;
  claimAssistantItemReveal?: (messageId: string, renderKey: string) => boolean;
  observeMeasuredRow?: (element: HTMLDivElement, messageId: string, active: boolean) => void;
  questionRequestForTool: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool: (part: ToolPart) => ToolCallPermissionMatch | null;
};

export function MessageRows(props: { messages: MessageEntry[] } & MessageRowSharedProps) {
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
  props: {
    msg: MessageEntry;
    virtualHeight?: number;
    virtualPlaceholder?: boolean;
    renderEmpty?: boolean;
    followsVisibleAssistantResponse?: boolean;
    continuesVisibleActivityGroup?: boolean;
  } & MessageRowSharedProps
) {
  let rowRef: HTMLDivElement | undefined;
  let disposeEntrance: (() => void) | undefined;
  const claimedEntrance = props.claimMessageEntrance?.(props.msg.info.id) ?? false;
  const hasImage = props.msg.parts.some(
    (part) => part.type === 'file' && part.mime.startsWith('image/')
  );
  const animateEntrance = claimedEntrance && !hasImage && props.msg.info.role !== 'user';
  const allowInitialAssistantItemReveal = animateEntrance || props.msg.parts.length === 0;
  const isOffCore = () => !!props.outerListVirtualized && props.nearViewport === false;
  const isVirtualPlaceholder = () => isOffCore() && !!props.virtualPlaceholder;
  const [entrancePending, setEntrancePending] = createSignal(animateEntrance);
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
  const summary = () => props.assistantDialogSummaryMap.get(props.msg.info.id);
  const assistantActivityGroups = () =>
    props.assistantActivityGroupMap?.get(props.msg.info.id) ?? null;
  const highlightFinalAnswer = () => {
    const info = props.msg.info;
    if (isAssistantMessage(info) && isAbortedAssistantError(info.error)) {
      return false;
    }

    return props.isFinalAssistantMessage(info.id);
  };
  const streamingPartId = createMemo(() => {
    const partId = state.streamingPartId;
    if (!partId) return null;
    return props.msg.parts.some((part) => part.id === partId) ? partId : null;
  });
  const streamingText = () => (streamingPartId() ? state.streamingText : '');
  const highlightPlanningAnswer = () =>
    props.isFinalAssistantMessage(props.msg.info.id) &&
    isAssistantMessage(props.msg.info) &&
    isPlanningAssistantMessage(props.msg.info);

  onMount(() => {
    if (rowRef && animateEntrance) {
      disposeEntrance = prepareMeasuredEntrance(rowRef, {
        animationName: 'streamed-message-row-in',
        heightProperty: '--streamed-message-row-height',
        onFinish: () => setEntrancePending(false),
      });
    }
    if (rowRef) props.observeMeasuredRow?.(rowRef, props.msg.info.id, true);
  });
  createEffect((wasVirtualPlaceholder) => {
    const virtualPlaceholder = isVirtualPlaceholder();
    if (wasVirtualPlaceholder && !virtualPlaceholder) {
      // Let Solid publish the hydrated class/content before measuring the row's real geometry.
      queueMicrotask(() => {
        if (rowRef?.isConnected && !isVirtualPlaceholder()) {
          props.observeMeasuredRow?.(rowRef, props.msg.info.id, true);
        }
      });
    }
    return virtualPlaceholder;
  }, isVirtualPlaceholder());
  onCleanup(() => {
    disposeEntrance?.();
    if (rowRef) props.observeMeasuredRow?.(rowRef, props.msg.info.id, false);
  });

  return (
    <div
      ref={(el) => {
        rowRef = el;
      }}
      data-msg-id={props.msg.info.id}
      style={{ height: isVirtualPlaceholder() ? `${props.virtualHeight ?? 0}px` : undefined }}
      class={`interactive-item-container ${
        props.msg.info.role === 'user' ? 'interactive-request' : 'interactive-response'
      } ${entrancePending() ? 'interactive-item-entering' : ''}${isAbandonedByEdit() ? ' interactive-item-edit-abandoned' : ''}${
        isEditingThisMessage() ? ' interactive-request-editing' : ''
      }${props.followsVisibleAssistantResponse ? ' interactive-response-follows-response' : ''}${props.continuesVisibleActivityGroup ? ' interactive-response-continues-activity-group' : ''}${isOffCore() ? ' interactive-item-off-core' : ''}${isVirtualPlaceholder() ? ' interactive-item-virtual-placeholder' : ''}${props.renderEmpty ? ' interactive-item-render-empty' : ''}`}
    >
      <Show when={!isVirtualPlaceholder()}>
        <Show when={changeLabel()}>
          <div class="model-change-indicator">
            <span class="model-change-label">Switched to {changeLabel()}</span>
          </div>
        </Show>
        <Show when={!isEditingThisMessage()} fallback={<InlineEditComposerSlot />}>
          <MessageComponent
            info={props.msg.info}
            parts={props.msg.parts}
            promptNumber={
              props.showPromptNumbers ? props.promptNumberMap.get(props.msg.info.id) : undefined
            }
            showSentTimestamp={props.showSentTimestamps}
            isLastAssistant={props.msg.info.id === props.lastAssistantID}
            nearViewport={props.nearViewport}
            outerListVirtualized={props.outerListVirtualized}
            highlightFinalAnswer={highlightFinalAnswer()}
            highlightPlanningAnswer={highlightPlanningAnswer()}
            previousTrailingFileEventSignature={
              props.previousTrailingFileEventSignatureMap.get(props.msg.info.id) ?? null
            }
            streamingPartId={streamingPartId()}
            streamingText={streamingText()}
            allowInitialAssistantItemReveal={allowInitialAssistantItemReveal}
            claimAssistantItemReveal={props.claimAssistantItemReveal}
            questionRequestForTool={props.questionRequestForTool}
            permissionMatchForTool={props.permissionMatchForTool}
            compactActivityGroups={assistantActivityGroups()}
            retainedActivityPartKeys={props.retainedActivityPartKeys}
            exitingActivityPartKeys={props.exitingActivityPartKeys}
            visibleActiveActivityPartKeys={props.visibleActiveActivityPartKeys}
          />
        </Show>
        <Show when={summary()}>
          {(assistantSummary) => (
            <AssistantDialogSummaryForMessage
              summary={assistantSummary()}
              msg={props.msg}
              hasBuildAgent={props.hasBuildAgent}
              latestPlanImplementationMessageId={props.latestPlanImplementationMessageId}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}

export function AssistantDialogSummaryForMessage(
  props: {
    summary: AssistantDialogSummaryInfo;
    msg: MessageEntry;
  } & Pick<MessageRowSharedProps, 'hasBuildAgent' | 'latestPlanImplementationMessageId'>
) {
  return (
    <AssistantDialogSummary
      summary={props.summary}
      showImplementPlanAction={shouldShowPlanImplementationAction({
        hasBuildAgent: props.hasBuildAgent,
        info: props.msg.info,
        latestPlanImplementationMessageId: props.latestPlanImplementationMessageId,
      })}
      onImplementPlan={() =>
        void implementPlan(buildPlanImplementationPrompt(props.msg.parts), props.msg.info.sessionID)
      }
      onOpenPlan={() =>
        void openPlan(buildPlanDocumentContent(props.msg.parts), props.msg.info.sessionID)
      }
      onSkipPlan={() => skipPlanSession(props.msg.info.sessionID)}
      onFork={() => {
        const boundaryMessageId = getForkBoundaryMessageId(
          state.messages,
          props.msg.info.sessionID,
          props.msg.info.id
        );
        void (boundaryMessageId
          ? forkSession(props.msg.info.sessionID, boundaryMessageId)
          : forkSession(props.msg.info.sessionID));
      }}
    />
  );
}

export function getForkBoundaryMessageId(
  messages: readonly MessageEntry[],
  sessionId: string,
  summarizedMessageId: string
): string | undefined {
  const summarizedIndex = messages.findIndex((entry) => entry.info.id === summarizedMessageId);
  if (summarizedIndex < 0) return undefined;

  return messages.slice(summarizedIndex + 1).find((entry) => entry.info.sessionID === sessionId)
    ?.info.id;
}

function AssistantDialogSummary(props: {
  summary: AssistantDialogSummaryInfo;
  showImplementPlanAction?: boolean;
  onOpenPlan?: () => void;
  onImplementPlan?: () => void;
  onSkipPlan?: () => void;
  onFork: () => void;
}) {
  const tokenSuffix = () =>
    props.summary.inputTokens > 0 || props.summary.outputTokens > 0
      ? ` - Tokens ↑ ${formatNumber(props.summary.inputTokens)} ↓ ${formatNumber(props.summary.outputTokens)}`
      : '';
  const agentSuffix = () =>
    props.summary.agentCount > 0 ? ` - Agents ${formatNumber(props.summary.agentCount)}` : '';
  const statusSuffix = () =>
    props.summary.permissionRejected
      ? ' - Permission rejected'
      : props.summary.questionSkipped
        ? ' - Question skipped'
        : '';

  return (
    <div class="model-change-indicator assistant-dialog-summary">
      <div class="assistant-dialog-summary-content">
        <span class="model-change-label">
          {props.summary.interrupted
            ? 'Interrupted'
            : props.summary.collectingStats
              ? 'Collecting stats...'
              : `Worked for ${formatTurnDuration(props.summary.durationMs)}${statusSuffix()}${tokenSuffix()}${agentSuffix()}`}
        </span>
        <button
          type="button"
          class="assistant-dialog-summary-fork"
          aria-label="Fork chat from here"
          title="Fork chat from here"
          disabled={isLoading()}
          onClick={() => props.onFork()}
        >
          <ForkIcon />
        </button>
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
