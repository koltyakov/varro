import { Show, createSignal } from 'solid-js';
import type { ToolPart, ToolStateCompleted, ToolStateError } from '../types';

export function ToolCall(props: { part: ToolPart }) {
  const [expanded, setExpanded] = createSignal(false);
  const tool = () => props.part;
  const state = () => tool().state;

  const statusClass = () => {
    switch (state().status) {
      case 'pending':
        return 'tool-status-pending';
      case 'running':
        return 'tool-status-running';
      case 'completed':
        return 'tool-status-completed';
      case 'error':
        return 'tool-status-error';
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
    const input: Record<string, unknown> = (s.input || {}) as Record<string, unknown>;
    const keys = ['file_path', 'path', 'command', 'query', 'pattern'];
    for (const k of keys) {
      if (typeof input[k] === 'string') return String(input[k]).slice(0, 100);
    }
    return '';
  };

  return (
    <div class="chat-tool-invocation-part">
      <button
        class="tool-invocation-header"
        onClick={() => setExpanded(!expanded())}
      >
        <span class={`tool-status-dot ${statusClass()}`} />
        <span class="tool-invocation-title">{title()}</span>
        <Show when={state().status === 'completed'}>
          {(() => {
            const s = state() as ToolStateCompleted;
            return (
              <span class="tool-invocation-duration">
                {formatDuration(s.time.end - s.time.start)}
              </span>
            );
          })()}
        </Show>
        <Show when={state().status === 'running'}>
          <span class="tool-invocation-running-label">running</span>
        </Show>
        <Show when={state().status === 'error'}>
          <span class="tool-invocation-error-label">error</span>
        </Show>
        <svg
          class={`tool-invocation-chevron ${expanded() ? 'expanded' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M6 4l4 4-4 4z" />
        </svg>
      </button>
      <Show when={preview() && !expanded()}>
        <div class="tool-invocation-preview">{preview()}</div>
      </Show>

      <Show when={expanded()}>
        <div class="tool-invocation-detail animate-fade-in">
          <Show when={Object.keys(state().input || {}).length > 0}>
            <div class="tool-invocation-input">
              <pre class="tool-invocation-pre">{JSON.stringify(state().input, null, 2)}</pre>
            </div>
          </Show>
          <Show when={state().status === 'completed'}>
            <pre class="tool-invocation-output">{(state() as ToolStateCompleted).output || '(empty)'}</pre>
          </Show>
          <Show when={state().status === 'error'}>
            <div class="tool-invocation-error">{(state() as ToolStateError).error}</div>
          </Show>
          <Show when={state().status === 'running'}>
            <div class="tool-invocation-running">
              <span class="tool-status-dot tool-status-running" />
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
