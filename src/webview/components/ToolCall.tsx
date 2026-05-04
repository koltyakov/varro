import { Show, For, createEffect, createMemo, createSignal } from 'solid-js';
import type { QuestionRequest, ToolPart, ToolStateCompleted, ToolStateError } from '../types';
import { postMessage } from '../lib/bridge';
import { state as appState, getPermissionGroupMembers, getSessionTreeRootId } from '../lib/state';
import { formatDisplayPath, getLeafPathName, normalizePath } from '../lib/path-display';
import { formatCommandDisplay } from '../lib/command-display';
import { getToolFileChange, getToolReadPath } from '../lib/tool-file-change';
import { getToolCallExpanded, setToolCallExpanded } from '../lib/tool-call-expansion-state';
import type { ToolCallPermissionMatch } from '../lib/tool-call-matching';
import { QuestionPrompt } from './QuestionPrompt';
import { PermissionPrompt } from './PermissionPrompt';
import { isAbortedToolError } from '../lib/aborted';

export { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';

const isPathKey = (key: string) => key === 'file_path' || key === 'path';
const SEARCH_TOOL_NAMES = new Set(['grep', 'glob', 'codesearch', 'websearch', 'search']);
const STRUCTURED_TOOL_NAMES = new Set(['task', 'apply_patch']);
type ToolPreview = { text: string; key: string };

export function getToolCallExpansionKey(part: ToolPart) {
  return `${part.sessionID}\u0000${part.messageID}\u0000${part.callID}`;
}

function normalizeToolName(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  const parts = normalized.split('.');
  return parts[parts.length - 1] || normalized;
}

function isQuestionToolName(toolName: string) {
  return normalizeToolName(toolName) === 'question';
}

function isStructuredToolName(toolName: string) {
  return STRUCTURED_TOOL_NAMES.has(normalizeToolName(toolName));
}

function getSearchPattern(input: Record<string, unknown>) {
  for (const key of ['pattern', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function getStateTitle(state: ToolPart['state']) {
  if (state.status !== 'running' && state.status !== 'completed') return '';
  return state.title?.trim() || '';
}

function hasVisibleInputValue(value: unknown) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

function normalizedComparableText(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function getVisibleInputEntries(input: Record<string, unknown>) {
  return Object.entries(input).filter(([, value]) => hasVisibleInputValue(value));
}

export function formatToolTitle(toolName: string, state: ToolPart['state']) {
  const input = (state.input || {}) as Record<string, unknown>;
  const title = getStateTitle(state);

  if (SEARCH_TOOL_NAMES.has(normalizeToolName(toolName))) {
    const pattern = getSearchPattern(input);
    if (pattern) return `Search: ${pattern}`;
    return title || 'Search';
  }

  return title || toolName;
}

export function shouldShowToolPreview(title: string, preview: ToolPreview | null) {
  if (!preview) return false;

  const normalizedTitle = title.trim().toLowerCase();
  const normalizedPreview = preview.text.trim().toLowerCase();

  if (!normalizedPreview) return false;
  if (normalizedTitle === normalizedPreview) return false;
  if (normalizedTitle.endsWith(`: ${normalizedPreview}`)) return false;
  return true;
}

function parseIntLike(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

function extractTaggedOutput(output: string, tagName: string): string | null {
  const match = output.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'i'));
  if (!match) return null;
  const [, content = ''] = match;
  return content.trim();
}

function extractReadRange(
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined
): { start: number; end: number } | null {
  const source = { ...metadata, ...input };
  let start = null as number | null;
  let end = null as number | null;

  for (const key of [
    'start_line',
    'startLine',
    'line_start',
    'lineStart',
    'from_line',
    'fromLine',
  ]) {
    const value = parseIntLike(source[key]);
    if (value !== null) {
      start = value;
      break;
    }
  }

  if (start === null) {
    const offset = parseIntLike(source.offset);
    if (offset !== null) start = offset + 1;
  }

  for (const key of ['end_line', 'endLine', 'line_end', 'lineEnd', 'to_line', 'toLine']) {
    const value = parseIntLike(source[key]);
    if (value !== null) {
      end = value;
      break;
    }
  }

  const limit = parseIntLike(source.limit);
  if (start !== null && end === null && limit !== null) end = start + limit - 1;
  if (start === null && end === null && limit !== null) return { start: 1, end: limit };
  if (start === null || end === null) return null;
  if (start <= 0 || end < start) return null;
  return { start, end };
}

function isDirectoryOutput(toolState: ToolPart['state']): boolean {
  if (toolState.status !== 'completed') return false;
  const output = (toolState as ToolStateCompleted).output || '';
  return /<type>\s*directory\s*<\/type>/i.test(output) || /<entries>/i.test(output);
}

export function ToolCall(props: {
  part: ToolPart;
  questionRequest?: QuestionRequest | null;
  permissionMatch?: ToolCallPermissionMatch | null;
}) {
  const tool = () => props.part;
  const expansionKey = () => getToolCallExpansionKey(tool());
  const [expanded, setExpanded] = createSignal(getToolCallExpanded(expansionKey()));
  const state = () => tool().state;
  const toolSessionRootId = createMemo(
    () => getSessionTreeRootId(tool().sessionID) || tool().sessionID
  );
  const fallbackQuestionRequest = createMemo(() => {
    const currentTool = tool();
    const sessionRootId = toolSessionRootId();
    return appState.questions.find(
      (request) =>
        (getSessionTreeRootId(request.sessionID) || request.sessionID) === sessionRootId &&
        request.tool?.messageID === currentTool.messageID &&
        request.tool?.callID === currentTool.callID
    );
  });
  const fallbackPermissionMatch = createMemo<ToolCallPermissionMatch | null>(() => {
    const currentTool = tool();
    const sessionRootId = toolSessionRootId();

    for (const permission of appState.permissions) {
      const members = getPermissionGroupMembers(permission);
      for (const [index, member] of members.entries()) {
        if ((getSessionTreeRootId(member.sessionID) || member.sessionID) !== sessionRootId)
          continue;
        if (member.messageID !== currentTool.messageID || member.callID !== currentTool.callID) {
          continue;
        }
        return {
          permission,
          isPrimaryOwner: index === 0,
        };
      }
    }

    return null;
  });
  const questionRequest = createMemo(() =>
    props.questionRequest !== undefined
      ? props.questionRequest
      : (fallbackQuestionRequest() ?? null)
  );
  const permissionMatch = createMemo(() =>
    props.permissionMatch !== undefined ? props.permissionMatch : fallbackPermissionMatch()
  );
  const permissionRequest = createMemo(() => permissionMatch()?.permission ?? null);
  const isPrimaryPermissionOwner = createMemo(() => permissionMatch()?.isPrimaryOwner ?? false);

  const filePath = () => {
    return getToolReadPath(tool().tool, state());
  };

  const fileChange = () => getToolFileChange(tool().tool, state());
  const isRead = () => filePath() !== null;

  const statusClass = () => {
    switch (state().status) {
      case 'pending':
        return 'tool-status-pending';
      case 'running':
        return 'tool-status-running';
      case 'completed':
        return 'tool-status-completed';
      case 'error':
        return isAbortedToolError(state()) ? 'tool-status-aborted' : 'tool-status-error';
    }
  };

  const title = () => {
    return formatToolTitle(tool().tool, state());
  };

  const preview = createMemo<ToolPreview | null>(() => {
    const s = state();
    const input: Record<string, unknown> = (s.input || {}) as Record<string, unknown>;
    const keys = ['file_path', 'pattern', 'query', 'command', 'path'];
    for (const k of keys) {
      if (typeof input[k] === 'string') return { text: String(input[k]).slice(0, 100), key: k };
    }
    return null;
  });

  const inputEntries = createMemo(() => {
    const input = (state().input || {}) as Record<string, unknown>;
    const normalizedTitle = normalizedComparableText(title());
    return getVisibleInputEntries(input).filter(([key, value]) => {
      if (key !== 'description') return true;
      return normalizedComparableText(value) !== normalizedTitle;
    });
  });

  const truncatedOutput = createMemo(() => {
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
  });

  createEffect(() => {
    setExpanded(getToolCallExpanded(expansionKey()));
  });

  const toggleExpand = () => {
    const next = !expanded();
    setToolCallExpanded(expansionKey(), next);
    setExpanded(next);
  };

  const shouldHideToolCard = () => {
    if (permissionRequest()) return true;
    return Boolean(questionRequest()) && isQuestionToolName(tool().tool);
  };
  const showPermission = () => {
    const permission = permissionRequest();
    if (questionRequest() || !permission || !isPrimaryPermissionOwner()) return null;
    return permission;
  };

  const toolContent = () => {
    if (fileChange()) {
      return <FileChangeCard toolState={state()} change={fileChange()!} />;
    }

    if (isRead()) {
      return (
        <ReadToolCard toolState={state()} filePath={filePath()!} sessionID={tool().sessionID} />
      );
    }

    return (
      <GenericToolCall
        tool={tool()}
        state={state()}
        statusClass={statusClass()}
        title={title()}
        preview={preview()}
        expanded={expanded()}
        toggleExpand={toggleExpand}
        inputEntries={inputEntries()}
        truncatedOutput={truncatedOutput()}
      />
    );
  };

  return (
    <>
      <Show when={!shouldHideToolCard()}>{toolContent()}</Show>
      <Show when={questionRequest()}>{(question) => <QuestionPrompt request={question()} />}</Show>
      <Show when={showPermission()}>
        {(permission) => <PermissionPrompt permission={permission()} />}
      </Show>
    </>
  );
}

function ReadToolCard(props: {
  toolState: ToolPart['state'];
  filePath: string;
  sessionID: string;
}) {
  const s = () => props.toolState;
  const isCompleted = () => s().status === 'completed';
  const isRunning = () => s().status === 'running';
  const isError = () => s().status === 'error';
  const isAborted = () => isAbortedToolError(s());
  const statusClass = () => {
    switch (s().status) {
      case 'pending':
        return 'tool-status-pending';
      case 'running':
        return 'tool-status-running';
      case 'completed':
        return 'tool-status-completed';
      case 'error':
        return isAborted() ? 'tool-status-aborted' : 'tool-status-error';
    }
  };
  const metadata = () => {
    const state = s();
    if (state.status === 'completed' || state.status === 'running' || state.status === 'error') {
      return state.metadata;
    }
    return undefined;
  };

  const sessionDirectory = () =>
    appState.sessions.find((session) => session.id === props.sessionID)?.directory ||
    appState.editorContext.workspacePath;

  const normalizedPath = () => normalizePath(props.filePath);
  const normalizedSessionDirectory = () =>
    sessionDirectory() ? normalizePath(sessionDirectory() as string) : null;

  const isCurrentDirectory = () =>
    props.filePath === '.' ||
    props.filePath === './' ||
    (normalizedSessionDirectory() !== null && normalizedPath() === normalizedSessionDirectory());

  const isDirectory = () => isCurrentDirectory() || isDirectoryOutput(s());
  const lineRange = () =>
    extractReadRange((s().input || {}) as Record<string, unknown>, metadata());

  const openFile = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    postMessage({
      type: 'vscode/open',
      payload: { path: props.filePath, kind: isDirectory() ? 'directory' : 'file' },
    });
  };

  const displayName = () => {
    if (isCurrentDirectory()) return 'current directory';
    if (isDirectory())
      return formatDisplayPath(props.filePath, appState.editorContext.workspacePath);
    return getLeafPathName(formatDisplayPath(props.filePath, appState.editorContext.workspacePath));
  };

  return (
    <div class="chat-tool-invocation-part file-read-card">
      <div class="file-read-card-header">
        <span class={`tool-status-dot ${statusClass()}`} />
        <span class="file-read-action-label">Read</span>
        <Show
          when={!isCurrentDirectory()}
          fallback={<span class="file-read-target file-read-target-text">{displayName()}</span>}
        >
          <a href="#" class="file-path-link file-read-target" onClick={openFile}>
            {displayName()}
          </a>
        </Show>
        <Show when={!isDirectory() && lineRange()}>
          <span class="file-read-range">
            (L{lineRange()!.start}-{lineRange()!.end})
          </span>
        </Show>
        <Show when={isDirectory() && !isCurrentDirectory()}>
          <span class="file-read-meta">directory</span>
        </Show>
        <Show when={isCompleted()}>
          <span class="tool-invocation-duration file-read-duration">
            {formatDuration(
              (s() as ToolStateCompleted).time.end - (s() as ToolStateCompleted).time.start
            )}
          </span>
        </Show>
        <Show when={isRunning()}>
          <span class="file-read-running-label">reading…</span>
        </Show>
        <Show when={isError()}>
          <span class={`file-read-error-label${isAborted() ? ' is-aborted' : ''}`}>
            {isAborted() ? 'aborted' : 'failed'}
          </span>
        </Show>
      </div>
    </div>
  );
}

function FileChangeCard(props: {
  toolState: ToolPart['state'];
  change: ReturnType<typeof getToolFileChange>;
}) {
  const s = () => props.toolState;
  const isCompleted = () => s().status === 'completed';
  const isRunning = () => s().status === 'running';
  const isError = () => s().status === 'error';
  const isAborted = () => isAbortedToolError(s());
  const change = () => props.change!;
  const effectiveKind = () => change().kind;

  const action = () => {
    switch (effectiveKind()) {
      case 'added':
        return 'Added';
      case 'removed':
        return 'Removed';
      case 'moved':
        return 'Moved';
      default:
        return 'Edited';
    }
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

  const openPath = (path: string) => (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    postMessage({ type: 'vscode/open', payload: { path, kind: 'file' } });
  };

  const displayName = (path: string | undefined) =>
    path ? formatDisplayPath(path, appState.editorContext.workspacePath) : '';

  return (
    <div class="chat-tool-invocation-part file-change-card">
      <div class="file-change-card-header">
        <span
          class={`file-edit-dot ${isRunning() ? 'running' : isError() ? (isAborted() ? 'aborted' : 'error') : 'done'}`}
          aria-label={
            isRunning() ? 'Running' : isError() ? (isAborted() ? 'Aborted' : 'Error') : 'Done'
          }
        />
        <span class="file-edit-action-label">{action()}</span>
        <Show
          when={effectiveKind() !== 'moved'}
          fallback={
            <span class="file-edit-move-paths">
              <a
                href="#"
                class="file-path-link file-edit-path-link"
                onClick={openPath(change().fromPath || change().path)}
              >
                {displayName(change().fromPath || change().path)}
              </a>
              <span class="file-edit-move-arrow">→</span>
              <a
                href="#"
                class="file-path-link file-edit-path-link"
                onClick={openPath(change().toPath || change().path)}
              >
                {displayName(change().toPath || change().path)}
              </a>
            </span>
          }
        >
          <a href="#" class="file-path-link file-edit-path-link" onClick={openPath(change().path)}>
            {displayName(change().path)}
          </a>
        </Show>
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
          <span class={`file-edit-error-label${isAborted() ? ' is-aborted' : ''}`}>
            {isAborted() ? 'aborted' : 'failed'}
          </span>
        </Show>
        <Show when={isCompleted()}>
          <span class="tool-invocation-duration file-edit-duration">
            {formatDuration(
              (s() as ToolStateCompleted).time.end - (s() as ToolStateCompleted).time.start
            )}
          </span>
        </Show>
      </div>
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
    postMessage({ type: 'vscode/open', payload: { path, kind: 'file' } });
  };
  const toolName = () => normalizeToolName(props.tool.tool);
  const isAborted = () => isAbortedToolError(props.state);
  const isBash = () => toolName() === 'bash';
  const isTask = () => toolName() === 'task';
  const isStructuredTool = () => isStructuredToolName(props.tool.tool);
  const bashCommand = () => {
    const command = props.state.input?.command;
    return typeof command === 'string'
      ? formatCommandDisplay(command, appState.editorContext.workspacePath)
      : '';
  };
  const bashOutput = () => {
    if (props.state.status !== 'completed') return '';
    return props.truncatedOutput || '(no output)';
  };
  const bashOutputIsEmpty = () => props.state.status === 'completed' && !props.truncatedOutput;
  const taskResult = () => {
    if (props.state.status !== 'completed') return { label: 'result', value: '' };
    const extracted = extractTaggedOutput(props.truncatedOutput, 'task_result');
    if (extracted !== null) return { label: 'task_result', value: extracted || '(no output)' };
    return { label: 'result', value: props.truncatedOutput || '(no output)' };
  };
  const structuredResult = () => {
    if (props.state.status !== 'completed') return null;
    if (isTask()) return taskResult();
    return { label: 'result', value: props.truncatedOutput || '(no output)' };
  };

  return (
    <div class="chat-tool-invocation-part">
      <button class="tool-invocation-header" onClick={props.toggleExpand}>
        <span class={`tool-status-dot ${props.statusClass}`} />
        <span class="tool-invocation-title">{props.title}</span>
        <Show when={props.state.status === 'completed'}>
          <span class="tool-invocation-duration">
            {formatDuration(
              (props.state as ToolStateCompleted).time.end -
                (props.state as ToolStateCompleted).time.start
            )}
          </span>
        </Show>
        <Show when={props.state.status === 'error'}>
          <span class={`tool-invocation-error-label${isAborted() ? ' is-aborted' : ''}`}>
            {isAborted() ? 'aborted' : 'failed'}
          </span>
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
      <Show when={!props.expanded && shouldShowToolPreview(props.title, props.preview)}>
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
              formatPreviewValue(p.key, p.text)
            );
          })()}
        </div>
      </Show>

      <Show when={props.expanded}>
        <div class="tool-invocation-detail animate-fade-in">
          <Show
            when={isBash() && bashCommand()}
            fallback={
              <Show
                when={isStructuredTool()}
                fallback={
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
                                {formatDisplayPath(
                                  String(value),
                                  appState.editorContext.workspacePath
                                )}
                              </a>
                            ) : (
                              <span class="tool-input-value">{formatValue(key, value)}</span>
                            )}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                }
              >
                <StructuredToolCard
                  inputEntries={props.inputEntries}
                  result={structuredResult()}
                  onOpenPath={openFile}
                />
              </Show>
            }
          >
            <div class="terminal-command-card">
              <div class="terminal-command-row terminal-command-row-input">
                <span class="terminal-command-prompt" aria-hidden="true">
                  $
                </span>
                <pre class="terminal-command-text">{bashCommand()}</pre>
              </div>
              <Show when={props.state.status === 'completed'}>
                <div class="terminal-command-row terminal-command-row-output">
                  <pre
                    class={`terminal-command-text terminal-command-output${bashOutputIsEmpty() ? ' terminal-command-output-empty' : ''}`}
                  >
                    {bashOutput()}
                  </pre>
                </div>
              </Show>
            </div>
          </Show>
          <Show
            when={
              !isBash() &&
              !isStructuredTool() &&
              props.state.status === 'completed' &&
              props.truncatedOutput
            }
          >
            <pre class="tool-invocation-output">{props.truncatedOutput}</pre>
          </Show>
          <Show when={props.state.status === 'error'}>
            <div class={`tool-invocation-error${isAborted() ? ' is-aborted' : ''}`}>
              {(props.state as ToolStateError).error}
            </div>
          </Show>
          <Show when={props.state.status === 'running'}>
            <div class="tool-invocation-running">Running...</div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function StructuredToolCard(props: {
  inputEntries: Array<[string, unknown]>;
  result: { label: string; value: string } | null;
  onOpenPath: (path: string) => void;
}) {
  const promptEntry = () => props.inputEntries.find(([key]) => key === 'prompt') || null;
  const nonPromptEntries = () => props.inputEntries.filter(([key]) => key !== 'prompt');

  return (
    <div class="structured-tool-card">
      <For each={nonPromptEntries()}>
        {([key, value]) => {
          const blockValue = shouldShowStructuredToolValueAsBlock(key, value);
          return (
            <div class={`structured-tool-row${blockValue ? ' structured-tool-row-block' : ''}`}>
              <span class="structured-tool-label">{key}</span>
              {isPathKey(key) && typeof value === 'string' ? (
                <a
                  href="#"
                  class="file-path-link structured-tool-value"
                  onClick={(e) => {
                    e.preventDefault();
                    props.onOpenPath(String(value));
                  }}
                >
                  {formatDisplayPath(String(value), appState.editorContext.workspacePath)}
                </a>
              ) : (
                <pre class="structured-tool-value">{formatExpandedValue(key, value)}</pre>
              )}
            </div>
          );
        }}
      </For>
      <Show when={promptEntry()}>
        {(entry) => (
          <div class="structured-tool-row structured-tool-row-block">
            <span class="structured-tool-label">{entry()[0]}</span>
            <pre class="structured-tool-value">{formatExpandedValue(entry()[0], entry()[1])}</pre>
          </div>
        )}
      </Show>
      <Show when={props.result}>
        {(result) => (
          <div class="structured-tool-row structured-tool-row-block structured-tool-row-result">
            <span class="structured-tool-label">{result().label}</span>
            <pre class="structured-tool-value structured-tool-value-result">{result().value}</pre>
          </div>
        )}
      </Show>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatPreviewValue(key: string, value: string): string {
  return key === 'command'
    ? formatCommandDisplay(value, appState.editorContext.workspacePath)
    : value;
}

function shouldShowStructuredToolValueAsBlock(key: string, value: unknown): boolean {
  if (isPathKey(key)) return false;
  if (typeof value === 'string') return value.includes('\n') || value.length > 100;
  return typeof value === 'object' && value !== null;
}

function formatExpandedValue(key: string, value: unknown): string {
  if (typeof value === 'string') {
    return key === 'command'
      ? formatCommandDisplay(value, appState.editorContext.workspacePath)
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function formatValue(key: string, value: unknown): string {
  if (typeof value === 'string') {
    const formatted =
      key === 'command' ? formatCommandDisplay(value, appState.editorContext.workspacePath) : value;
    return formatted.length > 200 ? formatted.slice(0, 200) + '...' : formatted;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
