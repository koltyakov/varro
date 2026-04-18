import { Show, createSignal } from 'solid-js';
import type { ToolPart } from '../types';

export function ToolCall(props: { part: ToolPart }) {
  const [expanded, setExpanded] = createSignal(false);
  const tool = () => props.part;
  const state = () => tool().state;

  const statusDot = () => {
    switch (state().status) {
      case 'pending':
        return 'bg-vscode-muted/30';
      case 'running':
        return 'bg-vscode-accent animate-pulse-soft';
      case 'completed':
        return 'bg-vscode-success';
      case 'error':
        return 'bg-vscode-error';
    }
  };

  const title = () => {
    const s = state();
    if (s.status === 'completed') return s.title || tool().tool;
    if (s.status === 'running') return s.title || tool().tool;
    return tool().tool;
  };

  const preview = () => {
    const s = state();
    const input: any = s.input || {};
    const keys = ['file_path', 'path', 'command', 'query', 'pattern'];
    for (const k of keys) {
      if (typeof input[k] === 'string') return String(input[k]).slice(0, 100);
    }
    return '';
  };

  return (
    <div class="my-0.5">
      <button
        class="flex w-full items-center gap-1.5 rounded py-0.5 text-left transition-colors hover:bg-vscode-hover/20"
        onClick={() => setExpanded(!expanded())}
      >
        <span class={`h-[5px] w-[5px] shrink-0 rounded-full ${statusDot()}`} />
        <span class="min-w-0 flex-1 truncate text-[12px] text-vscode-muted">
          {title()}
          <Show when={state().status === 'completed'}>
            {(() => {
              const s = state() as import('../types').ToolStateCompleted;
              return (
                <span class="ml-1.5 text-[10px] tabular-nums text-vscode-muted/30">
                  {formatDuration(s.time.end - s.time.start)}
                </span>
              );
            })()}
          </Show>
          <Show when={state().status === 'running'}>
            <span class="ml-1.5 text-[10px] text-vscode-accent/40">running</span>
          </Show>
          <Show when={state().status === 'error'}>
            <span class="ml-1.5 text-[10px] text-vscode-error/40">error</span>
          </Show>
        </span>
        <svg
          class={`h-2.5 w-2.5 shrink-0 text-vscode-muted/20 transition-transform ${expanded() ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
      </button>
      <Show when={preview() && !expanded()}>
        <div class="ml-[11px] truncate font-mono text-[10px] text-vscode-muted/25">{preview()}</div>
      </Show>

      <Show when={expanded()}>
        <div class="ml-[11px] border-l border-vscode-border/10 pl-2.5 py-1.5 text-[11px] animate-fade-in">
          <Show when={Object.keys(state().input || {}).length > 0}>
            <div class="mb-1.5">
              <pre class="overflow-x-auto whitespace-pre-wrap font-mono text-[10px] leading-[1.5] text-vscode-muted/50">
                {JSON.stringify(state().input, null, 2)}
              </pre>
            </div>
          </Show>
          <Show when={state().status === 'completed'}>
            <pre class="max-h-[160px] overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-[1.5] text-vscode-fg/60">
              {(state() as any).output || '(empty)'}
            </pre>
          </Show>
          <Show when={state().status === 'error'}>
            <div class="text-[11px] text-vscode-error/70">{(state() as any).error}</div>
          </Show>
          <Show when={state().status === 'running'}>
            <div class="flex items-center gap-1.5 text-[11px] text-vscode-muted/30">
              <span class="h-1 w-1 rounded-full bg-vscode-accent animate-pulse-soft" />
              Running...
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
