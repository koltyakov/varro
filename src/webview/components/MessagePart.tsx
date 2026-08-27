import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { getMessageById, state, showThinking } from '../lib/state';
import { formatAgentLabel, formatModelName, formatVariantLabel } from '../lib/format';
import { formatDuration } from '../lib/message-metrics';
import type { AssistantMessage, Part, ReasoningPart, SubtaskPart, TextPart } from '../types';
import type { ToolCallPermissionMatch } from '../lib/tool-call-matching';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ImagePreviewOverlay, createImagePreviewEffect } from './ImagePreview';
import type { PreviewImage } from './ImagePreview';
import { ToolCall } from './ToolCall';
import { formatDisplayPath } from '../lib/path-display';
import { modelSupportsReasoning } from '../lib/model-capabilities';
import { parseUsageLimitNotice, shouldDisplayUsageLimitNotice } from '../lib/usage-limit';
import { hasVisibleReasoningContent } from '../lib/part-utils';
import { getMessageBlockExpanded, setMessageBlockExpanded } from '../lib/tool-call-expansion-state';
import { AgentChip } from './message/AgentChip';
import { InlineMessageImage } from './InlineMessageImage';
import { FileTypeIcon } from './FileTypeIcon';
import { lightBulbIcon, navArrowRightIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

export function MessagePart(props: {
  part: Part;
  messageInfo?: AssistantMessage;
  streamedText?: string | null;
  questionRequest?: (typeof state.questions)[number] | null;
  permissionMatch?: ToolCallPermissionMatch | null;
  renderPermissionPrompt?: boolean;
  lightweight?: boolean;
  compactFileChanges?: boolean;
  expandReasoning?: boolean;
}) {
  const p = () => props.part;

  const render = () => {
    const part = p();
    switch (part.type) {
      case 'text':
        return (
          <MarkdownRenderer
            // SAFETY: The surrounding shape or discriminator check establishes the TextPart contract used below.
            content={props.streamedText ?? (part as TextPart).text}
            cacheByContent={!!props.messageInfo?.time.completed}
            lightweight={props.lightweight}
          />
        );
      case 'tool':
        return (
          <ToolCall
            part={part}
            questionRequest={props.questionRequest}
            permissionMatch={props.permissionMatch}
            renderPermissionPrompt={props.renderPermissionPrompt}
            lightweight={props.lightweight}
            compactFileChanges={props.compactFileChanges}
          />
        );
      case 'reasoning':
        return (
          <Show when={showThinking()}>
            <ReasoningBlock
              part={part}
              messageInfo={props.messageInfo}
              streamedText={props.streamedText}
              expandedByDefault={props.expandReasoning}
            />
          </Show>
        );
      case 'agent':
        return <AgentChip part={part} />;
      case 'patch':
        return null;
      case 'retry':
        return <RetryNotice part={part} />;
      case 'compaction':
        return (
          <div class="chat-compaction-notice">
            - context compacted ({part.auto ? 'auto' : 'manual'})
            <Show when={part.overflow}> after overflow</Show>
          </div>
        );
      case 'subtask':
        return <SubtaskBlock part={part} />;
      case 'step-finish':
        return null;
      case 'file':
        return <FileBlock part={part} />;
      default:
        return null;
    }
  };

  return <>{render()}</>;
}

function RetryNotice(props: { part: Extract<Part, { type: 'retry' }> }) {
  const usageLimit = createMemo(() =>
    parseUsageLimitNotice(props.part.error?.data?.message, { attempt: props.part.attempt })
  );

  return (
    <Show when={!usageLimit() || shouldDisplayUsageLimitNotice(usageLimit()!)}>
      <div class={`chat-retry-notice${usageLimit() ? ' usage-limit' : ''}`}>
        <span>↻ Retry attempt {props.part.attempt}</span>
        <Show
          when={usageLimit()}
          fallback={
            <Show when={props.part.error?.data?.message}>
              <span class="chat-retry-error">- {props.part.error!.data.message}</span>
            </Show>
          }
        >
          <span class="chat-retry-error">- usage limit reached</span>
        </Show>
      </div>
    </Show>
  );
}

function ReasoningBlock(props: {
  part: ReasoningPart;
  messageInfo?: AssistantMessage;
  streamedText?: string | null;
  expandedByDefault?: boolean;
}) {
  const scrollBottomThreshold = 8;
  const streamingScrollSpeed = 42;
  const expansionKey = () =>
    `reasoning\u0000${props.part.sessionID}\u0000${props.part.messageID}\u0000${props.part.id}`;
  const isStreaming = () => props.part.time.end === undefined;
  const isAutoExpansionRequested = () => !!props.expandedByDefault && isStreaming();
  let currentExpansionKey = expansionKey();
  let contentElement: HTMLDivElement | undefined;
  let autoFollow = true;
  let wasExpanded = false;
  let wasStreaming = isStreaming();
  let wasAutoExpansionRequested = isAutoExpansionRequested();
  let followFrameRequest = 0;
  let previousFollowTime: number | null = null;
  let lastAutoScrollTop: number | null = null;
  const [expanded, setExpanded] = createSignal(
    isAutoExpansionRequested() || (getMessageBlockExpanded(currentExpansionKey) ?? false)
  );
  const reasoningText = createMemo(() => props.streamedText ?? props.part.text);
  const subjectLabel = createMemo(() => getReasoningSubject(reasoningText()));
  const reasoningBody = createMemo(() => splitReasoningText(reasoningText()).body);
  const reasoningDescription = createMemo(() => reasoningBody().replace(/\s+/g, ' ').trim());
  const bodyText = createMemo(() => (expanded() ? reasoningBody() : ''));
  const hasBody = () => hasVisibleReasoningContent(reasoningBody());
  const detailLabel = () => getReasoningDetailLabel(props.messageInfo);
  const headerLabel = () =>
    formatReasoningHeader(
      subjectLabel() || (expanded() ? 'Reasoning' : reasoningDescription() || null),
      detailLabel()
    );
  const durationLabel = () => formatReasoningDuration(props.part.time);

  createEffect(() => {
    const nextExpansionKey = expansionKey();
    if (nextExpansionKey === currentExpansionKey) return;
    currentExpansionKey = nextExpansionKey;
    wasExpanded = false;
    autoFollow = true;
    wasAutoExpansionRequested = isAutoExpansionRequested();
    setExpanded(isAutoExpansionRequested() || (getMessageBlockExpanded(nextExpansionKey) ?? false));
  });

  createEffect(() => {
    const autoExpansionRequested = isAutoExpansionRequested();
    if (autoExpansionRequested && !wasAutoExpansionRequested) {
      setExpanded(true);
    } else if (!autoExpansionRequested && wasAutoExpansionRequested) {
      setExpanded(getMessageBlockExpanded(currentExpansionKey) ?? false);
    }
    wasAutoExpansionRequested = autoExpansionRequested;
  });

  const updateOverflowFades = () => {
    const element = contentElement;
    if (!element) return;
    const maxScrollTop = element.scrollHeight - element.clientHeight;
    element.classList.toggle('has-more-above', element.scrollTop > 1);
    element.classList.toggle('has-more-below', element.scrollTop < maxScrollTop - 1);
  };

  const stopStreamingFollow = () => {
    if (followFrameRequest) cancelAnimationFrame(followFrameRequest);
    followFrameRequest = 0;
    previousFollowTime = null;
  };

  const followStreamingBottom = () => {
    if (followFrameRequest) return;
    const advance = (time: number) => {
      followFrameRequest = 0;
      const element = contentElement;
      if (!autoFollow || !isStreaming() || !element?.isConnected) {
        previousFollowTime = null;
        updateOverflowFades();
        return;
      }

      const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (element.scrollTop >= maxScrollTop - 1) {
        previousFollowTime = null;
        updateOverflowFades();
        return;
      }

      const elapsed = previousFollowTime === null ? 16 : Math.min(50, time - previousFollowTime);
      const nextScrollTop = Math.min(
        maxScrollTop,
        element.scrollTop + (streamingScrollSpeed * elapsed) / 1000
      );
      previousFollowTime = time;
      lastAutoScrollTop = nextScrollTop;
      element.scrollTop = nextScrollTop;
      updateOverflowFades();
      followFrameRequest = requestAnimationFrame(advance);
    };
    followFrameRequest = requestAnimationFrame(advance);
  };

  onCleanup(() => {
    stopStreamingFollow();
  });

  createEffect(() => {
    const nextExpanded = expanded();
    const nextStreaming = isStreaming();
    reasoningBody();

    if (!nextExpanded || !contentElement) {
      stopStreamingFollow();
      wasExpanded = nextExpanded;
      wasStreaming = nextStreaming;
      return;
    }

    if (!wasExpanded) {
      autoFollow = nextStreaming;
      contentElement.scrollTop = 0;
      updateOverflowFades();
      if (nextStreaming) followStreamingBottom();
    } else if (wasStreaming && !nextStreaming) {
      stopStreamingFollow();
      if (autoFollow) contentElement.scrollTop = 0;
      autoFollow = false;
      updateOverflowFades();
    } else if (nextStreaming && autoFollow) {
      followStreamingBottom();
      requestAnimationFrame(updateOverflowFades);
    } else {
      requestAnimationFrame(updateOverflowFades);
    }

    wasExpanded = nextExpanded;
    wasStreaming = nextStreaming;
  });

  const handleContentScroll = () => {
    if (!contentElement) return;
    updateOverflowFades();
    if (!isStreaming()) return;
    if (lastAutoScrollTop !== null && Math.abs(contentElement.scrollTop - lastAutoScrollTop) <= 1) {
      lastAutoScrollTop = null;
      return;
    }
    lastAutoScrollTop = null;
    const distanceFromBottom =
      contentElement.scrollHeight - contentElement.clientHeight - contentElement.scrollTop;
    autoFollow = distanceFromBottom <= scrollBottomThreshold;
    if (autoFollow) followStreamingBottom();
    else stopStreamingFollow();
  };

  const toggleExpanded = () => {
    const nextExpanded = !expanded();
    setMessageBlockExpanded(expansionKey(), nextExpanded);
    setExpanded(nextExpanded);
  };

  return (
    <div class="chat-thinking-box">
      <button
        class="thinking-header"
        disabled={!hasBody()}
        aria-expanded={hasBody() ? expanded() : undefined}
        onClick={() => hasBody() && toggleExpanded()}
      >
        <span class="thinking-label">
          <BrainTopicIcon class={isStreaming() ? 'thinking-in-progress' : undefined} />
          <span class={`thinking-label-text${isStreaming() ? ' shimmer-progress' : ''}`}>
            {headerLabel()}
          </span>
        </span>
        <Show when={durationLabel()}>
          <span class="thinking-duration">{durationLabel()}</span>
        </Show>
        <Show when={hasBody()}>
          <UiIcon
            source={navArrowRightIcon}
            class={`thinking-chevron ${expanded() ? 'expanded' : ''}`}
            width="12"
            height="12"
          />
        </Show>
      </button>
      <Show when={expanded() && hasBody()}>
        <div
          class="thinking-content"
          ref={(element) => (contentElement = element)}
          onScroll={handleContentScroll}
        >
          <div class="thinking-item">
            <MarkdownRenderer
              content={bodyText()}
              cacheByContent={!isStreaming()}
              class="thinking-text"
            />
          </div>
        </div>
      </Show>
    </div>
  );
}

function getReasoningSubject(text: string) {
  const normalized = text.replace(/\r\n?/g, '\n');
  let index = 0;

  while (index < normalized.length) {
    const nextBreak = normalized.indexOf('\n', index);
    const lineEnd = nextBreak === -1 ? normalized.length : nextBreak;
    const line = normalized.slice(index, lineEnd).trim();
    if (line.length > 0) {
      const subjectMatch = line.match(/^\*\*(.+?)\*\*$/);
      const subject = subjectMatch?.[1]!.trim();
      return subject || null;
    }
    if (nextBreak === -1) break;
    index = nextBreak + 1;
  }

  return null;
}

export function splitReasoningText(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let subjectIndex = 0;

  while (subjectIndex < lines.length && lines[subjectIndex]!.trim().length === 0) {
    subjectIndex += 1;
  }

  const subjectLine = lines[subjectIndex]?.trim();
  const subjectMatch = subjectLine?.match(/^\*\*(.+?)\*\*$/);
  if (!subjectMatch) return { subject: null, body: text };

  const subject = subjectMatch[1]!.trim();
  if (!subject) return { subject: null, body: text };

  let bodyStart = subjectIndex + 1;
  while (bodyStart < lines.length && lines[bodyStart]!.trim().length === 0) {
    bodyStart += 1;
  }

  return {
    subject,
    body: lines.slice(bodyStart).join('\n'),
  };
}

export function formatReasoningHeader(subject: string | null, detail?: string | null) {
  const parts = [subject || 'Thinking'];
  if (detail) parts.push(detail);
  return parts.join(' · ');
}

export function formatReasoningDuration(time: ReasoningPart['time']) {
  if (time.end === undefined) return null;
  const elapsedMs = time.end - time.start;
  // Sub-second thinking spans are noise in the header; show nothing instead.
  if (elapsedMs < 1000) return null;
  return formatDuration(elapsedMs) || null;
}

function BrainTopicIcon(props: { class?: string }) {
  return (
    <UiIcon
      source={lightBulbIcon}
      class={props.class ? `thinking-topic-icon ${props.class}` : 'thinking-topic-icon'}
      width="12"
      height="12"
      aria-hidden="true"
    />
  );
}

function getReasoningDetailLabel(messageInfo?: AssistantMessage) {
  if (!messageInfo || messageInfo.mode !== 'subagent') return null;

  const parent = getMessageById(messageInfo.parentID)?.info;

  if (!parent || parent.role !== 'assistant') return null;

  const modelChanged =
    parent.providerID !== messageInfo.providerID || parent.modelID !== messageInfo.modelID;
  const variantChanged = (parent.variant || '') !== (messageInfo.variant || '');
  if (!modelChanged && !variantChanged) return null;

  const provider = state.providers.find((item) => item.id === messageInfo.providerID);
  const modelName = formatModelName(
    provider?.models[messageInfo.modelID]?.name || messageInfo.modelID
  );
  const parts: string[] = [];

  if (modelChanged) parts.push(modelName);
  if (messageInfo.variant) parts.push(formatVariantLabel(messageInfo.variant));
  else if (
    variantChanged &&
    !modelSupportsReasoning(messageInfo.providerID, messageInfo.modelID, state.providers)
  ) {
    parts.push('No thinking');
  }

  return parts.length > 0 ? parts.join(' · ') : null;
}

function SubtaskBlock(props: { part: SubtaskPart }) {
  return (
    <div class="chat-subtask-part">
      <div class="subtask-header">
        <div class="subtask-dot" />
        <span>{props.part.description}</span>
      </div>
      <Show when={props.part.agent}>
        <div class="subtask-meta">
          <Show when={props.part.agent}>
            <span>{formatAgentLabel(props.part.agent)}</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function FileBlock(props: { part: Extract<Part, { type: 'file' }> }) {
  const [previewImage, setPreviewImage] = createSignal<PreviewImage | null>(null);
  const isImage = () => props.part.mime.startsWith('image/');
  const displayName = () => {
    if (props.part.source?.path) {
      return formatDisplayPath(props.part.source.path, state.editorContext.workspacePath);
    }
    if (props.part.filename) {
      return formatDisplayPath(props.part.filename, state.editorContext.workspacePath);
    }
    return '(file)';
  };
  const filePath = () => props.part.source?.path || props.part.filename;
  const openPreview = () => {
    setPreviewImage({
      url: props.part.url,
      alt: displayName(),
      title: displayName(),
      mime: props.part.mime,
    });
  };

  createImagePreviewEffect(
    () => previewImage() !== null,
    () => setPreviewImage(null)
  );

  return (
    <>
      <Show
        when={isImage()}
        fallback={
          <div class="chat-attachment-chip">
            <FileTypeIcon path={filePath()} class="chip-icon" />
            <span class="chip-label">{displayName()}</span>
          </div>
        }
      >
        <figure class="chat-image-figure">
          <button
            type="button"
            class="chat-image-preview-trigger"
            aria-label={`Open image preview: ${displayName()}`}
            onClick={openPreview}
          >
            <InlineMessageImage src={props.part.url} alt={displayName()} />
          </button>
          <figcaption class="chat-image-caption">
            {displayName()} <span class="chat-image-mime">· {props.part.mime}</span>
          </figcaption>
        </figure>
      </Show>
      <ImagePreviewOverlay image={previewImage()} onClose={() => setPreviewImage(null)} />
    </>
  );
}
