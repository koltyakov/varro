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

export function MessagePart(props: {
  part: Part;
  messageInfo?: AssistantMessage;
  streamedText?: string | null;
  questionRequest?: (typeof state.questions)[number] | null;
  permissionMatch?: ToolCallPermissionMatch | null;
  renderPermissionPrompt?: boolean;
  lightweight?: boolean;
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
          />
        );
      case 'reasoning':
        return (
          <Show when={showThinking()}>
            <ReasoningBlock
              part={part}
              messageInfo={props.messageInfo}
              streamedText={props.streamedText}
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
}) {
  const scrollBottomThreshold = 8;
  const expansionKey = () =>
    `reasoning\u0000${props.part.sessionID}\u0000${props.part.messageID}\u0000${props.part.id}`;
  let currentExpansionKey = expansionKey();
  let contentElement: HTMLDivElement | undefined;
  let autoFollow = true;
  let wasExpanded = false;
  let wasStreaming = props.part.time.end === undefined;
  let followFrameRequest = 0;
  const [expanded, setExpanded] = createSignal(
    getMessageBlockExpanded(currentExpansionKey) ?? false
  );
  const reasoningText = createMemo(() => props.streamedText ?? props.part.text);
  const subjectLabel = createMemo(() => getReasoningSubject(reasoningText()));
  const reasoningBody = createMemo(() => splitReasoningText(reasoningText()).body);
  const bodyText = createMemo(() => (expanded() ? reasoningBody() : ''));
  const isStreaming = () => props.part.time.end === undefined;
  const hasBody = () => hasVisibleReasoningContent(reasoningBody());
  const detailLabel = () => getReasoningDetailLabel(props.messageInfo);
  const headerLabel = () => formatReasoningHeader(subjectLabel(), detailLabel());
  const durationLabel = () => formatReasoningDuration(props.part.time);

  createEffect(() => {
    const nextExpansionKey = expansionKey();
    if (nextExpansionKey === currentExpansionKey) return;
    currentExpansionKey = nextExpansionKey;
    wasExpanded = false;
    autoFollow = true;
    setExpanded(getMessageBlockExpanded(nextExpansionKey) ?? false);
  });

  const followStreamingBottom = () => {
    if (followFrameRequest) cancelAnimationFrame(followFrameRequest);
    const element = contentElement;
    if (!element) return;
    followFrameRequest = requestAnimationFrame(() => {
      followFrameRequest = 0;
      if (autoFollow && element.isConnected) element.scrollTop = element.scrollHeight;
    });
  };

  onCleanup(() => {
    if (followFrameRequest) cancelAnimationFrame(followFrameRequest);
  });

  createEffect(() => {
    const nextExpanded = expanded();
    const nextStreaming = isStreaming();
    reasoningBody();

    if (!nextExpanded || !contentElement) {
      wasExpanded = nextExpanded;
      wasStreaming = nextStreaming;
      return;
    }

    if (!wasExpanded) {
      autoFollow = nextStreaming;
      contentElement.scrollTop = nextStreaming ? contentElement.scrollHeight : 0;
    } else if (wasStreaming && !nextStreaming) {
      if (autoFollow) contentElement.scrollTop = 0;
      autoFollow = false;
    } else if (nextStreaming && autoFollow) {
      // The newest delta's DOM insert lands after this effect run; measure on the next
      // frame so the follow scroll reflects the post-insert height.
      followStreamingBottom();
    }

    wasExpanded = nextExpanded;
    wasStreaming = nextStreaming;
  });

  const handleContentScroll = () => {
    if (!contentElement || !isStreaming()) return;
    const distanceFromBottom =
      contentElement.scrollHeight - contentElement.clientHeight - contentElement.scrollTop;
    autoFollow = distanceFromBottom <= scrollBottomThreshold;
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
          <svg
            class={`thinking-chevron ${expanded() ? 'expanded' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            width="12"
            height="12"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </Show>
      </button>
      <Show when={expanded() && hasBody()}>
        <div
          class="thinking-content"
          ref={(element) => (contentElement = element)}
          onScroll={handleContentScroll}
        >
          <div class="thinking-item">
            <div class="thinking-text">{bodyText()}</div>
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
    <svg
      class={props.class ? `thinking-topic-icon ${props.class}` : 'thinking-topic-icon'}
      viewBox="2 2 20 20"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 18H15" />
      <path d="M10 21H14" />
      <path d="M9.00082 15C9.00098 13 8.50098 12.5 7.50082 11.5C6.50067 10.5 6.02422 9.48689 6.00082 8C5.95284 4.95029 8.00067 3 12.0008 3C16.001 3 18.0488 4.95029 18.0008 8C17.9774 9.48689 17.5007 10.5 16.5008 11.5C15.501 12.5 15.001 13 15.0008 15" />
    </svg>
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
