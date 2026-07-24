import { Show, createMemo, createResource } from 'solid-js';
import { friendlyErrorName, isAbortedAssistantError } from '../../shared/error-classification';
import { retryMessage } from '../hooks/useOpenCode';
import { client } from '../lib/client';
import { editingMessageId, startEditingMessage } from '../lib/message-edit-state';
import { collapseLeadingDuplicateFileEvents } from '../lib/message-event-collapse';
import { getAssistantDiffRequest, isAssistantMessage } from '../lib/message-metrics';
import { isWorkspaceDirectoryText, shouldShowAssistantPartInline } from '../lib/part-utils';
import { openProviderSetup } from '../lib/provider-setup';
import { getActiveUsageLimitNotice, isActiveSessionWorking, state } from '../lib/state';
import { parseUsageLimitNotice } from '../lib/usage-limit';
import type { ToolCallPermissionMatch } from '../lib/tool-call-matching';
import type {
  AssistantMessage,
  CompactionPart,
  FileDiff,
  Message as MessageType,
  Part,
  QuestionRequest,
  ToolPart,
} from '../types';
import {
  AssistantMessageContent,
  deduplicateFileEdits,
  getAssistantContainerVariant,
  stripCompactionBoundaryMarkdown,
  type AssistantFileEditStackGroup,
} from './message/AssistantMessageContent';
import { CompactionDivider } from './message/CompactionDivider';
import { DiffSummary } from './message/DiffSummary';
import {
  UserMessageContent,
  getUserMessageEditContext,
  getUserMessageEditText,
  hasUserMessageEditableContent,
  parseUserMessageContent,
} from './message/UserMessageContent';

const AUTH_INVALIDATED_RE = /authentication token has been invalidated|try signing in again/i;

export {
  getAssistantContainerVariant,
  stripCompactionBoundaryMarkdown,
} from './message/AssistantMessageContent';
export {
  getUserMessageEditText,
  getUserMessageEditContext,
  getUserMessagePreviewText,
  hasUserMessageEditableContent,
  parseUserMessageContent,
} from './message/UserMessageContent';
export type { AssistantFileEditStackGroup } from './message/AssistantMessageContent';
export type { ParsedUserMessageContent } from './message/UserMessageContent';

export function Message(props: {
  info: MessageType;
  parts: Part[];
  isLastAssistant?: boolean;
  nearViewport?: boolean;
  outerListVirtualized?: boolean;
  highlightFinalAnswer?: boolean;
  highlightPlanningAnswer?: boolean;
  previousTrailingFileEventSignature?: string | null;
  fileEditStackGroup?: AssistantFileEditStackGroup | null;
  streamingPartId?: string | null;
  streamingText?: string;
  claimAssistantItemReveal?: (messageId: string, renderKey: string) => boolean;
  questionRequestForTool?: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool?: (part: ToolPart) => ToolCallPermissionMatch | null;
}) {
  const isUser = () => props.info.role === 'user';
  const assistant = () => (isAssistantMessage(props.info) ? props.info : null);
  // While the composer's usage-limit banner is up for this session, the latest
  // assistant 429 error card would repeat the same message and actions; hide it
  // until the banner clears.
  const coveredByUsageLimitBanner = createMemo(() => {
    if (!(props.isLastAssistant ?? false)) return false;
    const error = assistant()?.error;
    if (!error || isAbortedAssistantError(error)) return false;
    if (!parseUsageLimitNotice(error.data?.message || error.name)) return false;
    return !!getActiveUsageLimitNotice(props.info.sessionID);
  });
  const assistantErrorMessage = createMemo(() => {
    const error = assistant()?.error;
    if (isAbortedAssistantError(error)) return null;
    if (coveredByUsageLimitBanner()) return null;
    const message = error?.data?.message?.trim();
    if (message) return message;
    return friendlyErrorName(error?.name);
  });
  const canRetryAssistant = createMemo(() => {
    const error = assistant()?.error;
    return !!error && !isAbortedAssistantError(error);
  });
  const shouldConnectProvider = createMemo(() => {
    const error = assistant()?.error;
    if (!error || isAbortedAssistantError(error)) return false;
    if (error.name !== 'ProviderAuthError') return false;
    return AUTH_INVALIDATED_RE.test(error.data?.message || '');
  });
  const assistantErrorAction = createMemo(() => {
    if (!(props.isLastAssistant ?? false) || !canRetryAssistant()) return undefined;
    if (shouldConnectProvider()) {
      return { label: 'Connect provider', run: openProviderSetup };
    }

    return {
      label: 'Retry',
      run: () => void retryMessage(assistant()!.id, assistant()!.sessionID),
    };
  });
  const isSubagent = () => assistant()?.mode === 'subagent';
  const normalizedParts = createMemo(() =>
    assistant()
      ? collapseLeadingDuplicateFileEvents(
          props.parts,
          props.previousTrailingFileEventSignature ?? null
        )
      : props.parts
  );
  const isCompactedSummaryMessage = createMemo(
    () => !!assistant()?.summary || normalizedParts().some((part) => part.type === 'compaction')
  );
  const getEffectivePartText = (part: Part) => {
    if (part.type !== 'text' && part.type !== 'reasoning') return null;

    const text = part.id === props.streamingPartId ? props.streamingText || part.text : part.text;
    return isCompactedSummaryMessage() ? stripCompactionBoundaryMarkdown(text) : text;
  };
  const visibleAssistantParts = createMemo(() =>
    assistant()
      ? normalizedParts().filter((part) => {
          if (part.type === 'text') {
            const effectiveText = getEffectivePartText(part) || '';
            return effectiveText.trim().length > 0 && !isWorkspaceDirectoryText(effectiveText);
          }
          return shouldShowAssistantPartInline(part);
        })
      : normalizedParts()
  );
  const layoutAssistantParts = createMemo(() =>
    assistant() ? deduplicateFileEdits(visibleAssistantParts()) : []
  );
  const diffRequest = createMemo(() => {
    if (assistantErrorMessage()) return null;
    const request = getAssistantDiffRequest(props.info, props.isLastAssistant ?? false);
    return request ? `${request.sessionID}\u0000${request.messageID}` : null;
  });

  const [diffs] = createResource(diffRequest, async (requestKey) => {
    const [sessionID, messageID] = requestKey.split('\u0000');
    return client.session.diff(sessionID!, messageID!).catch(() => [] as FileDiff[]);
  });
  const visibleDiffs = createMemo(() => (diffRequest() ? diffs() || [] : []));
  const compactionDivider = createMemo<CompactionPart | null>(() => {
    const parts = normalizedParts();
    const compactions = parts.filter((part): part is CompactionPart => part.type === 'compaction');
    if (compactions.length === 0) return null;
    const hasOtherVisibleContent = parts.some((part) => {
      if (part.type === 'compaction') return false;
      if (part.type === 'text') return (getEffectivePartText(part) || '').trim().length > 0;
      if (part.type === 'file') return true;
      return false;
    });
    return hasOtherVisibleContent ? null : compactions[compactions.length - 1]!;
  });
  const shouldRender = () => {
    if (compactionDivider()) return true;
    if (isUser()) return hasUserContent();
    return (
      !!assistantErrorMessage() || visibleAssistantParts().length > 0 || visibleDiffs().length > 0
    );
  };
  const hasStructuredAssistantParts = () =>
    assistant()
      ? visibleAssistantParts().some((part) => part.type !== 'text' && part.type !== 'file')
      : false;
  const hasVisibleReasoningPart = () =>
    assistant() ? visibleAssistantParts().some((part) => part.type === 'reasoning') : false;
  const assistantContainerVariant = () => {
    if (props.highlightFinalAnswer && hasVisibleReasoningPart()) {
      return 'plain';
    }

    return getAssistantContainerVariant({
      isUser: isUser(),
      visibleDiffCount: visibleDiffs().length,
      fileEditStackGroup: props.fileEditStackGroup,
      isSubagent: isSubagent(),
      hasStructuredAssistantParts: hasStructuredAssistantParts(),
      layoutParts: layoutAssistantParts(),
      highlightFinalAnswer: !!props.highlightFinalAnswer,
      hasError: !!assistantErrorMessage(),
    });
  };
  const assistantContainerClass = () => {
    const variant = assistantContainerVariant();
    if (variant === 'bare') return 'assistant-turn-content assistant-turn-content-bare';
    if (variant === 'plain') return 'assistant-turn-content assistant-turn-content-plain';
    return `assistant-turn-content${props.highlightFinalAnswer ? ' assistant-turn-content-highlighted' : ''}${props.highlightPlanningAnswer ? ' assistant-turn-content-planning' : ''}`;
  };
  const isWrapperlessAssistant = () => assistantContainerVariant() === 'plain';
  const hasUserContent = createMemo(() => {
    if (!isUser()) return false;
    const parsed = parseUserMessageContent(normalizedParts());
    return (
      parsed.messageTexts.some((text) => text.trim().length > 0) ||
      parsed.attachments.length > 0 ||
      parsed.fileParts.length > 0
    );
  });
  const isEditingUserMessage = () => isUser() && editingMessageId() === props.info.id;
  const canEditUserMessage = () =>
    isUser() &&
    hasUserContent() &&
    props.info.sessionID === state.activeSessionId &&
    !isActiveSessionWorking() &&
    hasUserMessageEditableContent(normalizedParts());
  const handleUserCardClick = (event: MouseEvent) => {
    if (!canEditUserMessage() || isEditingUserMessage()) return;
    const target = event.target;
    if (target instanceof Element && target.closest('button, a, textarea')) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    startEditingMessage(
      props.info.id,
      props.info.sessionID,
      getUserMessageEditText(normalizedParts()),
      getUserMessageEditContext(normalizedParts())
    );
  };

  return (
    <Show when={shouldRender()}>
      <Show
        when={!compactionDivider()}
        fallback={<CompactionDivider part={compactionDivider()!} />}
      >
        <div
          class={`chat-turn ${isUser() ? 'chat-turn-user' : 'chat-turn-assistant'}${isWrapperlessAssistant() ? ' chat-turn-assistant-plain' : ''}`}
        >
          <div
            class={`value chat-turn-content ${
              isUser() ? 'chat-turn-card user-message-card' : assistantContainerClass()
            } ${isSubagent() ? 'chat-turn-subagent' : ''} ${
              props.fileEditStackGroup
                ? `assistant-turn-file-edit-group-${props.fileEditStackGroup}`
                : ''
            }${canEditUserMessage() && !isEditingUserMessage() ? ' user-message-card-editable' : ''}`}
            onClick={handleUserCardClick}
            title={
              canEditUserMessage() && !isEditingUserMessage() ? 'Click to edit message' : undefined
            }
          >
            <Show when={isUser() && hasUserContent()}>
              <UserMessageContent parts={normalizedParts()} />
            </Show>
            <Show when={!isUser() && assistant()}>
              <AssistantMessageContent
                info={assistant() as AssistantMessage}
                parts={visibleAssistantParts()}
                errorMessage={assistantErrorMessage()}
                errorAction={assistantErrorAction()}
                highlightFinalAnswer={props.highlightFinalAnswer}
                highlightPlanningAnswer={props.highlightPlanningAnswer}
                suppressHighlightedCardMetaParts={!!props.highlightFinalAnswer}
                isLastAssistant={props.isLastAssistant}
                nearViewport={props.nearViewport}
                outerListVirtualized={props.outerListVirtualized}
                textForPart={getEffectivePartText}
                claimItemReveal={props.claimAssistantItemReveal}
                questionRequestForTool={props.questionRequestForTool}
                permissionMatchForTool={props.permissionMatchForTool}
              />
            </Show>
          </div>
          <Show when={assistant() && visibleDiffs().length > 0}>
            <DiffSummary diffs={visibleDiffs()} />
          </Show>
        </div>
      </Show>
    </Show>
  );
}
