import { Show, createSignal } from 'solid-js';
import { state, showThinking } from '../lib/state';
import { formatAgentLabel } from '../lib/format';
import type { AssistantMessage, Part, SubtaskPart, TextPart } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCall } from './ToolCall';
import { formatDisplayPath } from '../lib/path-display';

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
            <ReasoningBlock text={part.text} />
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

function ReasoningBlock(props: { text: string }) {
  const [expanded, setExpanded] = createSignal(false);
  const isStreaming = () => !props.text || props.text.endsWith('…') || props.text.length < 50;

  return (
    <div class="chat-thinking-box">
      <button class="thinking-header" onClick={() => setExpanded(!expanded())}>
        <svg
          class={`chevron ${expanded() ? 'expanded' : ''}`}
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
        <Show when={isStreaming()} fallback={<span class="thinking-label">Thinking</span>}>
          <span class="thinking-label shimmer-progress">Thinking</span>
        </Show>
      </button>
      <Show when={expanded()}>
        <div class="thinking-content animate-fade-in">
          <div class="thinking-item">
            <div class="thinking-text">{props.text}</div>
          </div>
        </div>
      </Show>
    </div>
  );
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
