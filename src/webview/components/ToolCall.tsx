import { Show, For, createSignal } from 'solid-js';
import type { ToolPart, ToolStateCompleted, ToolStateError } from '../types';
import { postMessage } from '../lib/bridge';
import { state as appState } from '../lib/state';
import { formatDisplayPath } from '../lib/path-display';

const isPathKey = (key: string) => key === 'file_path' || key === 'path';

const FILE_EDIT_TOOLS = new Set([
  'edit',
  'write',
  'create',
  'file_edit',
  'file_write',
  'file_create',
  'update_file',
  'replace',
  'insert',
  'apply_edit',
  'apply_diff',
]);

function isFileEditTool(toolName: string): boolean {
  return FILE_EDIT_TOOLS.has(toolName.toLowerCase());
}

function extractFilePath(input: Record<string, unknown>): string | null {
  for (const key of ['file_path', 'filePath', 'path', 'filename']) {
    if (typeof input[key] === 'string' && (input[key] as string).length > 0) {
      return input[key] as string;
    }
  }
  return null;
}

export function ToolCall(props: { part: ToolPart }) {
  const [expanded, setExpanded] = createSignal(false);
  const tool = () => props.part;
  const state = () => tool().state;

  const filePath = () => {
    const input = (state().input || {}) as Record<string, unknown>;
    return extractFilePath(input);
  };

  const isEdit = () => isFileEditTool(tool().tool) && !!filePath();

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
    <Show when={isEdit()} fallback={
      <GenericToolCall
        tool={tool()}
        state={state()}
        statusClass={statusClass()}
        title={title()}
        preview={preview()}
        expanded={expanded()}
        toggleExpand={() => setExpanded(!expanded())}
        inputEntries={inputEntries()}
        truncatedOutput={truncatedOutput()}
      />
    }>
      <FileEditCard
        toolName={tool().tool}
        toolState={state()}
        filePath={filePath()!}
      />
    </Show>
  );
}

function FileEditCard(props: {
  toolName: string;
  toolState: ToolPart['state'];
  filePath: string;
}) {
  const s = () => props.toolState;
  const isCompleted = () => s().status === 'completed';
  const isRunning = () => s().status === 'running';
  const isError = () => s().status === 'error';

  const action = () => {
    const lower = props.toolName.toLowerCase();
    if (lower === 'create' || lower === 'file_create') return 'Created';
    return 'Edited';
  };

  const diffStats = () => {
    if (!isCompleted()) return null;
    const meta = (s() as ToolStateCompleted).metadata || {};
    const additions =
      typeof meta.additions === 'number'
        ? (meta.additions as number)
        : typeof meta.linesAdded === 'number'
          ? (meta.linesAdded as number)
          : undefined;
    const deletions =
      typeof meta.deletions === 'number'
        ? (meta.deletions as number)
        : typeof meta.linesRemoved === 'number'
          ? (meta.linesRemoved as number)
          : undefined;
    if (additions !== undefined || deletions !== undefined) {
      return { additions: additions || 0, deletions: deletions || 0 };
    }
    return null;
  };

  const openFile = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    postMessage({ type: 'vscode/open', payload: { path: props.filePath } });
  };

  const displayName = () =>
    formatDisplayPath(props.filePath, appState.editorContext.workspacePath);

  return (
    <div class="file-edit-line">
      <span class="file-edit-action-label">{action()}</span>
      <span class={`file-edit-dot ${isRunning() ? 'running' : isError() ? 'error' : 'done'}`} />
      <a href="#" class="file-path-link file-edit-path-link" onClick={openFile}>
        {displayName()}
      </a>
      <Show when={isCompleted() && diffStats()}>
        <span class="file-edit-diff-stats">
          <span class="diff-lines-added">+{diffStats()!.additions}</span>
          <span class="diff-lines-removed">-{diffStats()!.deletions}</span>
        </span>
      </Show>
      <Show when={isRunning()}>
        <span class="file-edit-running-label">editing…</span>
      </Show>
      <Show when={isError()}>
        <span class="file-edit-error-label">failed</span>
      </Show>
    </div>
  );
}

function GenericToolCall(props: {
  tool: ToolPart;
  state: ToolPart['state'];
  statusClass: string;
  title: string;
  preview: { text: string; key: string } | null;
  expanded: boolean;
  toggleExpand: () => void;
  inputEntries: Array<[string, unknown]>;
  truncatedOutput: string;
}) {
  const openFile = (path: string) => {
    postMessage({ type: 'vscode/open', payload: { path } });
  };

  return (
    <div class="chat-tool-invocation-part">
      <button class="tool-invocation-header" onClick={props.toggleExpand}>
        <span class={`tool-status-dot ${props.statusClass}`} />
        <span class="tool-invocation-title">{props.title}</span>
        <Show when={props.state.status === 'completed'}>
          <span class="tool-invocation-duration">
            {formatDuration((props.state as ToolStateCompleted).time.end - (props.state as ToolStateCompleted).time.start)}
          </span>
        </Show>
        <Show when={props.state.status === 'error'}>
          <span class="tool-invocation-error-label">failed</span>
        </Show>
        <svg
          class={`tool-invocation-chevron ${props.expanded ? 'expanded' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
      <Show when={props.preview && !props.expanded && props.preview.text !== props.title}>
        <div class="tool-invocation-preview">
          {(() => {
            const p = props.preview!;
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

      <Show when={props.expanded}>
        <div class="tool-invocation-detail animate-fade-in">
          <Show when={props.inputEntries.length > 0}>
            <div class="tool-invocation-input">
              <For each={props.inputEntries}>
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
          <Show when={props.state.status === 'completed' && props.truncatedOutput}>
            <pre class="tool-invocation-output">{props.truncatedOutput}</pre>
          </Show>
          <Show when={props.state.status === 'error'}>
            <div class="tool-invocation-error">{(props.state as ToolStateError).error}</div>
          </Show>
          <Show when={props.state.status === 'running'}>
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

function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '...' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

