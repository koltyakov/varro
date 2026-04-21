import { Show, createMemo, createSignal } from 'solid-js';
import { state, showThinking } from '../lib/state';
import { formatAgentLabel, formatVariantLabel } from '../lib/format';
import { formatDuration } from '../lib/message-metrics';
import type { AssistantMessage, Part, ReasoningPart, SubtaskPart, TextPart } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCall } from './ToolCall';
import { formatDisplayPath } from '../lib/path-display';
import { modelSupportsReasoning } from './ModelPicker';

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
        return (
          <div class="chat-retry-notice">
            ↻ Retry attempt {part.attempt}
            <Show when={part.error?.data?.message}>
              <span class="chat-retry-error">— {part.error!.data.message}</span>
            </Show>
          </div>
        );
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

function ReasoningBlock(props: { part: ReasoningPart; messageInfo?: AssistantMessage }) {
  const [expanded, setExpanded] = createSignal(false);
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
          <Show when={subjectLabel()}>
            <BrainTopicIcon class={isStreaming() ? 'thinking-in-progress' : undefined} />
          </Show>
          <span class={`thinking-label-text${isStreaming() ? ' shimmer-progress' : ''}`}>{headerLabel()}</span>
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
        <div class="thinking-content animate-fade-in">
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
        d="M30,13A11,11,0,0,0,19,2H11a9,9,0,0,0-9,9v3a5,5,0,0,0,5,5H8.1A5,5,0,0,0,13,23h1.38l4,7,1.73-1-4-6.89A2,2,0,0,0,14.38,21H13a3,3,0,0,1,0-6h1V13H13a5,5,0,0,0-4.9,4H7a3,3,0,0,1-3-3V12H6A3,3,0,0,0,9,9V8H7V9a1,1,0,0,1-1,1H4.08A7,7,0,0,1,11,4h6V6a1,1,0,0,1-1,1H14V9h2a3,3,0,0,0,3-3V4a9,9,0,0,1,8.05,5H26a3,3,0,0,0-3,3v1h2V12a1,1,0,0,1,1-1h1.77A8.76,8.76,0,0,1,28,13v1a5,5,0,0,1-5,5H20v2h3a7,7,0,0,0,3-.68V21a3,3,0,0,1-3,3H22v2h1a5,5,0,0,0,5-5V18.89A7,7,0,0,0,30,14Z"
      />
    </svg>
  );
}

function getReasoningDetailLabel(messageInfo?: AssistantMessage) {
  if (!messageInfo || messageInfo.mode !== 'subagent') return null;

  const parent = state.messages.find(
    (entry): entry is { info: AssistantMessage; parts: Part[] } =>
      entry.info.role === 'assistant' && entry.info.id === messageInfo.parentID
  )?.info;

  if (!parent) return null;

  const modelChanged =
    parent.providerID !== messageInfo.providerID || parent.modelID !== messageInfo.modelID;
  const variantChanged = (parent.variant || '') !== (messageInfo.variant || '');
  if (!modelChanged && !variantChanged) return null;

  const provider = state.providers.find((item) => item.id === messageInfo.providerID);
  const modelName = provider?.models[messageInfo.modelID]?.name || messageInfo.modelID;
  const parts: string[] = [];

  if (modelChanged) parts.push(modelName);
  if (messageInfo.variant) parts.push(formatVariantLabel(messageInfo.variant));
  else if (variantChanged && !modelSupportsReasoning(messageInfo.providerID, messageInfo.modelID, state.providers)) {
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

  return (
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
        <img src={props.part.url} alt={displayName()} class="chat-image-img" />
        <figcaption class="chat-image-caption">
          {displayName()} <span class="chat-image-mime">· {props.part.mime}</span>
        </figcaption>
      </figure>
    </Show>
  );
}
