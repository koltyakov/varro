import { Show, For, createSignal } from 'solid-js';
import type { ToolPart, ToolStateCompleted, ToolStateError } from '../types';
import { postMessage } from '../lib/bridge';
import { state as appState } from '../lib/state';
import { formatDisplayPath } from '../lib/path-display';

const isPathKey = (key: string) => key === 'file_path' || key === 'path';

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
    const keys = ['file_path', 'pattern', 'query', 'command', 'path'];
    for (const k of keys) {
      if (typeof input[k] === 'string') return { text: String(input[k]).slice(0, 100), key: k };
    }
    return null;
  };

  const openFile = (path: string) => {
    postMessage({ type: 'vscode/open', payload: { path } });
  };

  const inputEntries = () => {
    const input = (state().input || {}) as Record<string, unknown>;
    return Object.entries(input).filter(([, v]) => v !== undefined && v !== null);
  };

  const truncatedOutput = () => {
    if (state().status !== 'completed') return '';
    const output = (state() as ToolStateCompleted).output || '';
    if (output.length <= 2000) return output;
    return (
      output.slice(0, 1000) +
      '\n\n… (' +
      Math.round((output.length - 2000) / 1000) +
      'k chars truncated) …\n\n' +
      output.slice(-1000)
    );
  };

  return (
    <div class="chat-tool-invocation-part">
      <button class="tool-invocation-header" onClick={() => setExpanded(!expanded())}>
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
          <span class="tool-invocation-running-label">
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="currentColor"
              style={{ animation: 'spin 0.8s linear infinite' }}
            >
              <path
                d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8z"
                opacity="0.25"
              />
              <path d="M8 0a8 8 0 018 8h-1.5A6.5 6.5 0 008 1.5V0z" />
            </svg>
          </span>
        </Show>
        <Show when={state().status === 'error'}>
          <span class="tool-invocation-error-label">failed</span>
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
        <div class="tool-invocation-preview">
          {(() => {
            const p = preview()!;
            return isPathKey(p.key) ? (
              <a
                href="#"
                class="file-path-link"
                onClick={(e) => {
                  e.preventDefault();
                  openFile(p.text);
                }}
              >
                {formatDisplayPath(p.text, appState.editorContext.workspacePath)}
              </a>
            ) : (
              p.text
            );
          })()}
        </div>
      </Show>

      <Show when={expanded()}>
        <div class="tool-invocation-detail animate-fade-in">
          <Show when={inputEntries().length > 0}>
            <div class="tool-invocation-input">
              <For each={inputEntries()}>
                {([key, value]) => (
                  <div class="tool-input-entry">
                    <span class="tool-input-key">{key}</span>
                    {isPathKey(key) && typeof value === 'string' ? (
                      <a
                        href="#"
                        class="file-path-link tool-input-value"
                        onClick={(e) => {
                          e.preventDefault();
                          openFile(String(value));
                        }}
                      >
                        {formatDisplayPath(String(value), appState.editorContext.workspacePath)}
                      </a>
                    ) : (
                      <span class="tool-input-value">{formatValue(value)}</span>
                    )}
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={state().status === 'completed' && truncatedOutput()}>
            <pre class="tool-invocation-output">{truncatedOutput()}</pre>
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

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '...' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
