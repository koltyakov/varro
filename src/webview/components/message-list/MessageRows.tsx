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
import { formatClockTime } from '../../lib/message-time';
import { checkIcon, copyIcon } from '../../lib/ui-icons';
import { writeClipboard } from '../../lib/write-clipboard';
import type { ToolCallPermissionMatch } from '../../lib/tool-call-matching';
import type { MessageEntry, QuestionRequest, ToolPart } from '../../types';
import { ForkIcon } from '../ForkIcon';
import { Message as MessageComponent } from '../Message';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';
import {
  buildPlanDocumentContent,
  buildPlanImplementationPrompt,
  isPlanningAssistantMessage,
  shouldShowPlanImplementationAction,
} from './plan-actions';
import type { AssistantDialogSummaryInfo } from './assistant-dialog';

const HOVER_INTENT_DELAY_MS = 300;

export type MessageRowSharedProps = {
  modelChangeMap: Map<string, ModelChangeInfo>;
  promptNumberMap: ReadonlyMap<string, number>;
  showPromptNumbers: boolean;
  showSentTimestamps: boolean;
  revealedSentTimestampMessageId?: string | null;
  revealedWorkedSummaryPromptMessageId?: string | null;
  showWorkedSummaryTimes?: boolean;
  suppressTimestampAnimations?: boolean;
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
  groupedActiveActivityPartKeys?: ReadonlySet<string>;
  inlineThinkingMessageIds?: ReadonlySet<string>;
  expandedThinkingMessageIds?: ReadonlySet<string>;
  hasBuildAgent: boolean;
  latestPlanImplementationMessageId: string | null;
  claimMessageEntrance?: (messageId: string) => boolean;
  claimAssistantItemReveal?: (messageId: string, renderKey: string) => boolean;
  observeMeasuredRow?: (element: HTMLDivElement, messageId: string, active: boolean) => void;
  questionRequestForTool: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool: (part: ToolPart) => ToolCallPermissionMatch | null;
  onAssistantDiffSettledEmpty?: (messageId: string) => void;
  onWorkedSummaryHoverChange?: (promptMessageId: string, hovering: boolean) => void;
  onUserMessageHoverChange?: (messageId: string, hovering: boolean) => void;
};

export type ModelChangeInfo = {
  normalFrom: string;
  normalTo: string;
  narrowFrom: string;
  narrowTo: string;
  from: string;
  to: string;
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
    followsVisibleUserRequest?: boolean;
    followsVisibleAssistantResponse?: boolean;
    followsBorderedBlock?: boolean;
    continuesVisibleActivityGroup?: boolean;
  } & MessageRowSharedProps
) {
  let rowRef: HTMLDivElement | undefined;
  let disposeEntrance: (() => void) | undefined;
  const messageId = props.msg.info.id;
  const claimedEntrance = props.claimMessageEntrance?.(messageId) ?? false;
  const hasImage = props.msg.parts.some(
    (part) => part.type === 'file' && part.mime.startsWith('image/')
  );
  const animateEntrance = claimedEntrance && !hasImage && props.msg.info.role !== 'user';
  const allowInitialAssistantItemReveal = animateEntrance || props.msg.parts.length === 0;
  const isOffCore = () => !!props.outerListVirtualized && props.nearViewport === false;
  const isVirtualPlaceholder = () => isOffCore() && !!props.virtualPlaceholder;
  const [entrancePending, setEntrancePending] = createSignal(animateEntrance);
  const modelChange = () => props.modelChangeMap.get(props.msg.info.id) ?? null;
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
    if (rowRef) props.observeMeasuredRow?.(rowRef, messageId, true);
  });
  createEffect((wasVirtualPlaceholder) => {
    const virtualPlaceholder = isVirtualPlaceholder();
    if (wasVirtualPlaceholder && !virtualPlaceholder) {
      // Let Solid publish the hydrated class/content before measuring the row's real geometry.
      queueMicrotask(() => {
        if (rowRef?.isConnected && !isVirtualPlaceholder()) {
          props.observeMeasuredRow?.(rowRef, messageId, true);
        }
      });
    }
    return virtualPlaceholder;
  }, isVirtualPlaceholder());
  onCleanup(() => {
    disposeEntrance?.();
    if (rowRef) props.observeMeasuredRow?.(rowRef, messageId, false);
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
      }${props.followsVisibleUserRequest ? ' interactive-response-follows-request' : ''}${props.followsVisibleAssistantResponse ? ' interactive-response-follows-response' : ''}${props.followsBorderedBlock ? ' interactive-item-follows-bordered-block' : ''}${props.continuesVisibleActivityGroup ? ' interactive-response-continues-activity-group' : ''}${isOffCore() ? ' interactive-item-off-core' : ''}${isVirtualPlaceholder() ? ' interactive-item-virtual-placeholder' : ''}${props.renderEmpty ? ' interactive-item-render-empty' : ''}`}
    >
      <Show when={!isVirtualPlaceholder()}>
        <Show when={modelChange()}>
          {(change) => (
            <div class="model-change-indicator">
              <Tooltip
                delay={300}
                content={
                  <div class="model-change-tooltip">
                    <div>From: {change().from}</div>
                    <div>To: {change().to}</div>
                  </div>
                }
              >
                <span class="model-change-label" tabindex="0">
                  <span class="model-change-normal">
                    {change().normalFrom} → {change().normalTo}
                  </span>
                  <span class="model-change-narrow">
                    {change().narrowFrom} → {change().narrowTo}
                  </span>
                </span>
              </Tooltip>
            </div>
          )}
        </Show>
        <Show when={!isEditingThisMessage()} fallback={<InlineEditComposerSlot />}>
          <MessageComponent
            info={props.msg.info}
            parts={props.msg.parts}
            promptNumber={props.promptNumberMap.get(props.msg.info.id)}
            showPromptNumber={props.showPromptNumbers}
            showSentTimestamp={
              props.showSentTimestamps || props.revealedSentTimestampMessageId === props.msg.info.id
            }
            onAssistantDiffSettledEmpty={props.onAssistantDiffSettledEmpty}
            onUserMessageHoverChange={props.onUserMessageHoverChange}
            suppressTimestampAnimation={props.suppressTimestampAnimations}
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
            groupedActiveActivityPartKeys={props.groupedActiveActivityPartKeys}
            keepReasoningInline={props.inlineThinkingMessageIds?.has(props.msg.info.id)}
            expandReasoning={props.expandedThinkingMessageIds?.has(props.msg.info.id)}
          />
        </Show>
        <Show when={summary()}>
          {(assistantSummary) => (
            <AssistantDialogSummaryForMessage
              summary={assistantSummary()}
              msg={props.msg}
              hasBuildAgent={props.hasBuildAgent}
              latestPlanImplementationMessageId={props.latestPlanImplementationMessageId}
              onWorkedSummaryHoverChange={props.onWorkedSummaryHoverChange}
              showCompletedTime={
                props.showWorkedSummaryTimes ||
                props.revealedWorkedSummaryPromptMessageId === assistantSummary().promptMessageId
              }
              suppressTimestampAnimation={props.suppressTimestampAnimations}
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
    showCompletedTime?: boolean;
    suppressTimestampAnimation?: boolean;
  } & Pick<
    MessageRowSharedProps,
    'hasBuildAgent' | 'latestPlanImplementationMessageId' | 'onWorkedSummaryHoverChange'
  >
) {
  return (
    <AssistantDialogSummary
      summary={props.summary}
      messageId={props.msg.info.id}
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
      copyText={props.msg.parts
        .flatMap((part) =>
          part.type === 'text' && !part.synthetic && !part.ignored ? [part.text.trim()] : []
        )
        .filter(Boolean)
        .join('\n\n')}
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
      onWorkedSummaryHoverChange={props.onWorkedSummaryHoverChange}
      showCompletedTime={props.showCompletedTime}
      suppressTimestampAnimation={props.suppressTimestampAnimation}
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
  messageId: string;
  showImplementPlanAction?: boolean;
  onOpenPlan?: () => void;
  onImplementPlan?: () => void;
  onSkipPlan?: () => void;
  copyText: string;
  onFork: () => void;
  onWorkedSummaryHoverChange?: (promptMessageId: string, hovering: boolean) => void;
  showCompletedTime?: boolean;
  suppressTimestampAnimation?: boolean;
}) {
  let summaryRef: HTMLDivElement | undefined;
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
  const hasCompletedSummary = () => !props.summary.collectingStats;
  const completedTime = () =>
    hasCompletedSummary() && props.summary.completedAt !== undefined
      ? formatClockTime(props.summary.completedAt)
      : null;
  const onWorkedSummaryHoverChange = props.onWorkedSummaryHoverChange;
  let hoveredPromptMessageId: string | null = null;
  let hoverIntentTimer: ReturnType<typeof setTimeout> | undefined;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  const [isHoverIntentActive, setIsHoverIntentActive] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const copyFinalResponse = async () => {
    if (!props.copyText || !(await writeClipboard(props.copyText))) return;
    setCopied(true);
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => setCopied(false), 1500);
  };
  const notifyHoverChange = (hovering: boolean) => {
    if (hoverIntentTimer) {
      clearTimeout(hoverIntentTimer);
      hoverIntentTimer = undefined;
    }
    if (!hovering) {
      setIsHoverIntentActive(false);
      if (hoveredPromptMessageId) {
        onWorkedSummaryHoverChange?.(hoveredPromptMessageId, false);
        hoveredPromptMessageId = null;
      }
      return;
    }
    if (!hasCompletedSummary() || !props.summary.promptMessageId) return;
    const promptMessageId = props.summary.promptMessageId;
    hoverIntentTimer = setTimeout(() => {
      hoverIntentTimer = undefined;
      hoveredPromptMessageId = promptMessageId;
      setIsHoverIntentActive(true);
      onWorkedSummaryHoverChange?.(promptMessageId, true);
    }, HOVER_INTENT_DELAY_MS);
  };
  onMount(() => {
    if (!summaryRef) return;
    const messageRow = summaryRef.closest<HTMLElement>('[data-msg-id]');
    const summaryRow = summaryRef.closest<HTMLElement>('.trailing-assistant-summary-row');
    const hoverRoot =
      messageRow ?? summaryRef.closest<HTMLElement>('.interactive-list-track') ?? summaryRef;
    const isInHoverRegion = (target: EventTarget | null) => {
      if (!(target instanceof Element) || !hoverRoot.contains(target)) return false;
      if (target.closest('.assistant-dialog-summary') === summaryRef) return true;
      if (summaryRow && target === summaryRow) return true;
      const targetMessageRow = target.closest<HTMLElement>('[data-msg-id]');
      if (target === targetMessageRow && targetMessageRow.dataset.msgId === props.messageId) {
        return true;
      }
      const finalResponse = target.closest('.assistant-message-flow-item-final');
      return (
        finalResponse?.closest<HTMLElement>('[data-msg-id]')?.dataset.msgId === props.messageId
      );
    };
    const onMouseOver = (event: MouseEvent) => {
      if (isInHoverRegion(event.target) && !isInHoverRegion(event.relatedTarget)) {
        notifyHoverChange(true);
      }
    };
    const onMouseOut = (event: MouseEvent) => {
      if (isInHoverRegion(event.target) && !isInHoverRegion(event.relatedTarget)) {
        notifyHoverChange(false);
      }
    };
    hoverRoot.addEventListener('mouseover', onMouseOver);
    hoverRoot.addEventListener('mouseout', onMouseOut);
    onCleanup(() => {
      hoverRoot.removeEventListener('mouseover', onMouseOver);
      hoverRoot.removeEventListener('mouseout', onMouseOut);
    });
  });
  onCleanup(() => {
    if (hoverIntentTimer) clearTimeout(hoverIntentTimer);
    if (copiedTimer) clearTimeout(copiedTimer);
    if (hoveredPromptMessageId) {
      onWorkedSummaryHoverChange?.(hoveredPromptMessageId, false);
    }
  });

  return (
    <div
      ref={(element) => {
        summaryRef = element;
      }}
      class={`model-change-indicator assistant-dialog-summary${props.showCompletedTime || isHoverIntentActive() ? ' is-completion-time-visible' : ''}${isHoverIntentActive() ? ' is-hover-intent-active' : ''}`}
      data-prompt-msg-id={props.summary.promptMessageId}
    >
      <div class="assistant-dialog-summary-content">
        <Show when={completedTime()}>
          {(time) => (
            <time
              class={`assistant-dialog-summary-completed-time${props.suppressTimestampAnimation ? ' is-animation-suppressed' : ''}`}
              dateTime={new Date(props.summary.completedAt!).toISOString()}
            >
              <span class="assistant-dialog-summary-completed-time-text">{time()}</span>
            </time>
          )}
        </Show>
        <span class="model-change-label">
          <Show
            when={!props.summary.interrupted && !props.summary.collectingStats}
            fallback={props.summary.interrupted ? 'Interrupted' : 'Collecting stats...'}
          >
            Worked for {formatTurnDuration(props.summary.durationMs)}
            {statusSuffix()}
            <Show when={tokenSuffix()}>
              {(tokens) => <span class="assistant-dialog-summary-token-budget">{tokens()}</span>}
            </Show>
            {agentSuffix()}
          </Show>
        </span>
        <div class="assistant-dialog-summary-turn-actions">
          <Tooltip content={copied() ? 'Copied' : 'Copy final response'} delay={500}>
            <button
              type="button"
              class="assistant-dialog-summary-turn-action assistant-dialog-summary-copy"
              classList={{ 'is-copied': copied() }}
              aria-label={copied() ? 'Copied final response' : 'Copy final response'}
              disabled={isLoading() || !props.copyText}
              onClick={() => void copyFinalResponse()}
            >
              <UiIcon
                source={copied() ? checkIcon : copyIcon}
                width="16"
                height="16"
                aria-hidden="true"
              />
            </button>
          </Tooltip>
          <Tooltip content="Fork chat from here" delay={500}>
            <button
              type="button"
              class="assistant-dialog-summary-turn-action assistant-dialog-summary-fork"
              aria-label="Fork chat from here"
              onClick={() => props.onFork()}
            >
              <ForkIcon />
            </button>
          </Tooltip>
        </div>
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
