import {
  Show,
  For,
  Match,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
} from 'solid-js';
import { isAbortedToolError } from '../../shared/error-classification';
import type {
  AssistantMessage,
  QuestionRequest,
  ToolPart,
  ToolStateCompleted,
  ToolStateError,
} from '../types';
import { postMessage } from '../lib/bridge';
import {
  state as appState,
  getPermissionGroupMembers,
  getSessionTreeRootId,
  showInlineFileChanges,
} from '../lib/state';
import { formatDisplayPath, getLeafPathName, normalizePath } from '../lib/path-display';
import { formatCommandDisplay } from '../lib/command-display';
import { formatDuration, formatNumber } from '../lib/message-metrics';
import { getToolFileChanges, getToolReadPath, isToolFileRead } from '../lib/tool-file-change';
import type { FileChange } from '../lib/tool-file-change';
import { getToolCallExpanded, setToolCallExpanded } from '../lib/tool-call-expansion-state';
import type { ToolCallPermissionMatch } from '../lib/tool-call-matching';
import { resolveTaskSessionId } from '../lib/task-session';
import { rememberDirectSessionReturn } from '../lib/session-navigation';
import { selectSession } from '../hooks/useOpenCode';
import { QuestionPrompt } from './QuestionPrompt';
import { PermissionPrompt } from './PermissionPrompt';
import { DiffView } from './DiffView';
import type { DiffViewFile } from './DiffView';
import { ClampedToolText } from './ClampedToolText';
import { CopyIconButton } from './CopyIconButton';

export { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';

const isPathKey = (key: string) => key === 'file_path' || key === 'path';
const SEARCH_TOOL_NAMES = new Set(['grep', 'glob', 'codesearch', 'websearch', 'search']);
const STRUCTURED_TOOL_NAMES = new Set(['task', 'apply_patch', 'webfetch']);
const TERMINAL_TOOL_NAMES = new Set(['bash', 'shell', 'terminal', 'exec', 'command']);
const EDIT_TOOL_NAMES = new Set([
  'apply_patch',
  'edit',
  'write',
  'create',
  'delete',
  'rename',
  'patch',
]);
const TODO_TOOL_NAMES = new Set(['todowrite', 'todoread']);
const MIN_VISIBLE_TOOL_DURATION_MS = 1000;

export function getToolCallExpansionKey(part: ToolPart) {
  return `${part.sessionID}\u0000${part.messageID}\u0000${part.callID}`;
}

function normalizeToolName(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  const parts = normalized.split('.');
  return parts[parts.length - 1] || normalized;
}

type ToolCallIconKind =
  | 'terminal'
  | 'search'
  | 'read'
  | 'edit'
  | 'task'
  | 'todo'
  | 'web'
  | 'question'
  | 'skill'
  | 'tools';

function getToolCallIconKind(toolName: string): ToolCallIconKind {
  const normalized = normalizeToolName(toolName);
  if (TERMINAL_TOOL_NAMES.has(normalized)) return 'terminal';
  if (SEARCH_TOOL_NAMES.has(normalized)) return 'search';
  if (normalized === 'read') return 'read';
  if (EDIT_TOOL_NAMES.has(normalized)) return 'edit';
  if (normalized === 'task') return 'task';
  if (TODO_TOOL_NAMES.has(normalized)) return 'todo';
  if (normalized === 'question') return 'question';
  if (normalized === 'skill') return 'skill';
  if (normalized === 'webfetch' || normalized.includes('browser')) return 'web';
  return 'tools';
}

function ToolCallIcon(props: {
  toolName?: string;
  kind?: ToolCallIconKind;
  statusClass?: string;
  statusLabel?: string;
  class?: string;
}) {
  const kind = () => props.kind || getToolCallIconKind(props.toolName || '');
  const classes = () =>
    ['tool-call-icon', `tool-call-icon-${kind()}`, props.statusClass, props.class]
      .filter(Boolean)
      .join(' ');
  const isRunningTask = () => kind() === 'task' && props.statusClass === 'tool-status-running';

  return (
    <Show
      when={isRunningTask()}
      fallback={
        <svg
          class={classes()}
          viewBox="0 0 24 24"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          role={props.statusLabel ? 'status' : undefined}
          aria-label={props.statusLabel}
          aria-live={props.statusLabel ? 'polite' : undefined}
          aria-atomic={props.statusLabel ? 'true' : undefined}
          aria-hidden={props.statusLabel ? undefined : 'true'}
        >
          <Show when={props.statusLabel}>{(label) => <title>{label()}</title>}</Show>
          <Switch>
            <Match when={kind() === 'terminal'}>
              <path d="M13 17H20" />
              <path d="M5 7L10 12L5 17" />
            </Match>
            <Match when={kind() === 'search'}>
              <path d="M17 17L21 21" />
              <path d="M3 11C3 15.4183 6.58172 19 11 19C13.213 19 15.2161 18.1015 16.6644 16.6493C18.1077 15.2022 19 13.2053 19 11C19 6.58172 15.4183 3 11 3C6.58172 3 3 6.58172 3 11Z" />
            </Match>
            <Match when={kind() === 'read'}>
              <path d="M3 13C6.6 5 17.4 5 21 13" />
              <path d="M12 17C10.3431 17 9 15.6569 9 14C9 12.3431 10.3431 11 12 11C13.6569 11 15 12.3431 15 14C15 15.6569 13.6569 17 12 17Z" />
            </Match>
            <Match when={kind() === 'edit'}>
              <path d="M3 21L12 21H21" />
              <path d="M12.2218 5.82839L15.0503 2.99996L20 7.94971L17.1716 10.7781M12.2218 5.82839L6.61522 11.435C6.42769 11.6225 6.32233 11.8769 6.32233 12.1421L6.32233 16.6776L10.8579 16.6776C11.1231 16.6776 11.3774 16.5723 11.565 16.3847L17.1716 10.7781M12.2218 5.82839L17.1716 10.7781" />
            </Match>
            <Match when={kind() === 'task'}>
              <Show
                when={props.statusClass === 'tool-status-completed'}
                fallback={
                  <>
                    <rect x="2" y="21" width="7" height="5" rx="0.6" transform="rotate(-90 2 21)" />
                    <rect
                      x="17"
                      y="15.5"
                      width="7"
                      height="5"
                      rx="0.6"
                      transform="rotate(-90 17 15.5)"
                    />
                    <rect x="2" y="10" width="7" height="5" rx="0.6" transform="rotate(-90 2 10)" />
                    <path
                      d="M7 17.5H10.5C11.6046 17.5 12.5 16.6046 12.5 15.5V8.5C12.5 7.39543 11.6046 6.5 10.5 6.5H7"
                      stroke-linecap="butt"
                      stroke-linejoin="miter"
                    />
                    <path d="M12.5 12H17" stroke-linecap="butt" stroke-linejoin="miter" />
                  </>
                }
              >
                <path d="M7 12.5L10 15.5L17 8.5" />
                <circle cx="12" cy="12" r="10" />
              </Show>
            </Match>
            <Match when={kind() === 'todo'}>
              <path d="M9 6H20M3.8 5.8L4.6 6.6L6.6 4.6M3.8 11.8L4.6 12.6L6.6 10.6M3.8 17.8L4.6 18.6L6.6 16.6M9 12H20M9 18H20" />
            </Match>
            <Match when={kind() === 'web'}>
              <circle cx="12" cy="12" r="10" />
              <path d="M2 12H22M12 2C14.5 4.7 16 8.1 16 12C16 15.9 14.5 19.3 12 22M12 2C9.5 4.7 8 8.1 8 12C8 15.9 9.5 19.3 12 22" />
            </Match>
            <Match when={kind() === 'question'}>
              <circle cx="12" cy="12" r="10" />
              <path d="M9 9C9 5.5 14.5 5.5 14.5 9C14.5 11.5 12 11 12 14M12 18.01L12.01 17.9989" />
            </Match>
            <Match when={kind() === 'skill'}>
              <path d="M4 19V5C4 3.89543 4.89543 3 6 3H19.4C19.7314 3 20 3.26863 20 3.6V16.7143M6 17H20M6 21H20M6 21C4.89543 21 4 20.1046 4 19C4 17.8954 4.89543 17 6 17M9 7H15" />
            </Match>
            <Match when={kind() === 'tools'}>
              <path d="M10.0503 10.6066L2.97923 17.6777C2.19818 18.4587 2.19818 19.7251 2.97923 20.5061C3.76027 21.2872 5.0266 21.2872 5.80765 20.5061L12.8787 13.4351M17.1927 13.7994L21.071 17.6777C21.8521 18.4587 21.8521 19.7251 21.071 20.5061C20.29 21.2872 19.0236 21.2872 18.2426 20.5061L12.0341 14.2977M6.73267 5.90381L4.61135 6.61092L2.49003 3.07539L3.90424 1.66117L7.43978 3.78249L6.73267 5.90381ZM6.73267 5.90381L9.5629 8.73404M10.0503 10.6066C9.2065 8.45359 9.37147 5.62861 11.111 3.8891C12.8505 2.14958 16.0607 1.76778 17.8285 2.82844L14.7878 5.86911L14.5052 8.98015L17.6162 8.69754L20.6569 5.65686C21.7176 7.42463 21.3358 10.6349 19.5963 12.3744C17.8567 14.1139 15.0318 14.2789 12.8788 13.435" />
            </Match>
          </Switch>
        </svg>
      }
    >
      <span
        class={`${classes()} tool-call-spinner`}
        role={props.statusLabel ? 'status' : undefined}
        aria-label={props.statusLabel}
        aria-live={props.statusLabel ? 'polite' : undefined}
        aria-atomic={props.statusLabel ? 'true' : undefined}
        aria-hidden={props.statusLabel ? undefined : 'true'}
        title={props.statusLabel}
      />
    </Show>
  );
}

function isQuestionToolName(toolName: string) {
  return normalizeToolName(toolName) === 'question';
}

type QuestionSummaryItem = {
  question: string;
  answers: string[];
};

function getQuestionSummaryItems(state: ToolPart['state']): QuestionSummaryItem[] {
  if (state.status !== 'completed') return [];

  const questions = Array.isArray(state.input.questions) ? state.input.questions : [];
  const answers = Array.isArray(state.metadata.answers) ? state.metadata.answers : [];

  return questions.flatMap((value, index) => {
    if (!value || typeof value !== 'object') return [];
    const question = (value as Record<string, unknown>).question;
    if (typeof question !== 'string' || !question.trim()) return [];

    const answer = answers[index];
    return [
      {
        question: question.trim(),
        answers: Array.isArray(answer)
          ? answer.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []))
          : [],
      },
    ];
  });
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

/**
 * Whitespace-only output is empty output. A command that "succeeds silently"
 * usually returns a bare newline, which is truthy — treating it as content
 * renders an empty box where the "(no output)" note belongs.
 */
function isBlank(value: string) {
  return value.trim().length === 0;
}

export function getVisibleInputEntries(input: Record<string, unknown>) {
  return Object.entries(input).filter(([, value]) => hasVisibleInputValue(value));
}

export function formatToolTitle(toolName: string, state: ToolPart['state']) {
  const input = (state.input || {}) as Record<string, unknown>;
  const title = getStateTitle(state);
  const normalizedToolName = normalizeToolName(toolName);

  if (SEARCH_TOOL_NAMES.has(normalizedToolName)) {
    const pattern = getSearchPattern(input);
    if (pattern) return `Search: ${pattern}`;
    return title || 'Search';
  }

  if (normalizedToolName === 'task') {
    const description = input.description;
    if (typeof description === 'string' && description.trim()) return description.trim();
  }

  // Error and pending states carry no server title; fall back to the command so
  // failed bash calls keep the same title shape as completed ones.
  if (normalizedToolName === 'bash' && !title) {
    const command = input.command;
    if (typeof command === 'string' && command.trim()) return command.trim();
  }

  return title || toolName;
}

function formatVisibleToolDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || ms < MIN_VISIBLE_TOOL_DURATION_MS) return null;
  return formatDuration(ms) || null;
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

function openFileChangePath(path: string) {
  return (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    postMessage({
      type: 'vscode/open',
      payload: { path, kind: 'file', view: 'diff' },
    });
  };
}

function formatFileChangeDisplayName(path: string | undefined) {
  return path ? formatDisplayPath(path, appState.editorContext.workspacePath) : '';
}

function openGenericToolFile(path: string) {
  postMessage({ type: 'vscode/open', payload: { path, kind: 'file' } });
}

export function ToolCall(props: {
  part: ToolPart;
  questionRequest?: QuestionRequest | null;
  permissionMatch?: ToolCallPermissionMatch | null;
  lightweight?: boolean;
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

  const fileChanges = () => getToolFileChanges(tool().tool, state());
  const isReadTool = () => isToolFileRead(tool().tool);

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

  const inputEntries = createMemo(() => {
    const input = (state().input || {}) as Record<string, unknown>;
    const normalizedTitle = normalizedComparableText(title());
    return getVisibleInputEntries(input).filter(([key, value]) => {
      if (key !== 'description') return true;
      return normalizedComparableText(value) !== normalizedTitle;
    });
  });

  const questionSummaryItems = createMemo(() =>
    isQuestionToolName(tool().tool) ? getQuestionSummaryItems(state()) : []
  );

  // The full text. Detail views clamp what they render and open the rest in an
  // editor tab, which replaced the old head/tail excerpt — that excerpt could
  // cut a closing tag out of the middle of the output.
  const fullOutput = createMemo(() => {
    if (state().status !== 'completed') return '';
    return (state() as ToolStateCompleted).output || '';
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
    if (questionSummaryItems().length > 0) {
      return <QuestionToolSummary title={title()} items={questionSummaryItems()} />;
    }

    if (fileChanges().length > 0) {
      return (
        <FileChangeCard
          toolState={state()}
          changes={fileChanges()}
          previewStateKey={expansionKey()}
          expanded={expanded()}
          toggleExpand={toggleExpand}
        />
      );
    }

    if (isReadTool()) {
      return (
        <ReadToolCard toolState={state()} filePath={filePath()} sessionID={tool().sessionID} />
      );
    }

    return (
      <GenericToolCall
        tool={tool()}
        state={state()}
        statusClass={statusClass()}
        title={title()}
        expanded={expanded() && !props.lightweight}
        toggleExpand={toggleExpand}
        inputEntries={inputEntries()}
        fullOutput={fullOutput()}
        lightweight={props.lightweight}
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

function QuestionToolSummary(props: { title: string; items: QuestionSummaryItem[] }) {
  return (
    <div class="chat-tool-invocation-part question-summary-card">
      <div class="question-summary-header">
        <ToolCallIcon
          kind="question"
          statusClass="tool-status-completed"
          class="question-summary-icon"
        />
        <span class="question-summary-title">{props.title}</span>
      </div>
      <div class="question-summary-list">
        <For each={props.items}>
          {(item) => (
            <div class="question-summary-item">
              <span class="question-summary-question">{item.question}</span>
              <span
                class={`question-summary-answer ${item.answers.length === 0 ? 'is-unanswered' : ''}`}
              >
                {item.answers.length > 0 ? item.answers.join(', ') : 'Unanswered'}
              </span>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function ReadToolCard(props: {
  toolState: ToolPart['state'];
  filePath: string | null;
  sessionID: string;
}) {
  const s = () => props.toolState;
  const isCompleted = () => s().status === 'completed';
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

  const hasFilePath = () => !!props.filePath;
  const normalizedPath = () => (props.filePath ? normalizePath(props.filePath) : '');
  const normalizedSessionDirectory = () =>
    sessionDirectory() ? normalizePath(sessionDirectory() as string) : null;

  const isCurrentDirectory = () =>
    props.filePath === '.' ||
    props.filePath === './' ||
    (!!props.filePath &&
      normalizedSessionDirectory() !== null &&
      normalizedPath() === normalizedSessionDirectory());

  const isDirectory = () => hasFilePath() && (isCurrentDirectory() || isDirectoryOutput(s()));
  const lineRange = () =>
    extractReadRange((s().input || {}) as Record<string, unknown>, metadata());

  const openFile = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (!props.filePath) return;
    const range = lineRange();
    const directory = isDirectory();
    postMessage({
      type: 'vscode/open',
      payload: {
        path: props.filePath,
        kind: directory ? 'directory' : 'file',
        ...(!directory && range ? { line: range.start } : {}),
      },
    });
  };

  const displayName = () => {
    if (!props.filePath) return null;
    if (isCurrentDirectory()) return 'current directory';
    if (isDirectory())
      return formatDisplayPath(props.filePath, appState.editorContext.workspacePath);
    return getLeafPathName(formatDisplayPath(props.filePath, appState.editorContext.workspacePath));
  };
  const completedDurationLabel = () =>
    isCompleted()
      ? formatVisibleToolDuration(
          (s() as ToolStateCompleted).time.end - (s() as ToolStateCompleted).time.start
        )
      : null;

  return (
    <div class="chat-tool-invocation-part file-read-card">
      <div class="file-read-card-header">
        <ToolCallIcon kind="read" statusClass={statusClass()} />
        <span
          class={`file-read-action-label${s().status === 'running' ? ' shimmer-progress' : ''}`}
        >
          {displayName() ? 'Read:' : 'Read'}
        </span>
        <Show when={displayName()}>
          {(name) => (
            <Show
              when={!isCurrentDirectory()}
              fallback={<span class="file-read-target file-read-target-text">{name()}</span>}
            >
              <a href="#" class="file-path-link file-read-target" onClick={openFile}>
                {name()}
              </a>
            </Show>
          )}
        </Show>
        <Show when={hasFilePath() && !isDirectory() && lineRange()}>
          <span class="file-read-range">
            (L{lineRange()!.start}-{lineRange()!.end})
          </span>
        </Show>
        <Show when={isDirectory() && !isCurrentDirectory()}>
          <span class="file-read-meta">directory</span>
        </Show>
        <Show when={completedDurationLabel()}>
          <span class="tool-invocation-duration file-read-duration">
            {completedDurationLabel()}
          </span>
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
  changes: FileChange[];
  previewStateKey: string;
  expanded: boolean;
  toggleExpand: () => void;
}) {
  let moreButtonRef: HTMLButtonElement | undefined;
  let moreMenuRef: HTMLDivElement | undefined;
  const [moreMenuOpen, setMoreMenuOpen] = createSignal(false);
  const s = () => props.toolState;
  const isCompleted = () => s().status === 'completed';
  const isPending = () => s().status === 'pending';
  const isRunning = () => s().status === 'running';
  const isError = () => s().status === 'error';
  const isAborted = () => isAbortedToolError(s());
  const summaries = () => props.changes.filter((item) => item.isSummary);
  const changes = () => props.changes.filter((item) => !item.isSummary);
  const change = () => changes()[0];
  const hasTruncatedSummary = () => summaries().length > 0;
  const isMultiFile = () => changes().length > 1 || hasTruncatedSummary();
  const effectiveKind = () => (isMultiFile() ? 'edited' : (change()?.kind ?? 'edited'));
  const fileCountLabel = () => {
    const count = changes().length;
    if (count === 0) return 'Files';
    return `${count}${hasTruncatedSummary() ? '+' : ''} file${count === 1 ? '' : 's'}`;
  };
  const visibleMultiFileCount = () => (changes().length > 2 ? 1 : changes().length);
  const visibleMultiFileChanges = () => changes().slice(0, visibleMultiFileCount());
  const hiddenMultiFileChanges = () => changes().slice(visibleMultiFileCount());
  const hiddenMultiFileCount = () => hiddenMultiFileChanges().length;
  const hasInlinePreviewContent = () =>
    changes().some(
      (item) =>
        item.patch !== undefined ||
        item.before !== undefined ||
        item.after !== undefined ||
        item.previewStatus !== undefined
    );
  const showInlinePreview = () => showInlineFileChanges() && hasInlinePreviewContent();
  const showCompactCard = () => !isCompleted() || !showInlinePreview();
  const inlineDiffs = createMemo<DiffViewFile[]>(() =>
    changes().map((item) => ({
      file: item.toPath || item.path,
      fromFile: item.kind === 'moved' ? item.fromPath : undefined,
      changeKind: item.kind,
      status: item.kind === 'added' ? 'added' : item.kind === 'removed' ? 'deleted' : 'modified',
      before: item.before,
      after: item.after,
      patch: item.patch,
      patchFormat: item.patchFormat,
      previewStatus: item.previewStatus,
      previewMessage: item.previewMessage,
      additions: item.additions ?? (item.kind === 'added' ? countContentLines(item.after) : 0),
      deletions: item.deletions ?? (item.kind === 'removed' ? countContentLines(item.before) : 0),
    }))
  );

  createEffect(() => {
    if (hiddenMultiFileCount() === 0) setMoreMenuOpen(false);
  });

  createEffect(() => {
    if (!moreMenuOpen()) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (moreButtonRef?.contains(target) || moreMenuRef?.contains(target))) return;
      setMoreMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMoreMenuOpen(false);
      moreButtonRef?.focus();
    };

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    });
  });

  const action = () => {
    const completed = isCompleted();
    switch (effectiveKind()) {
      case 'added':
        return completed ? 'Added' : 'Add';
      case 'removed':
        return completed ? 'Removed' : 'Remove';
      case 'moved':
        return completed ? 'Moved' : 'Move';
      default:
        return completed ? 'Edited' : 'Edit';
    }
  };

  const statusClass = () => {
    if (isPending()) return 'tool-status-pending';
    if (isRunning()) return 'tool-status-running';
    if (isError()) return isAborted() ? 'tool-status-aborted' : 'tool-status-error';
    return 'tool-status-completed';
  };

  const statusLabel = () => {
    if (isPending()) return 'Pending';
    if (isRunning()) return 'Running';
    if (isError()) return isAborted() ? 'Aborted' : 'Failed';
    return 'Completed';
  };

  const diffStats = () => {
    if (!isCompleted()) return null;
    const fromChanges = changes().reduce(
      (acc, item) => {
        acc.additions += item.additions || 0;
        acc.deletions += item.deletions || 0;
        acc.hasStats = acc.hasStats || item.additions !== undefined || item.deletions !== undefined;
        return acc;
      },
      { additions: 0, deletions: 0, hasStats: false }
    );
    if (fromChanges.hasStats) {
      return { additions: fromChanges.additions, deletions: fromChanges.deletions };
    }
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
  const completedDurationLabel = () =>
    isCompleted()
      ? formatVisibleToolDuration(
          (s() as ToolStateCompleted).time.end - (s() as ToolStateCompleted).time.start
        )
      : null;
  const errorMessage = () => {
    if (!isError()) return null;
    const message = (s() as ToolStateError).error.trim();
    return message || null;
  };
  const errorBodyId = createUniqueId();
  const isErrorExpanded = () => Boolean(errorMessage()) && props.expanded;

  return (
    <>
      <Show when={showCompactCard()}>
        <div class="chat-tool-invocation-part file-change-card">
          <div
            class={`file-change-card-header${errorMessage() ? ' is-expandable' : ''}`}
            onClick={errorMessage() ? props.toggleExpand : undefined}
          >
            <ToolCallIcon
              kind="edit"
              statusClass={statusClass()}
              statusLabel={statusLabel()}
              class="file-edit-icon"
            />
            <span class={`file-edit-action-label${isRunning() ? ' shimmer-progress' : ''}`}>
              {action()}:
            </span>
            <Show
              when={!isMultiFile() && change()}
              fallback={<span class="file-edit-summary-label">{fileCountLabel()}</span>}
            >
              <Show
                when={effectiveKind() !== 'moved'}
                fallback={
                  <span class="file-edit-move-paths">
                    <a
                      href="#"
                      class="file-path-link file-edit-path-link"
                      onClick={openFileChangePath(change()!.fromPath || change()!.path)}
                    >
                      {formatFileChangeDisplayName(change()!.fromPath || change()!.path)}
                    </a>
                    <span class="file-edit-move-arrow">→</span>
                    <a
                      href="#"
                      class="file-path-link file-edit-path-link"
                      onClick={openFileChangePath(change()!.toPath || change()!.path)}
                    >
                      {formatFileChangeDisplayName(change()!.toPath || change()!.path)}
                    </a>
                  </span>
                }
              >
                <a
                  href="#"
                  class="file-path-link file-edit-path-link"
                  onClick={openFileChangePath(change()!.path)}
                >
                  {formatFileChangeDisplayName(change()!.path)}
                </a>
              </Show>
            </Show>
            <Show when={isMultiFile() && changes().length > 0}>
              <span class="file-edit-multi-list">
                <For each={visibleMultiFileChanges()}>
                  {(item) => {
                    const displayName = () => formatFileChangeDisplayName(item.toPath || item.path);
                    return (
                      <a
                        href="#"
                        class="file-path-link file-edit-path-link"
                        title={displayName()}
                        onClick={openFileChangePath(item.toPath || item.path)}
                      >
                        {displayName()}
                      </a>
                    );
                  }}
                </For>
                <Show when={hiddenMultiFileCount() > 0}>
                  <span class="file-edit-more-wrap">
                    <button
                      ref={(el) => (moreButtonRef = el)}
                      type="button"
                      class="file-edit-more-count"
                      aria-haspopup="menu"
                      aria-expanded={moreMenuOpen()}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMoreMenuOpen((open) => !open);
                      }}
                    >
                      +{hiddenMultiFileCount()} more
                    </button>
                    <Show when={moreMenuOpen()}>
                      <div
                        ref={(el) => (moreMenuRef = el)}
                        class="file-edit-more-menu"
                        role="menu"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <For each={hiddenMultiFileChanges()}>
                          {(item) => {
                            const path = () => item.toPath || item.path;
                            const displayName = () => formatFileChangeDisplayName(path());
                            return (
                              <a
                                href="#"
                                class="file-edit-more-menu-item"
                                role="menuitem"
                                title={displayName()}
                                onClick={(event) => {
                                  setMoreMenuOpen(false);
                                  openFileChangePath(path())(event);
                                }}
                              >
                                <span class="file-edit-more-menu-path">{displayName()}</span>
                              </a>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </span>
                </Show>
              </span>
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
            <Show when={errorMessage()}>
              <button
                type="button"
                class="file-edit-error-toggle"
                onClick={(event) => {
                  event.stopPropagation();
                  props.toggleExpand();
                }}
                aria-expanded={isErrorExpanded()}
                aria-controls={errorBodyId}
                aria-label={
                  isErrorExpanded() ? 'Collapse file change error' : 'Expand file change error'
                }
              >
                <svg
                  class={`tool-invocation-chevron ${isErrorExpanded() ? 'expanded' : ''}`}
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 4l4 4-4 4" />
                </svg>
              </button>
            </Show>
            <Show when={completedDurationLabel()}>
              <span class="tool-invocation-duration file-edit-duration">
                {completedDurationLabel()}
              </span>
            </Show>
          </div>
          <Show when={isErrorExpanded() && errorMessage()}>
            {(message) => (
              <ClampedToolText
                id={errorBodyId}
                content={message()}
                title={`${action()} error`}
                language="plaintext"
                class="file-edit-error-detail"
                role="alert"
                aria-label="File change error"
              />
            )}
          </Show>
        </div>
      </Show>
      <For each={summaries()}>
        {(summary) => (
          <div class="file-change-truncated-summary" role="note">
            {summary.previewMessage}
          </div>
        )}
      </For>
      <Show when={showInlinePreview()}>
        <div class="file-change-inline-diffs file-change-inline-diffs-unwrapped">
          <DiffView diffs={inlineDiffs()} showChanges stateKey={props.previewStateKey} />
        </div>
      </Show>
    </>
  );
}

function countContentLines(content: string | undefined) {
  if (!content) return 0;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

type StructuredToolResult = {
  label: string;
  value: string;
  status?: 'error' | 'aborted';
};

function GenericToolCall(props: {
  tool: ToolPart;
  state: ToolPart['state'];
  statusClass: string;
  title: string;
  expanded: boolean;
  toggleExpand: () => void;
  inputEntries: Array<[string, unknown]>;
  fullOutput: string;
  lightweight?: boolean;
}) {
  const toolName = () => normalizeToolName(props.tool.tool);
  const isAborted = () => isAbortedToolError(props.state);
  const isBash = () => toolName() === 'bash';
  const isTask = () => toolName() === 'task';
  const isStructuredTool = () => isStructuredToolName(props.tool.tool);
  const isSearchTool = () => SEARCH_TOOL_NAMES.has(toolName());
  // Search results are inputs-plus-output like task/apply_patch, so they share the
  // framed labeled-row card instead of the unframed key/value + bare <pre> body.
  const usesStructuredCard = () => isStructuredTool() || isSearchTool();
  const taskAgentLabel = () => {
    const type = props.state.input?.subagent_type;
    if (typeof type !== 'string' || !type.trim()) return 'Subagent';
    const label = type.trim();
    return `${label.charAt(0).toUpperCase()}${label.slice(1)} subagent`;
  };
  const taskSessionId = () => {
    if (!isTask()) return null;
    if (
      props.state.status !== 'running' &&
      props.state.status !== 'completed' &&
      props.state.status !== 'error'
    ) {
      return null;
    }

    return resolveTaskSessionId(props.tool, appState.messages, appState.sessions);
  };
  const taskExecutionEntries = createMemo<Array<[string, unknown]>>(() => {
    const sessionId = taskSessionId();
    let latest: AssistantMessage | null = null;
    if (sessionId) {
      for (const entry of appState.messages) {
        const info = entry.info;
        if (info.role !== 'assistant' || info.sessionID !== sessionId) continue;
        if (!latest || info.time.created >= latest.time.created) latest = info;
      }
    }

    const type = props.state.input?.subagent_type;
    const agent =
      typeof type === 'string' && type.trim()
        ? appState.allAgents.find((candidate) => candidate.name === type.trim())
        : null;
    const parentEntry = appState.messages.find((entry) => entry.info.id === props.tool.messageID);
    const parent = parentEntry?.info.role === 'assistant' ? parentEntry.info : null;
    const model = latest || agent?.model || parent;
    if (!model) return [];
    const reasoning = latest
      ? latest.variant
      : agent?.variant || agent?.model?.variant || (!agent?.model ? parent?.variant : undefined);

    return [
      ['model', `${model.providerID}/${model.modelID}`],
      ['reasoning', reasoning || 'default'],
    ];
  });
  const detailInputEntries = createMemo(() => {
    if (!isTask()) return props.inputEntries;
    const keys = new Set(props.inputEntries.map(([key]) => key));
    return [...props.inputEntries, ...taskExecutionEntries().filter(([key]) => !keys.has(key))];
  });
  const taskTokenUsage = createMemo(() => {
    const sessionId = taskSessionId();
    if (!sessionId) return null;

    const sessionTokens = appState.sessions.find((session) => session.id === sessionId)?.tokens;
    if (sessionTokens) {
      return {
        input: sessionTokens.input || 0,
        output: sessionTokens.output || 0,
      };
    }

    let input = 0;
    let output = 0;
    for (const entry of appState.messages) {
      const info = entry.info;
      if (info.role !== 'assistant' || info.sessionID !== sessionId) continue;
      input += info.tokens.input || 0;
      output += info.tokens.output || 0;
    }

    return { input, output };
  });
  const taskRetryStatus = () => {
    if (props.state.status !== 'running') return null;
    const sessionId = taskSessionId();
    if (!sessionId) return null;
    const status = appState.sessionStatus[sessionId];
    return status?.type === 'retry' ? status : null;
  };
  const openTaskSession = () => {
    const sessionId = taskSessionId();
    if (!sessionId) return;
    rememberDirectSessionReturn(sessionId, appState.activeSessionId || props.tool.sessionID);
    void selectSession(sessionId);
  };
  const bashCommand = () => {
    const command = props.state.input?.command;
    return typeof command === 'string'
      ? formatCommandDisplay(command, appState.editorContext.workspacePath)
      : '';
  };
  const bashOutput = () => {
    if (props.state.status !== 'completed') return '';
    return isBlank(props.fullOutput) ? '(no output)' : props.fullOutput;
  };
  const bashOutputIsEmpty = () => props.state.status === 'completed' && isBlank(props.fullOutput);
  // These read the full output rather than the head/tail excerpt: the excerpt
  // can drop a closing </task_result> from the middle, and the clamped view
  // needs the real text so "show all" opens the whole thing.
  const taskResult = () => {
    if (props.state.status !== 'completed') return { label: 'result', value: '' };
    const extracted = extractTaggedOutput(props.fullOutput, 'task_result');
    if (extracted !== null) {
      return { label: 'task_result', value: isBlank(extracted) ? '(no output)' : extracted };
    }
    return { label: 'result', value: isBlank(props.fullOutput) ? '(no output)' : props.fullOutput };
  };
  const structuredResult = (): StructuredToolResult | null => {
    if (props.state.status === 'error') {
      return {
        label: 'error',
        value: props.state.error,
        status: isAborted() ? 'aborted' : 'error',
      };
    }
    if (props.state.status !== 'completed') return null;
    if (isTask()) return taskResult();
    if (isSearchTool()) {
      return {
        label: 'results',
        value: isBlank(props.fullOutput) ? '(no matches)' : props.fullOutput,
      };
    }
    return { label: 'result', value: isBlank(props.fullOutput) ? '(no output)' : props.fullOutput };
  };
  const completedDurationMs = () => {
    if (props.state.status !== 'completed') return null;
    const state = props.state as ToolStateCompleted;
    return Math.max(0, state.time.end - state.time.start);
  };
  const completedDurationLabel = () => formatVisibleToolDuration(completedDurationMs());
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (!isTask() || props.state.status !== 'running') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const runningDurationLabel = () => {
    if (!isTask() || props.state.status !== 'running') return null;
    return formatDuration(Math.max(0, now() - props.state.time.start)) || '0ms';
  };
  const hasExpandableContent = () => {
    if (props.lightweight) return false;
    if (props.state.status === 'error') return true;
    if (detailInputEntries().length > 0) return true;
    // Whitespace-only output is not expandable content: offering a chevron that
    // opens onto an empty box is worse than no chevron.
    return props.state.status === 'completed' && !isBlank(props.fullOutput);
  };
  const isExpanded = () => hasExpandableContent() && props.expanded;

  // The bash card repeats the command as its `$` row, which is pure duplication
  // when the header already shows the whole thing. The header ellipsizes at
  // whatever width the panel happens to be, so this has to be measured rather
  // than guessed — and it starts `true` so an unmeasured card errs toward
  // showing the command instead of hiding it.
  let titleRef: HTMLSpanElement | undefined;
  const [titleClipped, setTitleClipped] = createSignal(true);
  const measureTitle = () => {
    if (titleRef) setTitleClipped(titleRef.scrollWidth > titleRef.clientWidth + 1);
  };
  createEffect(() => {
    if (!isBash() || !isExpanded() || !titleRef) return;
    // On a user-driven expand the header has been laid out for a while, so
    // measure now — deferring would render the row and then yank it away. The
    // microtask covers the other case: a card that starts expanded, where this
    // effect runs before the header has any layout to read.
    measureTitle();
    queueMicrotask(measureTitle);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measureTitle);
    observer.observe(titleRef);
    onCleanup(() => observer.disconnect());
  });
  const commandMatchesTitle = () =>
    normalizedComparableText(bashCommand()) === normalizedComparableText(props.title);
  // Never hide the command while it is the card's only content: without a
  // completed output row the detail body would render empty.
  const showBashCommandRow = () =>
    props.state.status !== 'completed' || titleClipped() || !commandMatchesTitle();

  const bodyId = createUniqueId();
  return (
    <div class={`chat-tool-invocation-part${isTask() ? ' tool-invocation-task' : ''}`}>
      <button
        type="button"
        class="tool-invocation-header"
        onClick={props.toggleExpand}
        disabled={!hasExpandableContent()}
        aria-expanded={hasExpandableContent() ? isExpanded() : undefined}
        aria-controls={hasExpandableContent() ? bodyId : undefined}
      >
        <ToolCallIcon toolName={props.tool.tool} statusClass={props.statusClass} />
        <span
          ref={(el) => (titleRef = el)}
          class={`tool-invocation-title${props.state.status === 'running' && !isTask() ? ' shimmer-progress' : ''}`}
        >
          {props.title}
        </span>
        <Show when={taskTokenUsage()}>
          {(tokens) => (
            <span class="tool-invocation-token-stats" title="Subagent tokens">
              ↑ {formatNumber(tokens().input)} ↓ {formatNumber(tokens().output)}
            </span>
          )}
        </Show>
        <Show when={completedDurationLabel()}>
          <span class="tool-invocation-duration">{completedDurationLabel()}</span>
        </Show>
        <Show when={runningDurationLabel()}>
          <span class="tool-invocation-duration" title="Elapsed time">
            {runningDurationLabel()}
          </span>
        </Show>
        <Show when={taskRetryStatus()}>
          {(retry) => <span class="tool-invocation-retry-label">retrying #{retry().attempt}</span>}
        </Show>
        <Show when={props.state.status === 'error'}>
          <span class={`tool-invocation-error-label${isAborted() ? ' is-aborted' : ''}`}>
            {isAborted() ? 'aborted' : 'failed'}
          </span>
        </Show>
        <Show when={hasExpandableContent()}>
          <svg
            class={`tool-invocation-chevron ${isExpanded() ? 'expanded' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M6 4l4 4-4 4" />
          </svg>
        </Show>
      </button>
      <Show when={isExpanded()}>
        <div id={bodyId} class="tool-invocation-detail animate-fade-in">
          <Show
            when={isBash() && bashCommand()}
            fallback={
              <Show
                when={usesStructuredCard()}
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
                                  openGenericToolFile(String(value));
                                }}
                              >
                                {formatDisplayPath(
                                  String(value),
                                  appState.editorContext.workspacePath
                                )}
                              </a>
                            ) : (
                              <>
                                <span class="tool-input-value">{formatValue(key, value)}</span>
                                <CopyIconButton text={formatValue(key, value)} label={key} />
                              </>
                            )}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                }
              >
                <StructuredToolCard
                  inputEntries={detailInputEntries()}
                  result={structuredResult()}
                  onOpenPath={openGenericToolFile}
                  toolTitle={props.title}
                />
              </Show>
            }
          >
            <div class="terminal-command-card">
              <Show when={showBashCommandRow()}>
                <TerminalCommandRow command={bashCommand()} />
              </Show>
              <Show when={props.state.status === 'completed'}>
                <div class="terminal-command-row terminal-command-row-output">
                  <Show
                    when={!bashOutputIsEmpty()}
                    fallback={
                      <pre class="terminal-command-text terminal-command-output terminal-command-output-empty">
                        {bashOutput()}
                      </pre>
                    }
                  >
                    <ClampedToolText
                      content={props.fullOutput}
                      title={`${props.title} (output)`}
                      class="terminal-command-text terminal-command-output"
                    />
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
          <Show
            when={
              !isBash() &&
              !usesStructuredCard() &&
              props.state.status === 'completed' &&
              !isBlank(props.fullOutput)
            }
          >
            <ClampedToolText
              content={props.fullOutput}
              title={`${props.title} (output)`}
              class="tool-invocation-output"
            />
          </Show>
          <Show when={props.state.status === 'error' && !usesStructuredCard()}>
            <ClampedToolText
              content={(props.state as ToolStateError).error}
              title={`${props.title} (error)`}
              language="plaintext"
              class={`tool-invocation-error${isAborted() ? ' is-aborted' : ''}`}
            />
          </Show>
          <Show when={props.state.status === 'running' && !isBash()}>
            <Show when={isTask()} fallback={<div class="tool-invocation-running">Running…</div>}>
              <button
                type="button"
                class={`tool-invocation-running tool-invocation-subagent-running${taskRetryStatus() ? ' is-retrying' : ''}`}
                onClick={openTaskSession}
                disabled={!taskSessionId()}
                aria-live="polite"
                title={taskSessionId() ? 'Open subagent session' : undefined}
              >
                <svg
                  class="tool-invocation-working-icon"
                  viewBox="0 0 24 24"
                  width="12"
                  height="12"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 12C15.866 12 19 8.86599 19 5H5C5 8.86599 8.13401 12 12 12ZM12 12C15.866 12 19 15.134 19 19H5C5 15.134 8.13401 12 12 12Z" />
                  <path d="M5 2H12H19" />
                  <path d="M5 22H12H19" />
                </svg>
                <span class="tool-invocation-running-copy">
                  <strong class="tool-invocation-running-label">
                    {taskRetryStatus()
                      ? `${taskAgentLabel()} is retrying`
                      : `${taskAgentLabel()} is working`}
                  </strong>
                  <span class="tool-invocation-running-detail">
                    <Show when={taskRetryStatus()} fallback="Results will appear here when ready.">
                      {(retry) => `Attempt ${retry().attempt} · ${retry().message}`}
                    </Show>
                  </span>
                </span>
              </button>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/**
 * The command always occupies exactly one row — it is a label for the output
 * below it, not something to read in full here. Copy is the escape hatch, so
 * an ellipsized command is still recoverable in one click.
 */
function TerminalCommandRow(props: { command: string }) {
  return (
    <div class="terminal-command-row terminal-command-row-input">
      <span class="terminal-command-prompt" aria-hidden="true">
        $
      </span>
      <pre class="terminal-command-text terminal-command-single-line">{props.command}</pre>
      <CopyIconButton text={props.command} label="command" />
    </div>
  );
}

function StructuredToolCard(props: {
  inputEntries: Array<[string, unknown]>;
  result: StructuredToolResult | null;
  onOpenPath: (path: string) => void;
  /** Prefixes editor-tab titles so an opened value says which tool it came from. */
  toolTitle: string;
}) {
  const promptEntry = () => props.inputEntries.find(([key]) => key === 'prompt') || null;
  const nonPromptEntries = () => props.inputEntries.filter(([key]) => key !== 'prompt');

  return (
    <div class="structured-tool-card">
      <For each={nonPromptEntries()}>
        {([key, value]) => {
          const blockValue = shouldShowStructuredToolValueAsBlock(key, value);
          return (
            <div class="structured-tool-row">
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
              ) : blockValue ? (
                <ClampedToolText
                  content={formatExpandedValue(key, value)}
                  title={`${props.toolTitle} (${key})`}
                  class="structured-tool-value"
                />
              ) : (
                // Scalar inputs are identifiers, not prose: one line each, with
                // copy so an ellipsized tail is still recoverable.
                <div class="structured-tool-value-line">
                  <pre class="structured-tool-value structured-tool-value-single">
                    {formatExpandedValue(key, value)}
                  </pre>
                  <CopyIconButton text={formatExpandedValue(key, value)} label={key} />
                </div>
              )}
            </div>
          );
        }}
      </For>
      <Show when={promptEntry()}>
        {(entry) => (
          <div class="structured-tool-row">
            <span class="structured-tool-label">{entry()[0]}</span>
            <ClampedToolText
              content={formatExpandedValue(entry()[0], entry()[1])}
              title={`${props.toolTitle} (${entry()[0]})`}
              class="structured-tool-value"
            />
          </div>
        )}
      </Show>
      <Show when={props.result}>
        {(result) => (
          <div
            class={`structured-tool-row structured-tool-row-result${result().status ? ' structured-tool-row-error' : ''}`}
          >
            <span class="structured-tool-label">{result().label}</span>
            <ClampedToolText
              content={result().value}
              title={`${props.toolTitle} (${result().label})`}
              class={`structured-tool-value structured-tool-value-result${
                result().status
                  ? ` tool-invocation-error${result().status === 'aborted' ? ' is-aborted' : ''}`
                  : ''
              }`}
            />
          </div>
        )}
      </Show>
    </div>
  );
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
