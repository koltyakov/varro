import {
  For,
  Show,
  createRenderEffect,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onSettled,
  untrack,
} from 'solid-js';
import { Portal } from '@solidjs/web';
import { isAbortedAssistantError } from '../../../shared/error-classification';
import { forkSession, implementPlan, openPlan } from '../../hooks/useOpenCode';
import {
  editingMessage,
  registerInlineEditMount,
  unregisterInlineEditMount,
} from '../../lib/message-edit-state';
import { isLoading, skipPlanSession, state } from '../../lib/state';
import { prepareMeasuredEntrance } from '../../lib/measured-entrance';
import { prepareForMessageBlockRemoval } from '../../lib/message-list-layout';
import type { AssistantActivityGroupInfo } from '../../lib/assistant-activity';
import {
  formatNumber,
  formatTurnCost,
  formatTurnDuration,
  isAssistantMessage,
} from '../../lib/message-metrics';
import { formatMessageSentTime } from '../../lib/message-time';
import {
  checkIcon,
  clockIcon,
  coinsIcon,
  copyIcon,
  dashboardDotsIcon,
  dollarCircleIcon,
  navArrowDownIcon,
  triangleFlagIcon,
  xmarkCircleIcon,
} from '../../lib/ui-icons';
import { ariaBoolean } from '../../lib/aria';
import { startNewChatDraft } from '../../lib/new-chat-draft';
import { isPlanHandedOff, recordPlanHandoff } from '../../lib/plan-handoff';
import { requestPlanImplementationDraft } from '../../lib/plan-implementation-draft';
import {
  canSummarizePlan,
  countPlanningTurns,
  resolvePlanContent,
  summarizePlanSession,
} from '../../lib/plan-content';
import { showSessionActionFeedback } from '../chat/SessionActionFeedback';
import { ActionsMenu } from './FollowupActionsMenu';
import { writeClipboard } from '../../lib/write-clipboard';
import type { ToolCallPermissionMatch } from '../../lib/tool-call-matching';
import type { MessageEntry, QuestionRequest, ToolPart } from '../../types';
import { ForkIcon } from '../ForkIcon';
import { Message as MessageComponent } from '../Message';
import { FormattedModelName } from '../chat-input/ToolbarPickers';
import { projectAutomaticActionMessage } from '../message/UserMessageContent';
import { SessionPauseDivider, SessionResumeButton } from '../message/SessionPauseDivider';
import type { SessionPause } from '../../lib/session-pauses';
import { Tooltip } from '../Tooltip';
import { UiIcon } from '../UiIcon';
import {
  buildPlanDocumentContent,
  buildLinkedPlanImplementationPrompt,
  buildPlanImplementationPrompt,
  isPlanningAssistantMessage,
  shouldShowPlanImplementationAction,
  shouldShowPlanSkippedNotice,
} from './plan-actions';
import type { AssistantDialogSummaryInfo } from './assistant-dialog';
import type { StreamingPresentation } from './streaming-presentation';
import type { AssistantRetryState } from './assistant-retry';

const HOVER_INTENT_DELAY_MS = 300;

export type MessageRowSharedProps = {
  sessionPauseMap?: ReadonlyMap<string, SessionPause>;
  presentation?: StreamingPresentation;
  modelChangeMap: Map<string, ModelChangeInfo>;
  promptNumberMap: ReadonlyMap<string, number>;
  promptNumberLabels?: ReadonlyMap<string, string>;
  steeringMessageIds?: ReadonlySet<string>;
  promptGroupFirstMessageIds?: ReadonlyMap<string, string>;
  messagePromptGroupIds?: ReadonlyMap<string, string>;
  hoveredTurnId?: string | null;
  onTurnHoverChange?: (messageId: string, hovering: boolean) => void;
  onResponseHoverChange?: (messageId: string, hovering: boolean) => void;
  showPromptNumbers: boolean;
  showSentTimestamps: boolean;
  revealedSentTimestampMessageId?: string | null;
  revealedWorkedSummaryPromptMessageId?: string | null;
  showWorkedSummaryTimes?: boolean;
  suppressTimestampAnimations?: boolean;
  lastAssistantID: string | null;
  errorActionMessageID?: string | null;
  assistantRetryStates?: ReadonlyMap<string, AssistantRetryState>;
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
  onAssistantDiffLoadStart?: () => (() => void) | undefined;
  onAssistantDiffSummaryRetire?: (messageId: string, retire: () => void) => void;
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
  return (
    <For each={props.messages}>
      {(msg, index) => (
        <MessageRow
          msg={msg}
          userMessageSeriesEndId={getUserMessageSeriesEndId(props.messages, index())}
          {...props}
        />
      )}
    </For>
  );
}

export function getUserMessageSeriesEndId(
  messages: readonly MessageEntry[],
  index: number
): string | undefined {
  if (messages[index]?.info.role !== 'user') return undefined;
  let endIndex = index;
  while (messages[endIndex + 1]?.info.role === 'user') endIndex += 1;
  return messages[endIndex]!.info.id;
}

// Mount point for the relocated composer while this row's message is edited.
function InlineEditComposerSlot() {
  let slotRef: HTMLDivElement | undefined;

  onSettled(() => {
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
    userMessageSeriesEndId?: string;
    followsVisibleUserRequest?: boolean;
    followsVisibleAssistantResponse?: boolean;
    followsBorderedBlock?: boolean;
    continuesVisibleActivityGroup?: boolean;
  } & MessageRowSharedProps
) {
  let rowRef: HTMLDivElement | undefined;
  let disposeEntrance: (() => void) | undefined;
  // Rows are keyed by message ID, and the entrance is claimed and decided once when the row
  // mounts. Later part or role changes must not replay or cancel an entrance already started.
  const { messageId, animateEntrance, allowInitialAssistantItemReveal } = untrack(() => {
    const id = props.msg.info.id;
    const claimed = props.claimMessageEntrance?.(id) ?? false;
    const hasImage = props.msg.parts.some(
      (part) => part.type === 'file' && part.mime.startsWith('image/')
    );
    const animate = claimed && !hasImage && props.msg.info.role !== 'user';
    return {
      messageId: id,
      animateEntrance: animate,
      allowInitialAssistantItemReveal: animate || props.msg.parts.length === 0,
    };
  });
  const isTurnHovered = () =>
    !!props.hoveredTurnId && props.messagePromptGroupIds?.get(messageId) === props.hoveredTurnId;
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
  createRenderEffect(
    () => !!summary(),
    (hasSummary, hadSummary) => {
      if (hadSummary && !hasSummary) {
        untrack(() => {
          if (!editingMessage()) return;
          const element = rowRef?.querySelector<HTMLElement>('.assistant-dialog-summary');
          // Reconciliation hides Worked before replacing history. Reserve its lost range
          // before the DOM shrinks, without handing scrolling back to bottom follow.
          if (element) prepareForMessageBlockRemoval(element);
        });
      }
    }
  );
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

  onSettled(() => {
    if (rowRef && animateEntrance) {
      disposeEntrance = prepareMeasuredEntrance(rowRef, {
        animationName: 'streamed-message-row-in',
        heightProperty: '--streamed-message-row-height',
        onFinish: () => setEntrancePending(false),
      });
    }
    if (rowRef) props.observeMeasuredRow?.(rowRef, messageId, true);
  });
  createEffect(isVirtualPlaceholder, (virtualPlaceholder, wasVirtualPlaceholder) => {
    if (wasVirtualPlaceholder && !virtualPlaceholder) {
      // Let Solid publish the hydrated class/content before measuring the row's real geometry.
      queueMicrotask(() => {
        if (rowRef?.isConnected && !isVirtualPlaceholder()) {
          props.observeMeasuredRow?.(rowRef, messageId, true);
        }
      });
    }
  });
  onCleanup(() => {
    disposeEntrance?.();
    props.onTurnHoverChange?.(messageId, false);
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
        projectAutomaticActionMessage(props.msg).info.role === 'user'
          ? 'interactive-request'
          : 'interactive-response'
      } ${isTurnHovered() ? 'interactive-item-turn-hovered ' : ''}${entrancePending() ? 'interactive-item-entering' : ''}${isAbandonedByEdit() ? ' interactive-item-edit-abandoned' : ''}${
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
                    <span>From: </span>
                    <span>
                      <FormattedModelName name={change().from} showFastTooltip={false} />
                    </span>
                    <span>To: </span>
                    <span>
                      <FormattedModelName name={change().to} showFastTooltip={false} />
                    </span>
                  </div>
                }
              >
                <span class="model-change-label" tabindex="0">
                  <span class="model-change-normal">
                    <FormattedModelName name={change().normalFrom} showFastTooltip={false} />
                    {' → '}
                    <FormattedModelName name={change().normalTo} showFastTooltip={false} />
                  </span>
                  <span class="model-change-narrow">
                    <FormattedModelName name={change().narrowFrom} showFastTooltip={false} />
                    {' → '}
                    <FormattedModelName name={change().narrowTo} showFastTooltip={false} />
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
            steering={props.steeringMessageIds?.has(props.msg.info.id)}
            promptNumber={
              props.promptNumberLabels?.get(props.msg.info.id) ??
              props.promptNumberMap.get(props.msg.info.id)
            }
            promptContinuation={
              !!props.promptGroupFirstMessageIds?.has(props.msg.info.id) &&
              props.promptGroupFirstMessageIds.get(props.msg.info.id) !== props.msg.info.id
            }
            showPromptNumber={props.showPromptNumbers}
            showSentTimestamp={
              props.showSentTimestamps || props.revealedSentTimestampMessageId === props.msg.info.id
            }
            userMessageSeriesEndId={props.userMessageSeriesEndId}
            onAssistantDiffSettledEmpty={props.onAssistantDiffSettledEmpty}
            onAssistantDiffLoadStart={props.onAssistantDiffLoadStart}
            onAssistantDiffSummaryRetire={props.onAssistantDiffSummaryRetire}
            onUserMessageHoverChange={props.onUserMessageHoverChange}
            onTurnHoverChange={props.onTurnHoverChange}
            onResponseHoverChange={props.onResponseHoverChange}
            suppressTimestampAnimation={props.suppressTimestampAnimations}
            isLastAssistant={props.msg.info.id === props.lastAssistantID}
            hideErrorAction={
              props.errorActionMessageID !== undefined &&
              props.msg.info.id !== props.errorActionMessageID
            }
            retryState={props.assistantRetryStates?.get(props.msg.info.id)}
            nearViewport={props.nearViewport}
            outerListVirtualized={props.outerListVirtualized}
            highlightFinalAnswer={highlightFinalAnswer()}
            highlightPlanningAnswer={highlightPlanningAnswer()}
            previousTrailingFileEventSignature={
              props.previousTrailingFileEventSignatureMap.get(props.msg.info.id) ?? null
            }
            streamingPartId={streamingPartId()}
            streamingText={streamingText()}
            presentation={props.presentation}
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
              pause={props.sessionPauseMap?.get(props.msg.info.id)}
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
        <Show when={!summary() && props.sessionPauseMap?.get(props.msg.info.id)}>
          {(pause) => <SessionPauseDivider pause={pause()} />}
        </Show>
      </Show>
    </div>
  );
}

export function AssistantDialogSummaryForMessage(
  props: {
    summary: AssistantDialogSummaryInfo;
    pause?: SessionPause;
    msg: MessageEntry;
    showCompletedTime?: boolean;
    suppressTimestampAnimation?: boolean;
  } & Pick<
    MessageRowSharedProps,
    'hasBuildAgent' | 'latestPlanImplementationMessageId' | 'onWorkedSummaryHoverChange'
  >
) {
  // Only rows that show plan actions need the turn count over the transcript.
  const canOpenSummarizedPlan = createMemo(() => {
    const info = props.msg.info;
    if (
      !shouldShowPlanImplementationAction({
        hasBuildAgent: props.hasBuildAgent,
        info,
        latestPlanImplementationMessageId: props.latestPlanImplementationMessageId,
      }) &&
      !shouldShowPlanSkippedNotice({
        info,
        latestPlanImplementationMessageId: props.latestPlanImplementationMessageId,
      })
    ) {
      return false;
    }
    return (
      countPlanningTurns(info.sessionID, state.messages) > 1 && canSummarizePlan(info.sessionID)
    );
  });
  return (
    <AssistantDialogSummary
      summary={props.summary}
      pause={props.pause}
      messageId={props.msg.info.id}
      showImplementPlanAction={shouldShowPlanImplementationAction({
        hasBuildAgent: props.hasBuildAgent,
        info: props.msg.info,
        latestPlanImplementationMessageId: props.latestPlanImplementationMessageId,
      })}
      showPlanSkippedNotice={shouldShowPlanSkippedNotice({
        info: props.msg.info,
        latestPlanImplementationMessageId: props.latestPlanImplementationMessageId,
      })}
      hasBuildAgent={props.hasBuildAgent}
      onImplementPlan={() =>
        void implementPlan(buildPlanImplementationPrompt(props.msg.parts), props.msg.info.sessionID)
      }
      onDraftImplementPlan={() =>
        requestPlanImplementationDraft(
          props.msg.info.sessionID,
          buildPlanImplementationPrompt(props.msg.parts)
        )
      }
      onImplementPlanInNewChat={async () => {
        const sessionId = props.msg.info.sessionID;
        // One planning turn is its own plan; later turns revise it, so summarize those.
        const plan = await resolvePlanContent(sessionId, buildPlanDocumentContent(props.msg.parts));
        skipPlanSession(sessionId);
        startNewChatDraft();
        recordPlanHandoff(props.msg.info.id);
        requestPlanImplementationDraft(
          null,
          buildLinkedPlanImplementationPrompt(sessionId),
          plan ? { name: `plan-${crypto.randomUUID().slice(0, 8)}.md`, text: plan } : undefined
        );
      }}
      onOpenPlan={() =>
        void openPlan(buildPlanDocumentContent(props.msg.parts), props.msg.info.sessionID)
      }
      onOpenSummarizedPlan={
        canOpenSummarizedPlan()
          ? async () => {
              const sessionId = props.msg.info.sessionID;
              await openPlan(await summarizePlanSession(sessionId), sessionId);
            }
          : undefined
      }
      onSkipPlan={() => skipPlanSession(props.msg.info.sessionID)}
      planHandedOff={isPlanHandedOff(props.msg.info.id)}
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

type PlanMenuItem = { label: string; onSelect: () => void };

/** A plan action button, joined to a chevron menu when it has alternatives. */
function SplitPlanAction(props: {
  variant: 'open' | 'implement';
  label: string;
  busy: boolean;
  disabled: boolean;
  menuLabel: string;
  moreLabel: string;
  items: PlanMenuItem[];
  onClick: () => void;
}) {
  const [menu, setMenu] = createSignal<{ x: number; y: number } | null>(null);
  const buttonClass = () =>
    `assistant-dialog-summary-action assistant-dialog-summary-action-${props.variant} question-btn`;
  return (
    <span class="assistant-dialog-summary-split" data-menu-open={menu() ? 'true' : undefined}>
      <button
        type="button"
        class={buttonClass()}
        disabled={props.disabled}
        aria-busy={props.busy ? 'true' : undefined}
        onClick={() => props.onClick()}
      >
        <span>{props.busy ? 'Summarizing…' : props.label}</span>
      </button>
      <Show when={props.items.length > 0}>
        <button
          type="button"
          class={`${buttonClass()} assistant-dialog-summary-action-more`}
          aria-label={props.moreLabel}
          aria-haspopup="menu"
          aria-expanded={ariaBoolean(!!menu())}
          disabled={props.disabled}
          onClick={(event) => {
            // Align under the whole split control, not just the chevron.
            const control = event.currentTarget.parentElement ?? event.currentTarget;
            const rect = control.getBoundingClientRect();
            setMenu((current) => (current ? null : { x: rect.left, y: rect.bottom + 4 }));
          }}
        >
          <UiIcon source={navArrowDownIcon} width={10} height={10} aria-hidden="true" />
        </button>
      </Show>
      <Show when={menu()} keyed>
        {(position) => (
          <Portal>
            <ActionsMenu
              x={position.x}
              y={position.y}
              label={props.menuLabel}
              onClose={() => setMenu(null)}
              items={props.items.map((item) => ({
                label: item.label,
                onSelect: () => {
                  setMenu(null);
                  item.onSelect();
                },
              }))}
            />
          </Portal>
        )}
      </Show>
    </span>
  );
}

function OpenAndImplementPlanButtons(props: {
  /** False once the plan's implementation moved to another chat. */
  showImplement?: boolean;
  onOpenPlan?: () => void;
  onOpenSummarizedPlan?: () => Promise<void>;
  onImplementPlan?: () => void;
  onDraftImplementPlan?: () => void;
  onImplementPlanInNewChat?: () => Promise<void>;
}) {
  const [busy, setBusy] = createSignal<'open' | 'implement' | null>(null);
  // Summaries take seconds; one at a time keeps the plan actions unambiguous.
  const run = async (kind: 'open' | 'implement', action: () => Promise<void>) => {
    if (busy()) return;
    setBusy(kind);
    try {
      await action();
    } catch (cause) {
      showSessionActionFeedback(
        `Could not summarize the plan: ${cause instanceof Error ? cause.message : String(cause)}`,
        'warning'
      );
    } finally {
      setBusy(null);
    }
  };
  const disabled = () => isLoading() || busy() !== null;
  const openItems = (): PlanMenuItem[] => {
    const summarize = props.onOpenSummarizedPlan;
    return summarize
      ? [
          {
            label: 'Open summarized',
            onSelect: () => void run('open', summarize),
          },
        ]
      : [];
  };
  const implementItems = (): PlanMenuItem[] => {
    const items: PlanMenuItem[] = [];
    const draft = props.onDraftImplementPlan;
    if (draft) {
      items.push({
        label: 'Edit before implementing',
        onSelect: draft,
      });
    }
    const newChat = props.onImplementPlanInNewChat;
    if (newChat) {
      items.push({
        label: 'Implement in new chat',
        onSelect: () => void run('implement', newChat),
      });
    }
    return items;
  };
  return (
    <>
      <SplitPlanAction
        variant="open"
        label="Open plan"
        busy={busy() === 'open'}
        disabled={disabled()}
        menuLabel="Open plan options"
        moreLabel="More ways to open the plan"
        items={openItems()}
        onClick={() => props.onOpenPlan?.()}
      />
      <Show when={props.showImplement !== false}>
        <SplitPlanAction
          variant="implement"
          label="Implement the plan"
          busy={busy() === 'implement'}
          disabled={disabled()}
          menuLabel="Implement the plan options"
          moreLabel="More ways to implement the plan"
          items={implementItems()}
          onClick={() => props.onImplementPlan?.()}
        />
      </Show>
    </>
  );
}

function AssistantDialogSummary(props: {
  summary: AssistantDialogSummaryInfo;
  pause?: SessionPause;
  messageId: string;
  showImplementPlanAction?: boolean;
  showPlanSkippedNotice?: boolean;
  hasBuildAgent?: boolean;
  onOpenPlan?: () => void;
  onImplementPlan?: () => void;
  onDraftImplementPlan?: () => void;
  onImplementPlanInNewChat?: () => Promise<void>;
  onOpenSummarizedPlan?: () => Promise<void>;
  planHandedOff?: boolean;
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
      ? `↑ ${formatNumber(props.summary.inputTokens)} ↓ ${formatNumber(props.summary.outputTokens)}`
      : '';
  const agentSuffix = () =>
    props.summary.agentCount > 0 ? `Agents ${formatNumber(props.summary.agentCount)}` : '';
  const tokensPerSecond = () => {
    const value = props.summary.tokensPerSecond;
    return value !== undefined && Number.isFinite(value) && value > 0
      ? `${value.toFixed(0)} tok/s`
      : '';
  };
  const statusSuffix = () =>
    props.summary.permissionRejected
      ? 'Permission rejected'
      : props.summary.questionSkipped
        ? 'Question skipped'
        : '';
  const hasCompletedSummary = () => !props.summary.collectingStats;
  const completedTime = () =>
    hasCompletedSummary() && props.summary.completedAt !== undefined
      ? formatMessageSentTime(props.summary.completedAt)
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
  onSettled(() => {
    const cleanups: Array<() => void> = [];

    if (!summaryRef)
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };
    const messageRow = summaryRef.closest<HTMLElement>('[data-msg-id]');
    const summaryRow = summaryRef.closest<HTMLElement>('.trailing-assistant-summary-row');
    const hoverRoot =
      messageRow ?? summaryRef.closest<HTMLElement>('.interactive-list-track') ?? summaryRef;
    const isInHoverRegion = (target: EventTarget | null) => {
      if (!(target instanceof Element) || !hoverRoot.contains(target)) return false;
      // Plan actions are their own controls; hovering them is not hovering the turn.
      if (
        target.closest('.assistant-dialog-summary-actions, .assistant-dialog-summary-plan-skipped')
      )
        return false;
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
    cleanups.push(() => {
      hoverRoot.removeEventListener('mouseover', onMouseOver);
      hoverRoot.removeEventListener('mouseout', onMouseOut);
    });

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
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
      class={`model-change-indicator assistant-dialog-summary${props.pause ? ' session-pause-divider' : ''}${props.showCompletedTime || isHoverIntentActive() ? ' is-completion-time-visible' : ''}${isHoverIntentActive() ? ' is-hover-intent-active' : ''}`}
      data-prompt-msg-id={props.summary.promptMessageId}
      data-resumed={props.pause?.resumed}
    >
      <div class="assistant-dialog-summary-content">
        <Show when={completedTime()}>
          {(time) => (
            <time
              class={`assistant-dialog-summary-completed-time${props.suppressTimestampAnimation ? ' is-animation-suppressed' : ''}`}
              datetime={new Date(props.summary.completedAt!).toISOString()}
            >
              <span class="assistant-dialog-summary-completed-time-text">{time()}</span>
            </time>
          )}
        </Show>
        <span class="model-change-label">
          <Show
            when={!props.pause}
            fallback={props.pause?.resumed ? 'Paused and resumed' : 'Paused'}
          >
            <Show
              when={!props.summary.interrupted && !props.summary.collectingStats}
              fallback={props.summary.interrupted ? 'Interrupted' : 'Collecting stats...'}
            >
              <Show when={statusSuffix()}>
                {(status) => (
                  <>
                    <span class="assistant-dialog-summary-status">{status()}</span>{' '}
                  </>
                )}
              </Show>
              <span class="assistant-dialog-summary-metric">
                <UiIcon source={clockIcon} width="12" height="12" aria-label="Worked for" />
                {formatTurnDuration(props.summary.durationMs)}
              </span>
              <Show when={tokenSuffix()}>
                {(tokens) => (
                  <>
                    {' '}
                    <span class="assistant-dialog-summary-metric assistant-dialog-summary-token-budget">
                      <UiIcon source={coinsIcon} width="12" height="12" aria-label="Tokens" />
                      {tokens()}
                    </span>
                  </>
                )}
              </Show>
              <Show when={formatTurnCost(props.summary.cost)}>
                {(cost) => (
                  <>
                    {' '}
                    <span
                      class="assistant-dialog-summary-metric assistant-dialog-summary-cost"
                      aria-label="Turn cost including subagents"
                    >
                      <UiIcon
                        source={dollarCircleIcon}
                        width="12"
                        height="12"
                        aria-label="US dollars"
                      />
                      {cost()}
                    </span>
                  </>
                )}
              </Show>
              <Show when={tokensPerSecond()}>
                {(speed) => (
                  <>
                    {' '}
                    <span
                      class="assistant-dialog-summary-metric assistant-dialog-summary-tps"
                      title="Estimated generation speed from server-observed text and reasoning boundaries, not exact provider token timing. Excludes initial latency, tool-call responses, and subagents."
                    >
                      <UiIcon
                        source={dashboardDotsIcon}
                        width="12"
                        height="12"
                        aria-label="Tokens per second"
                      />
                      {speed()}
                    </span>
                  </>
                )}
              </Show>
              <Show when={agentSuffix()}>
                {(agents) => (
                  <>
                    {' '}
                    <span>{agents()}</span>
                  </>
                )}
              </Show>
            </Show>
          </Show>
        </span>
        <div class="assistant-dialog-summary-turn-actions">
          <Show when={props.pause}>{(pause) => <SessionResumeButton pause={pause()} />}</Show>
          <Show when={!props.summary.interrupted && !props.pause && props.copyText}>
            <Tooltip content={copied() ? 'Copied' : 'Copy final response'} delay={500}>
              <button
                type="button"

                class={[
                  'assistant-dialog-summary-turn-action assistant-dialog-summary-copy',
                  { 'is-copied': copied() },
                ]}
                aria-label={copied() ? 'Copied final response' : 'Copy final response'}
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
          </Show>
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
          <OpenAndImplementPlanButtons
            onOpenPlan={props.onOpenPlan}
            onImplementPlan={props.onImplementPlan}
            onDraftImplementPlan={props.onDraftImplementPlan}
            onImplementPlanInNewChat={props.onImplementPlanInNewChat}
            onOpenSummarizedPlan={props.onOpenSummarizedPlan}
          />
          <button
            type="button"
            class="assistant-dialog-summary-action assistant-dialog-summary-action-skip question-btn"
            onClick={() => props.onSkipPlan?.()}
          >
            <span>Skip for now</span>
          </button>
        </div>
      </Show>
      <Show when={props.showPlanSkippedNotice}>
        <div
          class="assistant-dialog-summary-plan-skipped"
          tabindex={props.hasBuildAgent ? 0 : undefined}
        >
          <span class="assistant-dialog-summary-plan-skipped-label" role="status">
            <UiIcon
              source={props.planHandedOff ? triangleFlagIcon : xmarkCircleIcon}
              width={14}
              height={14}
            />
            <span class="assistant-dialog-summary-plan-skipped-text">
              {props.planHandedOff ? 'Side implementation' : 'Plan skipped'}
            </span>
          </span>
          <Show when={props.hasBuildAgent}>
            <div class="assistant-dialog-summary-plan-skipped-actions">
              <OpenAndImplementPlanButtons
                showImplement={!props.planHandedOff}
                onOpenPlan={props.onOpenPlan}
                onImplementPlan={props.onImplementPlan}
                onDraftImplementPlan={props.onDraftImplementPlan}
                onImplementPlanInNewChat={props.onImplementPlanInNewChat}
                onOpenSummarizedPlan={props.onOpenSummarizedPlan}
              />
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
