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
          <div class="markdown-content text-[13px] leading-[1.5] text-vscode-fg">
            <MarkdownRenderer content={(part as TextPart).text} />
          </div>
        );
      case 'tool':
        return <ToolCall part={part} />;
      case 'reasoning':
        return <ReasoningBlock text={part.text} />;
      case 'agent':
        return (
          <div class="my-0.5 flex items-center gap-1.5 text-[11px] text-vscode-muted/40">
            <span>→</span>
            <span>Handing off to</span>
            <span class="text-vscode-fg/70">{part.name}</span>
          </div>
        );
      case 'patch':
        return (
          <div class="my-0.5 flex items-center gap-1.5 text-[11px] text-vscode-muted/40">
            <span class="text-vscode-success">✓</span>
            <span>
              Applied patch to {part.files.length} file{part.files.length === 1 ? '' : 's'}
            </span>
          </div>
        );
      case 'retry':
        return (
          <div class="my-0.5 text-[11px] text-vscode-warning/50">
            ↻ Retry attempt {part.attempt}
            <Show when={part.error?.data?.message}>
              <span class="ml-1 text-[10px] opacity-60">— {part.error.data.message}</span>
            </Show>
          </div>
        );
      case 'compaction':
        return (
          <div class="my-0.5 text-[10px] text-vscode-muted/25">
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

  return (
    <div class="my-0.5">
      <button
        class="flex items-center gap-1 text-[11px] text-vscode-muted/30 transition-colors hover:text-vscode-muted/50"
        onClick={() => setExpanded(!expanded())}
      >
        <svg
          class={`h-2.5 w-2.5 transition-transform ${expanded() ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
        Thinking
      </button>
      <Show when={expanded()}>
        <div class="ml-[9px] mt-0.5 whitespace-pre-wrap border-l border-vscode-border/10 pl-2.5 text-[11px] italic leading-[1.5] text-vscode-muted/40 animate-fade-in">
          {props.text}
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
    <div class="my-0.5 text-[11px]">
      <div class="flex items-center gap-1.5 text-vscode-muted">
        <div class="h-[5px] w-[5px] shrink-0 rounded-full bg-vscode-accent" />
        {props.part.description}
      </div>
      <Show when={selectedModel() || run()}>
        <div class="ml-[11px] flex flex-wrap gap-x-2 text-[10px] text-vscode-muted/30">
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
        <div class="my-1 inline-flex items-center gap-1.5 rounded border border-vscode-border/30 bg-vscode-card/30 px-2 py-0.5 text-[11px] text-vscode-muted">
          <svg class="h-3 w-3" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
          </svg>
          {props.part.filename || '(file)'}
        </div>
      }
    >
      <figure class="my-1.5 rounded border border-vscode-border/20 bg-vscode-card/10 p-2">
        <img
          src={props.part.url}
          alt={props.part.filename || 'image'}
          class="max-h-[280px] w-auto max-w-full rounded border border-vscode-border/20 bg-vscode-bg/20 object-contain"
        />
        <figcaption class="mt-1 text-[10px] text-vscode-muted">
          {props.part.filename || 'image'}{' '}
          <span class="text-vscode-muted/50">· {props.part.mime}</span>
        </figcaption>
      </figure>
    </Show>
  );
}
