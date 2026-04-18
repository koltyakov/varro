import { Show, createMemo, createSignal } from 'solid-js';
import { state } from '../lib/state';
import { formatDuration, getAssistantDuration } from '../lib/message-metrics';
import type { AssistantMessage, Part, SubtaskPart, TextPart } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ToolCall } from './ToolCall';

export function MessagePart(props: {
  part: Part;
  messageInfo?: AssistantMessage;
  subtaskRun?: AssistantMessage;
}) {
  const p = () => props.part;

  const render = () => {
    const part = p();
    switch (part.type) {
      case 'text':
        return (
          <div class="rendered-markdown">
            <MarkdownRenderer content={(part as TextPart).text} />
          </div>
        );
      case 'tool':
        return <ToolCall part={part} />;
      case 'reasoning':
        return <ReasoningBlock text={part.text} />;
      case 'agent':
        return (
          <div class="chat-subtask-part">
            <div class="subtask-header">
              <span class="subtask-dot" />
              <span>Handing off to <span class="subtask-agent-name">{part.name}</span></span>
            </div>
          </div>
        );
      case 'patch':
        return (
          <div class="chat-subtask-part">
            <div class="subtask-header">
              <span class="subtask-check">✓</span>
              <span>Applied patch to {part.files.length} file{part.files.length === 1 ? '' : 's'}</span>
            </div>
          </div>
        );
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
        return <SubtaskBlock part={part} run={props.subtaskRun} />;
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
      <button
        class="thinking-header"
        onClick={() => setExpanded(!expanded())}
      >
        <svg
          class={`chevron ${expanded() ? 'expanded' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
          width="12"
          height="12"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
        <Show when={isStreaming()} fallback={<span class="thinking-label">Thinking</span>}>
          <span class="thinking-label shimmer-progress">Thinking</span>
        </Show>
      </button>
      <Show when={expanded()}>
        <div class="thinking-content animate-fade-in">
          <div class="thinking-item">
            <div class="thinking-text">
              {props.text}
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

function SubtaskBlock(props: { part: SubtaskPart; run?: AssistantMessage }) {
  const run = () => props.run;
  const selectedModel = createMemo(() => {
    if (run()) {
      const provider = state.providers.find((item) => item.id === run()!.providerID);
      const model = provider?.models[run()!.modelID];
      return formatModelLabel(
        provider?.name || run()!.providerID,
        model?.name || run()!.modelID,
        run()!.variant
      );
    }

    if (props.part.model) {
      const provider = state.providers.find((item) => item.id === props.part.model!.providerID);
      const model = provider?.models[props.part.model!.modelID];
      return formatModelLabel(
        provider?.name || props.part.model!.providerID,
        model?.name || props.part.model!.modelID,
        (props.part.model as { variant?: string }).variant
      );
    }

    return null;
  });

  return (
    <div class="chat-subtask-part">
      <div class="subtask-header">
        <div class="subtask-dot" />
        <span>{props.part.description}</span>
      </div>
      <Show when={selectedModel() || run()}>
        <div class="subtask-meta">
          <Show when={props.part.agent}>
            <span>{props.part.agent}</span>
          </Show>
          <Show when={run()}>
            <span>{formatDuration(getAssistantDuration(run()!))}</span>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function formatModelLabel(providerName: string, modelName: string, variant?: string) {
  return `${providerName} / ${modelName}${variant ? ` [${formatVariantLabel(variant)}]` : ''}`;
}

function formatVariantLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function FileBlock(props: { part: Extract<Part, { type: 'file' }> }) {
  const isImage = () => props.part.mime.startsWith('image/');

  return (
    <Show
      when={isImage()}
      fallback={
        <div class="chat-attachment-chip">
          <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
            <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
          </svg>
          <span class="chip-label">{props.part.filename || '(file)'}</span>
        </div>
      }
    >
      <figure class="chat-image-figure">
        <img
          src={props.part.url}
          alt={props.part.filename || 'image'}
          class="chat-image-img"
        />
        <figcaption class="chat-image-caption">
          {props.part.filename || 'image'}{' '}
          <span class="chat-image-mime">· {props.part.mime}</span>
        </figcaption>
      </figure>
    </Show>
  );
}
