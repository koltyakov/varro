import { Show, createMemo, createSignal } from 'solid-js';
import { expandThinkingByDefault, getMessageById, state, showThinking } from '../lib/state';
import { formatAgentLabel, formatVariantLabel } from '../lib/format';
import { formatDuration } from '../lib/message-metrics';
import type { AssistantMessage, Part, ReasoningPart, SubtaskPart, TextPart } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ImagePreviewOverlay, createImagePreviewEffect } from './ImagePreview';
import type { PreviewImage } from './ImagePreview';
import { ToolCall } from './ToolCall';
import { formatDisplayPath } from '../lib/path-display';
import { modelSupportsReasoning } from '../lib/model-capabilities';
import { parseUsageLimitNotice } from '../lib/usage-limit';

export function MessagePart(props: {
  part: Part;
  messageInfo?: AssistantMessage;
  streamedText?: string | null;
}) {
  const p = () => props.part;

  const render = () => {
    const part = p();
    switch (part.type) {
      case 'text':
        return <MarkdownRenderer content={props.streamedText ?? (part as TextPart).text} />;
      case 'tool':
        return <ToolCall part={part} />;
      case 'reasoning':
        return (
          <Show when={showThinking()}>
            <ReasoningBlock part={part} messageInfo={props.messageInfo} />
          </Show>
        );
      case 'agent':
        return (
          <div class="chat-subtask-part">
            <div class="subtask-header">
              <span class="subtask-dot" />
              <span>
                Handing off to <span class="subtask-agent-name">{formatAgentLabel(part.name)}</span>
              </span>
            </div>
          </div>
        );
      case 'patch':
        return null;
      case 'retry':
        return <RetryNotice part={part} />;
      case 'compaction':
        return (
          <div class="chat-compaction-notice">
            — context compacted ({part.auto ? 'auto' : 'manual'})
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
  const usageLimit = createMemo(() => parseUsageLimitNotice(props.part.error?.data?.message));

  return (
    <div class={`chat-retry-notice${usageLimit() ? ' usage-limit' : ''}`}>
      <span>↻ Retry attempt {props.part.attempt}</span>
      <Show
        when={usageLimit()}
        fallback={
          <Show when={props.part.error?.data?.message}>
            <span class="chat-retry-error">— {props.part.error!.data.message}</span>
          </Show>
        }
      >
        <span class="chat-retry-error">— usage limit reached</span>
      </Show>
    </div>
  );
}

function ReasoningBlock(props: { part: ReasoningPart; messageInfo?: AssistantMessage }) {
  const [expanded, setExpanded] = createSignal(expandThinkingByDefault());
  const parsedText = createMemo(() => splitReasoningText(props.part.text));
  const isStreaming = () => props.part.time.end === undefined;
  const hasBody = () => parsedText().body.trim().length > 0;
  const detailLabel = () => getReasoningDetailLabel(props.messageInfo);
  const subjectLabel = () => parsedText().subject;
  const headerLabel = () => formatReasoningHeader(subjectLabel(), detailLabel());
  const durationLabel = () => formatReasoningDuration(props.part.time);

  return (
    <div class="chat-thinking-box">
      <button class="thinking-header" onClick={() => setExpanded(!expanded())}>
        <span class="thinking-label">
          <BrainTopicIcon class={isStreaming() ? 'thinking-in-progress' : undefined} />
          <span class={`thinking-label-text${isStreaming() ? ' shimmer-progress' : ''}`}>
            {headerLabel()}
          </span>
        </span>
        <Show when={durationLabel()}>
          <span class="thinking-duration">{durationLabel()}</span>
        </Show>
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
      </button>
      <Show when={expanded() && hasBody()}>
        <div class="thinking-content">
          <div class="thinking-item">
            <div class="thinking-text">{parsedText().body}</div>
          </div>
        </div>
      </Show>
    </div>
  );
}

export function splitReasoningText(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let subjectIndex = 0;

  while (subjectIndex < lines.length && lines[subjectIndex].trim().length === 0) {
    subjectIndex += 1;
  }

  const subjectLine = lines[subjectIndex]?.trim();
  const subjectMatch = subjectLine?.match(/^\*\*(.+?)\*\*$/);
  if (!subjectMatch) return { subject: null, body: text };

  const subject = subjectMatch[1].trim();
  if (!subject) return { subject: null, body: text };

  let bodyStart = subjectIndex + 1;
  while (bodyStart < lines.length && lines[bodyStart].trim().length === 0) {
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
  return formatDuration(time.end - time.start) || null;
}

function BrainTopicIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class ? `thinking-topic-icon ${props.class}` : 'thinking-topic-icon'}
      viewBox="0 0 32 32"
      width="15"
      height="15"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M16,4c-4.963,0-9,4.038-9,9c0,3.186,1.781,5.278,3.212,6.959C11.172,21.085,12,22.059,12,23v5h3v1h2v-1h3v-5c0-0.941,0.828-1.915,1.788-3.041C23.219,18.278,25,16.186,25,13C25,8.038,20.963,4,16,4z M18,26h-4v-2h4V26z M20.265,18.662c-0.923,1.084-1.805,2.12-2.132,3.338h-4.266c-0.327-1.218-1.209-2.254-2.132-3.338C10.391,17.083,9,15.45,9,13c0-3.86,3.141-7,7-7s7,3.14,7,7C23,15.45,21.609,17.083,20.265,18.662z M16,7v2c-2.206,0-4,1.794-4,4h-2C10,9.691,12.691,7,16,7z"
      />
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
  const modelName = provider?.models[messageInfo.modelID]?.name || messageInfo.modelID;
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
            <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
              <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
            </svg>
            <span class="chip-label">{displayName()}</span>
          </div>
        }
      >
        <figure class="chat-image-figure">
          <button
            type="button"
            class="chat-image-preview-trigger"
            aria-label={`Open image preview: ${displayName()}`}
            title="Open image preview"
            onClick={openPreview}
          >
            <img src={props.part.url} alt={displayName()} class="chat-image-img" />
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
