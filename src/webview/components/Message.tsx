import { Show, createMemo, createResource } from 'solid-js';
import { retryMessage } from '../hooks/useOpenCode';
import { isAbortedAssistantError } from '../lib/aborted';
import { client } from '../lib/client';
import { collapseLeadingDuplicateFileEvents } from '../lib/message-event-collapse';
import { getAssistantDiffRequest, isAssistantMessage } from '../lib/message-metrics';
import { isWorkspaceDirectoryText, shouldShowAssistantPartInline } from '../lib/part-utils';
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
  getUserMessagePreviewText,
  parseUserMessageContent,
  type ParsedUserMessageContent,
} from './message/UserMessageContent';

export {
  calculateAssistantPartVirtualRange,
  getAssistantContainerVariant,
  stripCompactionBoundaryMarkdown,
} from './message/AssistantMessageContent';
export { getUserMessagePreviewText, parseUserMessageContent } from './message/UserMessageContent';
export type { AssistantFileEditStackGroup } from './message/AssistantMessageContent';
export type { ParsedUserMessageContent } from './message/UserMessageContent';

export function Message(props: {
  info: MessageType;
  parts: Part[];
  isLastAssistant?: boolean;
  outerListVirtualized?: boolean;
  highlightFinalAnswer?: boolean;
  highlightPlanningAnswer?: boolean;
  previousTrailingFileEventSignature?: string | null;
  fileEditStackGroup?: AssistantFileEditStackGroup | null;
  streamingPartId?: string | null;
  streamingText?: string;
  questionRequestForTool?: (part: ToolPart) => QuestionRequest | null;
  permissionMatchForTool?: (part: ToolPart) => ToolCallPermissionMatch | null;
}) {
  const isUser = () => props.info.role === 'user';
  const assistant = () => (isAssistantMessage(props.info) ? props.info : null);
  const assistantErrorMessage = createMemo(() => {
    const error = assistant()?.error;
    if (isAbortedAssistantError(error)) return null;
    const message = error?.data?.message?.trim();
    if (message) return message;
    const name = error?.name?.trim();
    return name || null;
  });
  const canRetryAssistant = createMemo(() => {
    const error = assistant()?.error;
    return !!error && !isAbortedAssistantError(error);
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
    return client.session.diff(sessionID, messageID).catch(() => [] as FileDiff[]);
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
    return hasOtherVisibleContent ? null : compactions[compactions.length - 1];
  });
  const shouldRender = () =>
    !!compactionDivider() ||
    isUser() ||
    !!assistantErrorMessage() ||
    visibleAssistantParts().length > 0 ||
    visibleDiffs().length > 0;
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
            }`}
          >
            <Show when={isUser()}>
              <UserMessageContent parts={normalizedParts()} />
            </Show>
            <Show when={!isUser() && assistant()}>
              <AssistantMessageContent
                info={assistant() as AssistantMessage}
                parts={visibleAssistantParts()}
                errorMessage={assistantErrorMessage()}
                onRetry={
                  (props.isLastAssistant ?? false) && canRetryAssistant()
                    ? () => void retryMessage(assistant()!.id, assistant()!.sessionID)
                    : undefined
                }
                highlightFinalAnswer={props.highlightFinalAnswer}
                highlightPlanningAnswer={props.highlightPlanningAnswer}
                suppressHighlightedCardMetaParts={
                  !!props.highlightFinalAnswer && assistantContainerVariant() !== 'plain'
                }
                isLastAssistant={props.isLastAssistant}
                outerListVirtualized={props.outerListVirtualized}
                textForPart={getEffectivePartText}
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
