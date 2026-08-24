import {
  Show,
  For,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  isAbortedToolError,
  isPermissionRejectedToolError,
  isQuestionSkippedToolError,
} from '../../shared/error-classification';
import { asRecord } from '../../shared/type-utils';
import type { UnknownRecord } from '../../shared/type-utils';
import type { AssistantMessage, QuestionRequest, ToolPart } from '../types';
import { postMessage } from '../lib/bridge';
import {
  state as appState,
  getPermissionGroupMembers,
  getSessionTreeIds,
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
import { getToolKind, isApplyPatchTool, normalizeToolName } from '../lib/tool-normalization';
import type { ToolKind } from '../lib/tool-normalization';
import { rememberDirectSessionReturn } from '../lib/session-navigation';
import { selectSession } from '../hooks/useOpenCode';
import { QuestionPrompt } from './QuestionPrompt';
import { PermissionPrompt } from './PermissionPrompt';
import { DiffView } from './DiffView';
import type { DiffViewFile } from './DiffView';
import { ClampedToolText } from './ClampedToolText';
import { CopyIconButton } from './CopyIconButton';
import { FileTypeIcon } from './FileTypeIcon';
import { isBoolean, isNumber, isString } from '../lib/runtime-values';
import {
  bookIcon,
  cableTagIcon,
  checkCircleIcon,
  editPencilIcon,
  eyeIcon,
  helpCircleIcon,
  hourglassIcon,
  languageIcon,
  navArrowRightIcon,
  searchIcon,
  taskListIcon,
  terminalIcon,
  toolsIcon,
} from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

export { resetToolCallExpansionState } from '../lib/tool-call-expansion-state';

const isPathKey = (key: string) => key === 'file_path' || key === 'path';
const MIN_VISIBLE_TOOL_DURATION_MS = 1000;
const [taskActivityAltPressed, setTaskActivityAltPressed] = createSignal(false);
let taskActivityAltListenerCount = 0;

function handleTaskActivityAltKeydown(event: KeyboardEvent) {
  if (event.key === 'Alt') setTaskActivityAltPressed(true);
}

function handleTaskActivityAltKeyup(event: KeyboardEvent) {
  if (event.key === 'Alt') setTaskActivityAltPressed(false);
}

function handleTaskActivityAltMousemove(event: MouseEvent) {
  setTaskActivityAltPressed(event.altKey);
}

function handleTaskActivityAltBlur() {
  setTaskActivityAltPressed(false);
}

function retainTaskActivityAltListener() {
  if (taskActivityAltListenerCount === 0) {
    window.addEventListener('keydown', handleTaskActivityAltKeydown);
    window.addEventListener('keyup', handleTaskActivityAltKeyup);
    window.addEventListener('mousemove', handleTaskActivityAltMousemove);
    window.addEventListener('blur', handleTaskActivityAltBlur);
  }
  taskActivityAltListenerCount += 1;

  return () => {
    taskActivityAltListenerCount -= 1;
    if (taskActivityAltListenerCount > 0) return;
    window.removeEventListener('keydown', handleTaskActivityAltKeydown);
    window.removeEventListener('keyup', handleTaskActivityAltKeyup);
    window.removeEventListener('mousemove', handleTaskActivityAltMousemove);
    window.removeEventListener('blur', handleTaskActivityAltBlur);
    setTaskActivityAltPressed(false);
  };
}

export function getToolCallExpansionKey(part: ToolPart) {
  return `${part.sessionID}\u0000${part.messageID}\u0000${part.callID}`;
}

function ToolCallIcon(props: {
  toolName?: string;
  kind?: ToolKind;
  statusClass?: string;
  statusLabel?: string;
  waiting?: boolean;
  class?: string;
}) {
  const kind = () => props.kind || getToolKind(props.toolName || '');
  const classes = () =>
    ['tool-call-icon', `tool-call-icon-${kind()}`, props.statusClass, props.class]
      .filter(Boolean)
      .join(' ');
  const isWaiting = () => !!props.waiting;
  const isRunningTask = () =>
    kind() === 'task' && props.statusClass === 'tool-status-running' && !isWaiting();
  const iconSize = () => (isWaiting() || kind() === 'task' ? '16' : '12');
  const source = () => {
    if (isWaiting()) return hourglassIcon;
    switch (kind()) {
      case 'terminal':
        return terminalIcon;
      case 'search':
        return searchIcon;
      case 'read':
        return eyeIcon;
      case 'edit':
        return editPencilIcon;
      case 'task':
        return props.statusClass === 'tool-status-completed' ? checkCircleIcon : cableTagIcon;
      case 'todo':
        return taskListIcon;
      case 'web':
        return languageIcon;
      case 'question':
        return helpCircleIcon;
      case 'skill':
        return bookIcon;
      case 'tools':
        return toolsIcon;
    }
  };

  return (
    <Show
      when={isRunningTask()}
      fallback={
        <UiIcon
          source={source()}
          class={`${classes()}${isWaiting() ? ' tool-call-wait-icon' : ''}`}
          width={iconSize()}
          height={iconSize()}
          role={props.statusLabel ? 'status' : undefined}
          aria-label={props.statusLabel}
          aria-live={props.statusLabel ? 'polite' : undefined}
          aria-atomic={props.statusLabel ? 'true' : undefined}
          aria-hidden={props.statusLabel ? undefined : 'true'}
          title={props.statusLabel}
        />
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
  return getToolKind(toolName) === 'question';
}

type QuestionSummaryItem = {
  question: string;
  answers: string[];
};

function getQuestionSummaryItems(state: ToolPart['state']): QuestionSummaryItem[] {
  if (state.status !== 'completed' && !isQuestionSkippedToolError(state)) return [];

  const questions = Array.isArray(state.input.questions) ? state.input.questions : [];
  const answers =
    state.status === 'completed' && Array.isArray(state.metadata.answers)
      ? state.metadata.answers
      : [];

  return questions.flatMap((value, index) => {
    const question = asRecord(value)?.question;
    if (!isString(question) || !question.trim()) return [];

    const answer = answers[index];
    return [
      {
        question: question.trim(),
        answers: Array.isArray(answer)
          ? answer.flatMap((item) => (isString(item) && item.trim() ? [item.trim()] : []))
          : [],
      },
    ];
  });
}

function getSearchPattern(input: UnknownRecord) {
  for (const key of ['pattern', 'query']) {
    const value = input[key];
    if (isString(value) && value.trim()) return value.trim();
  }
  return null;
}

function getStateTitle(state: ToolPart['state']) {
  if (state.status !== 'running' && state.status !== 'completed') return '';
  return state.title?.trim() || '';
}

function hasVisibleInputValue<T>(value: T) {
  if (value === undefined || value === null) return false;
  if (isString(value)) return value.trim().length > 0;
  return true;
}

function normalizedComparableText<T>(value: T) {
  return isString(value) ? value.trim().toLowerCase() : '';
}

/**
 * Whitespace-only output is empty output. A command that "succeeds silently"
 * usually returns a bare newline, which is truthy - treating it as content
 * renders an empty box where the "(no output)" note belongs.
 */
function isBlank(value: string) {
  return value.trim().length === 0;
}

function getRunningToolOutput(state: ToolPart['state']) {
  if (state.status !== 'running') return '';
  const metadata = state.metadata;
  const content = metadata?.content;

  if (isString(content)) return content;
  if (Array.isArray(content)) {
    const text = content
      .flatMap((item) => {
        const value = asRecord(item);
        if (!value) return [];
        return value.type === 'text' && isString(value.text) ? [value.text] : [];
      })
      .join('\n');
    if (text) return text;
  }

  for (const key of ['output', 'progress']) {
    const value = metadata?.[key];
    if (isString(value)) return value;
  }
  return '';
}

export function getVisibleInputEntries(input: UnknownRecord) {
  return Object.entries(input).filter(([, value]) => hasVisibleInputValue(value));
}

export function formatToolTitle(toolName: string, state: ToolPart['state']) {
  const input = asRecord(state.input) ?? {};
  const title = getStateTitle(state);
  const normalizedToolName = normalizeToolName(toolName);

  if (getToolKind(normalizedToolName) === 'search') {
    const pattern = getSearchPattern(input);
    if (pattern) return `Search: ${pattern}`;
    return title || 'Search';
  }

  if (normalizedToolName === 'task') {
    const description = input.description;
    if (isString(description) && description.trim()) return description.trim();
  }

  // Error and pending states carry no server title; fall back to the command so
  // failed bash calls keep the same title shape as completed ones.
  if (normalizedToolName === 'bash' && !title) {
    const command = input.command;
    if (isString(command) && command.trim()) return command.trim();
  }

  return title || toolName;
}

function formatVisibleToolDuration(ms: number | null | undefined) {
  if (ms === null || ms === undefined || ms < MIN_VISIBLE_TOOL_DURATION_MS) return null;
  return formatDuration(ms) || null;
}

function parseIntLike<T>(value: T): number | null {
  if (isNumber(value) && Number.isFinite(value)) return Math.trunc(value);
  if (isString(value) && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

type SearchResultCount = {
  count: number;
  truncated: boolean;
};

function getSearchResultCount(
  toolName: string,
  state: ToolPart['state']
): SearchResultCount | null {
  if (getToolKind(toolName) !== 'search' || state.status !== 'completed') return null;

  const output = state.output || '';
  const truncated =
    state.metadata.truncated === true ||
    /\bmore matches available\b|\bresults (?:are )?truncated\b/i.test(output);
  const metadataCount = parseIntLike(state.metadata.matches) ?? parseIntLike(state.metadata.count);
  if (metadataCount !== null && metadataCount >= 0) return { count: metadataCount, truncated };

  const found = output.match(/^\s*Found\s+(\d+)\s+(?:matches|files|results)\b/im);
  if (found?.[1]) return { count: Number.parseInt(found[1], 10), truncated };
  if (/^\s*No (?:files|matches|search results?) found\b/im.test(output)) {
    return { count: 0, truncated: false };
  }

  if (normalizeToolName(toolName) !== 'glob') return null;
  const files = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('(Results are truncated'));
  return files.length > 0 ? { count: files.length, truncated } : null;
}

function extractTaggedOutput(output: string, tagName: string): string | null {
  const match = output.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*<\\/${tagName}>`, 'i'));
  if (!match) return null;
  const [, content = ''] = match;
  return content.trim();
}

function extractReadRange(
  input: UnknownRecord,
  metadata: UnknownRecord | undefined
): { start: number; end: number } | null {
  const source = { ...metadata, ...input };
  let start: number | null = null;
  let end: number | null = null;

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
  const output = toolState.output || '';
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
  renderPermissionPrompt?: boolean;
  lightweight?: boolean;
  compactFileChanges?: boolean;
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
    const permissions = appState.permissions
      .filter(
        (permission) =>
          (getSessionTreeRootId(permission.sessionID) || permission.sessionID) === sessionRootId
      )
      .toSorted((left, right) => left.time.created - right.time.created);
    const activePermission = permissions[0];
    if (!activePermission) return null;

    for (const permission of permissions) {
      const members = getPermissionGroupMembers(permission);
      for (const [index, member] of members.entries()) {
        if ((getSessionTreeRootId(member.sessionID) || member.sessionID) !== sessionRootId)
          continue;
        if (member.messageID !== currentTool.messageID || member.callID !== currentTool.callID) {
          continue;
        }
        return {
          permission,
          isActive: permission.id === activePermission.id,
          isPrimaryOwner: index === 0,
          queuePosition: 1,
          queueTotal: permissions.length,
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
  const isActivePermission = createMemo(() => permissionMatch()?.isActive ?? false);
  const isPrimaryPermissionOwner = createMemo(() => permissionMatch()?.isPrimaryOwner ?? false);
  const isWaitingForPermission = createMemo(() => !!permissionRequest());

  const filePath = () => {
    return getToolReadPath(tool().tool, state());
  };

  const fileChanges = () => getToolFileChanges(tool().tool, state());
  const isReadTool = () => isToolFileRead(tool().tool);

  const statusClass = () => {
    if (isWaitingForPermission()) return 'tool-status-pending';
    switch (state().status) {
      case 'pending':
        return isApplyPatchTool(tool().tool) ? 'tool-status-running' : 'tool-status-pending';
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
    const input = asRecord(state().input) ?? {};
    const normalizedTitle = normalizedComparableText(title());
    return getVisibleInputEntries(input).filter(([key, value]) => {
      if (key !== 'description') return true;
      return normalizedComparableText(value) !== normalizedTitle;
    });
  });

  const questionSummaryItems = createMemo(() =>
    isQuestionToolName(tool().tool) ? getQuestionSummaryItems(state()) : []
  );
  const questionSkipped = createMemo(
    () => isQuestionToolName(tool().tool) && isQuestionSkippedToolError(state())
  );

  // The full text. Detail views clamp what they render and open the rest in an
  // editor tab, which replaced the old head/tail excerpt - that excerpt could
  // cut a closing tag out of the middle of the output.
  const fullOutput = createMemo(() => {
    const current = state();
    return current.status === 'completed' ? current.output || '' : '';
  });
  const runningOutput = createMemo(() => getRunningToolOutput(state()));

  createEffect(() => {
    setExpanded(getToolCallExpanded(expansionKey()));
  });

  const toggleExpand = () => {
    const next = !expanded();
    setToolCallExpanded(expansionKey(), next);
    setExpanded(next);
  };

  const shouldHideToolCard = () => {
    return Boolean(questionRequest()) && isQuestionToolName(tool().tool);
  };
  const showPermission = () => {
    const permission = permissionRequest();
    if (
      questionRequest() ||
      !permission ||
      props.renderPermissionPrompt === false ||
      !isActivePermission() ||
      !isPrimaryPermissionOwner()
    ) {
      return null;
    }
    return permission;
  };

  const toolContent = () => {
    if (questionSkipped()) {
      return (
        <QuestionToolSummary title="Question skipped" items={questionSummaryItems()} skipped />
      );
    }

    if (questionSummaryItems().length > 0) {
      return <QuestionToolSummary title={title()} items={questionSummaryItems()} />;
    }

    if (fileChanges().length > 0) {
      return (
        <FileChangeCard
          toolState={state()}
          changes={fileChanges()}
          animatePending={isApplyPatchTool(tool().tool)}
          waitingForPermission={isWaitingForPermission()}
          previewStateKey={expansionKey()}
          expanded={expanded()}
          toggleExpand={toggleExpand}
          compact={!!props.compactFileChanges}
        />
      );
    }

    if (isReadTool()) {
      return (
        <ReadToolCard
          toolState={state()}
          filePath={filePath()}
          sessionID={tool().sessionID}
          waitingForPermission={isWaitingForPermission()}
        />
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
        runningOutput={runningOutput()}
        waitingForPermission={isWaitingForPermission()}
        lightweight={props.lightweight}
      />
    );
  };

  return (
    <>
      <Show when={!shouldHideToolCard()}>{toolContent()}</Show>
      <Show when={questionRequest()}>{(question) => <QuestionPrompt request={question()} />}</Show>
      <Show when={showPermission()}>
        {(permission) => (
          <PermissionPrompt
            permission={permission()}
            queuePosition={permissionMatch()?.queuePosition}
            queueTotal={permissionMatch()?.queueTotal}
          />
        )}
      </Show>
    </>
  );
}

function QuestionToolSummary(props: {
  title: string;
  items: QuestionSummaryItem[];
  skipped?: boolean;
}) {
  return (
    <div
      class={`chat-tool-invocation-part question-summary-card${props.skipped ? ' is-skipped' : ''}`}
    >
      <div class="question-summary-header">
        <ToolCallIcon
          kind="question"
          statusClass={props.skipped ? 'tool-status-aborted' : 'tool-status-completed'}
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
                class={`question-summary-answer ${props.skipped ? 'is-skipped' : item.answers.length === 0 ? 'is-unanswered' : ''}`}
              >
                {props.skipped
                  ? 'Skipped'
                  : item.answers.length > 0
                    ? item.answers.join(', ')
                    : 'Unanswered'}
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
  waitingForPermission: boolean;
}) {
  const s = () => props.toolState;
  const isError = () => s().status === 'error';
  const isAborted = () => isAbortedToolError(s());
  const statusClass = () => {
    if (props.waitingForPermission) return 'tool-status-pending';
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
    sessionDirectory() ? normalizePath(sessionDirectory() || '') : null;

  const isCurrentDirectory = () =>
    props.filePath === '.' ||
    props.filePath === './' ||
    (!!props.filePath &&
      normalizedSessionDirectory() !== null &&
      normalizedPath() === normalizedSessionDirectory());

  const isDirectory = () => hasFilePath() && (isCurrentDirectory() || isDirectoryOutput(s()));
  const lineRange = () => extractReadRange(asRecord(s().input) ?? {}, metadata());

  const openFile = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (!props.filePath) return;
    const range = lineRange();
    const directory = isDirectory();
    const payload =
      !directory && range
        ? { path: props.filePath, kind: 'file' as const, line: range.start }
        : { path: props.filePath, kind: directory ? ('directory' as const) : ('file' as const) };
    postMessage({
      type: 'vscode/open',
      payload,
    });
  };

  const displayName = () => {
    if (!props.filePath) return null;
    if (isCurrentDirectory()) return 'current directory';
    if (isDirectory())
      return formatDisplayPath(props.filePath, appState.editorContext.workspacePath);
    return getLeafPathName(formatDisplayPath(props.filePath, appState.editorContext.workspacePath));
  };
  const completedDurationLabel = () => {
    const state = s();
    return state.status === 'completed'
      ? formatVisibleToolDuration(state.time.end - state.time.start)
      : null;
  };

  return (
    <div class="chat-tool-invocation-part file-read-card">
      <div class="file-read-card-header">
        <ToolCallIcon
          kind="read"
          statusClass={statusClass()}
          statusLabel={props.waitingForPermission ? 'Waiting for permission' : undefined}
          waiting={props.waitingForPermission}
        />
        <span
          class={`file-read-action-label${s().status === 'running' && !props.waitingForPermission ? ' shimmer-progress' : ''}`}
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
                <Show when={!isDirectory()}>
                  <FileTypeIcon path={props.filePath ?? undefined} class="file-read-file-icon" />
                </Show>
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
  animatePending: boolean;
  waitingForPermission: boolean;
  previewStateKey: string;
  expanded: boolean;
  toggleExpand: () => void;
  compact: boolean;
}) {
  let moreButtonRef: HTMLButtonElement | undefined;
  let moreMenuRef: HTMLDivElement | undefined;
  const [moreMenuOpen, setMoreMenuOpen] = createSignal(false);
  const [moreMenuPosition, setMoreMenuPosition] = createSignal({
    left: 8,
    top: 8,
    maxHeight: 220,
    positioned: false,
  });
  const moreMenuId = createUniqueId();
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
  const showInlinePreview = () =>
    !props.compact && showInlineFileChanges() && hasInlinePreviewContent();
  const showCompactCard = () => !isCompleted() || !showInlinePreview();
  const splitCompletedChanges = () => isCompleted() && changes().length > 1;
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
    if (!showCompactCard() || hiddenMultiFileCount() === 0) setMoreMenuOpen(false);
  });

  createEffect(() => {
    if (!moreMenuOpen()) return;

    const positionMenu = () => {
      if (!moreButtonRef || !moreMenuRef) return;

      const margin = 8;
      const gap = 6;
      const buttonRect = moreButtonRef.getBoundingClientRect();
      const menuRect = moreMenuRef.getBoundingClientRect();
      const spaceBelow = Math.max(0, window.innerHeight - margin - buttonRect.bottom - gap);
      const spaceAbove = Math.max(0, buttonRect.top - margin - gap);
      const openBelow = menuRect.height <= spaceBelow || spaceBelow >= spaceAbove;
      const maxHeight = Math.min(220, openBelow ? spaceBelow : spaceAbove);
      const top = openBelow
        ? buttonRect.bottom + gap
        : Math.max(margin, buttonRect.top - gap - Math.min(menuRect.height, maxHeight));
      const left = Math.max(
        margin,
        Math.min(window.innerWidth - menuRect.width - margin, buttonRect.right - menuRect.width)
      );

      setMoreMenuPosition({ left, top, maxHeight, positioned: true });
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (moreButtonRef?.contains(target) || moreMenuRef?.contains(target))) return;
      setMoreMenuOpen(false);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (moreButtonRef?.contains(target) || moreMenuRef?.contains(target))) return;
      setMoreMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      Object.assign(event, { varroHandled: true });
      setMoreMenuOpen(false);
      moreButtonRef?.focus();
    };

    queueMicrotask(() => {
      if (!moreMenuOpen()) return;
      positionMenu();
      moreMenuRef?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('focusin', onFocusIn);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    onCleanup(() => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
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
    if (props.waitingForPermission) return 'tool-status-pending';
    if (isPending()) return props.animatePending ? 'tool-status-running' : 'tool-status-pending';
    if (isRunning()) return 'tool-status-running';
    if (isError()) return isAborted() ? 'tool-status-aborted' : 'tool-status-error';
    return 'tool-status-completed';
  };

  const statusLabel = () => {
    if (props.waitingForPermission) return 'Pending';
    if (isPending()) return props.animatePending ? 'Running' : 'Pending';
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
    const state = s();
    if (state.status !== 'completed') return null;
    const meta = state.metadata || {};
    const additions = isNumber(meta.additions)
      ? meta.additions
      : isNumber(meta.linesAdded)
        ? meta.linesAdded
        : undefined;
    const deletions = isNumber(meta.deletions)
      ? meta.deletions
      : isNumber(meta.linesRemoved)
        ? meta.linesRemoved
        : undefined;
    if (additions !== undefined || deletions !== undefined) {
      return { additions: additions || 0, deletions: deletions || 0 };
    }
    return null;
  };
  const errorMessage = () => {
    const state = s();
    if (state.status !== 'error') return null;
    const message = state.error.trim();
    return message || null;
  };
  const canExpandError = () => !props.compact && Boolean(errorMessage());
  const errorBodyId = createUniqueId();
  const isErrorExpanded = () => canExpandError() && props.expanded;
  const statusContent = (showIcon: boolean) => (
    <>
      <Show when={showIcon}>
        <ToolCallIcon
          kind="edit"
          statusClass={statusClass()}
          statusLabel={statusLabel()}
          waiting={props.waitingForPermission}
          class="file-edit-icon"
        />
      </Show>
      <span
        class={`file-edit-action-label is-${effectiveKind()}${!props.waitingForPermission && (isRunning() || (isPending() && props.animatePending)) ? ' shimmer-progress' : ''}`}
      >
        {props.compact ? `${action()}:` : `(${action().toLowerCase()})`}
      </span>
    </>
  );
  const fileContent = () => (
    <>
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
                <FileTypeIcon
                  path={change()!.fromPath || change()!.path}
                  class="file-edit-file-icon"
                />
                {formatFileChangeDisplayName(change()!.fromPath || change()!.path)}
              </a>
              <span class="file-edit-move-arrow">→</span>
              <a
                href="#"
                class="file-path-link file-edit-path-link"
                onClick={openFileChangePath(change()!.toPath || change()!.path)}
              >
                <FileTypeIcon
                  path={change()!.toPath || change()!.path}
                  class="file-edit-file-icon"
                />
                {formatFileChangeDisplayName(change()!.toPath || change()!.path)}
              </a>
            </span>
          }
        >
          <Show
            when={effectiveKind() === 'removed'}
            fallback={
              <a
                href="#"
                class="file-path-link file-edit-path-link"
                onClick={openFileChangePath(change()!.path)}
              >
                <FileTypeIcon path={change()!.path} class="file-edit-file-icon" />
                {formatFileChangeDisplayName(change()!.path)}
              </a>
            }
          >
            <span class="file-edit-path-label is-removed">
              <FileTypeIcon path={change()!.path} class="file-edit-file-icon" />
              <span class="file-edit-removed-path">
                {formatFileChangeDisplayName(change()!.path)}
              </span>
            </span>
          </Show>
        </Show>
      </Show>
    </>
  );

  return (
    <>
      <Show when={showCompactCard() && !splitCompletedChanges()}>
        <div class="chat-tool-invocation-part file-change-card">
          <div
            class={`file-change-card-header${props.compact ? '' : ' is-standalone'}${canExpandError() ? ' is-expandable' : ''}`}
            onClick={canExpandError() ? props.toggleExpand : undefined}
          >
            <Show when={props.compact}>{statusContent(true)}</Show>
            {fileContent()}
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
                        <FileTypeIcon path={item.toPath || item.path} class="file-edit-file-icon" />
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
                      aria-controls={moreMenuId}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setMoreMenuPosition((position) => ({
                          ...position,
                          maxHeight: 220,
                          positioned: false,
                        }));
                        setMoreMenuOpen((open) => !open);
                      }}
                    >
                      +{hiddenMultiFileCount()} more
                    </button>
                    <Show when={moreMenuOpen()}>
                      <Portal mount={document.body}>
                        <div
                          id={moreMenuId}
                          ref={(el) => (moreMenuRef = el)}
                          class="file-edit-more-menu"
                          role="menu"
                          style={{
                            left: `${moreMenuPosition().left}px`,
                            top: `${moreMenuPosition().top}px`,
                            'max-height': `${moreMenuPosition().maxHeight}px`,
                            visibility: moreMenuPosition().positioned ? 'visible' : 'hidden',
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => {
                            if (event.key === ' ') {
                              const activeItem =
                                document.activeElement instanceof HTMLElement &&
                                document.activeElement.getAttribute('role') === 'menuitem'
                                  ? document.activeElement
                                  : null;
                              if (activeItem && moreMenuRef?.contains(activeItem)) {
                                event.preventDefault();
                                event.stopPropagation();
                                activeItem.click();
                              }
                              return;
                            }
                            if (
                              event.key !== 'ArrowDown' &&
                              event.key !== 'ArrowUp' &&
                              event.key !== 'Home' &&
                              event.key !== 'End'
                            ) {
                              return;
                            }
                            const items = Array.from(
                              moreMenuRef?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
                            );
                            if (items.length === 0) return;
                            event.preventDefault();
                            event.stopPropagation();
                            const currentIndex = items.findIndex(
                              (item) => item === document.activeElement
                            );
                            const nextIndex =
                              event.key === 'Home'
                                ? 0
                                : event.key === 'End'
                                  ? items.length - 1
                                  : event.key === 'ArrowDown'
                                    ? (Math.max(currentIndex, -1) + 1) % items.length
                                    : (currentIndex <= 0 ? items.length : currentIndex) - 1;
                            items[nextIndex]?.focus();
                          }}
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
                                  <FileTypeIcon path={path()} class="file-edit-file-icon" />
                                  <span class="file-edit-more-menu-path">{displayName()}</span>
                                </a>
                              );
                            }}
                          </For>
                        </div>
                      </Portal>
                    </Show>
                  </span>
                </Show>
              </span>
            </Show>
            <Show when={!props.compact}>{statusContent(!isCompleted())}</Show>
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
            <Show when={canExpandError()}>
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
                <UiIcon
                  source={navArrowRightIcon}
                  class={`tool-invocation-chevron ${isErrorExpanded() ? 'expanded' : ''}`}
                  aria-hidden="true"
                />
              </button>
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
      <Show when={showCompactCard() && splitCompletedChanges()}>
        <div class="file-change-card-list">
          <For each={changes()}>
            {(item) => (
              <FileChangeCard
                toolState={props.toolState}
                changes={[item]}
                animatePending={props.animatePending}
                waitingForPermission={props.waitingForPermission}
                previewStateKey={props.previewStateKey}
                expanded={props.expanded}
                toggleExpand={props.toggleExpand}
                compact={props.compact}
              />
            )}
          </For>
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
  runningOutput: string;
  waitingForPermission: boolean;
  lightweight?: boolean;
}) {
  const toolName = () => normalizeToolName(props.tool.tool);
  const isAborted = () => isAbortedToolError(props.state);
  const isPermissionRejected = () => isPermissionRejectedToolError(props.state);
  const isQuestionSkipped = () => isQuestionSkippedToolError(props.state);
  const isBash = () => toolName() === 'bash';
  const isTask = () => toolName() === 'task';
  const isSearchTool = () => getToolKind(toolName()) === 'search';
  const taskAgentLabel = () => {
    const type = props.state.input?.subagent_type;
    if (!isString(type) || !type.trim()) return 'Subagent';
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
      isString(type) && type.trim()
        ? appState.allAgents.find((candidate) => candidate.name === type.trim())
        : null;
    const parentEntry = appState.messages.find((entry) => entry.info.id === props.tool.messageID);
    const parent = parentEntry?.info.role === 'assistant' ? parentEntry.info : null;
    const metadata = 'metadata' in props.state ? props.state.metadata : undefined;
    const metadataModel = asRecord(asRecord(metadata)?.model);
    const metadataProviderID = isString(metadataModel?.providerID) ? metadataModel.providerID : '';
    const metadataModelID = isString(metadataModel?.modelID) ? metadataModel.modelID : '';
    const resolvedMetadataModel =
      metadataProviderID && metadataModelID
        ? { providerID: metadataProviderID, modelID: metadataModelID }
        : null;
    const model = latest || resolvedMetadataModel || agent?.model || parent;
    if (!model) return [];
    const metadataInheritsParent =
      !!resolvedMetadataModel &&
      resolvedMetadataModel.providerID === parent?.providerID &&
      resolvedMetadataModel.modelID === parent.modelID;
    const reasoning = latest
      ? latest.variant
      : resolvedMetadataModel
        ? metadataInheritsParent
          ? parent?.variant
          : undefined
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
  const taskPermissionPending = createMemo(() => {
    if (props.state.status !== 'running') return false;
    const sessionId = taskSessionId();
    if (!sessionId) return false;
    const sessionIds = new Set(getSessionTreeIds(sessionId));
    sessionIds.add(sessionId);
    return appState.permissions.some((permission) => sessionIds.has(permission.sessionID));
  });
  const waitingForPermission = () => props.waitingForPermission || taskPermissionPending();
  const openTaskSession = () => {
    const sessionId = taskSessionId();
    if (!sessionId) return;
    rememberDirectSessionReturn(sessionId, appState.activeSessionId || props.tool.sessionID);
    void selectSession(sessionId);
  };
  const bashCommand = () => {
    const command = props.state.input?.command;
    return isString(command)
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
    const state = props.state;
    if (state.status !== 'completed') return null;
    return Math.max(0, state.time.end - state.time.start);
  };
  const completedDurationLabel = () => formatVisibleToolDuration(completedDurationMs());
  const searchResultCount = () => getSearchResultCount(props.tool.tool, props.state);
  const [now, setNow] = createSignal(Date.now());
  onMount(() => {
    if (isTask()) onCleanup(retainTaskActivityAltListener());
  });
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
  const taskActivityAgeDuration = () => {
    if (!taskActivityAltPressed() || !isTask() || props.state.status !== 'running') return null;
    const sessionId = taskSessionId();
    if (!sessionId) return null;
    const updated = appState.sessions.find((session) => session.id === sessionId)?.time.updated;
    if (updated === undefined) return null;
    return formatDuration(Math.max(0, now() - updated)) || '0ms';
  };
  const visibleTaskTokenUsage = () => (taskActivityAgeDuration() ? null : taskTokenUsage());
  const visibleRunningDurationLabel = () =>
    taskActivityAgeDuration() ? null : runningDurationLabel();
  const commandMatchesTitle = () =>
    normalizedComparableText(bashCommand()) === normalizedComparableText(props.title);
  const hasBashResultRow = () =>
    props.state.status === 'completed' ||
    props.state.status === 'error' ||
    (props.state.status === 'running' && !isBlank(props.runningOutput));
  const hasOnlyHeaderCommand = () => isBash() && commandMatchesTitle() && !hasBashResultRow();
  const hasExpandableContent = () => {
    if (props.lightweight) return false;
    if (props.state.status === 'error') return true;
    if (hasOnlyHeaderCommand()) return false;
    if (detailInputEntries().length > 0) return true;
    // Whitespace-only output is not expandable content: offering a chevron that
    // opens onto an empty box is worse than no chevron.
    return props.state.status === 'completed' && !isBlank(props.fullOutput);
  };
  const isExpanded = () => hasExpandableContent() && props.expanded;

  // Never hide the command while it is the card's only content. Completed and
  // failed calls have a result row; running calls only do once output arrives.
  const showBashCommandRow = () => !hasBashResultRow() || !commandMatchesTitle();
  const showHeaderCommandCopy = () =>
    isBash() &&
    !props.lightweight &&
    commandMatchesTitle() &&
    (isExpanded() || !hasBashResultRow());

  const bodyId = createUniqueId();
  return (
    <div class={`chat-tool-invocation-part${isTask() ? ' tool-invocation-task' : ''}`}>
      <div
        class={`tool-invocation-header-shell${showHeaderCommandCopy() ? ' has-command-copy' : ''}${hasOnlyHeaderCommand() ? ' has-command-only-copy' : ''}`}
      >
        <button
          type="button"
          class="tool-invocation-header"
          onClick={props.toggleExpand}
          disabled={!hasExpandableContent()}
          aria-expanded={hasExpandableContent() ? isExpanded() : undefined}
          aria-controls={hasExpandableContent() ? bodyId : undefined}
        >
          <ToolCallIcon
            toolName={props.tool.tool}
            statusClass={props.statusClass}
            statusLabel={waitingForPermission() ? 'Waiting for permission' : undefined}
            waiting={waitingForPermission()}
          />
          <span
            class={`tool-invocation-title${props.statusClass === 'tool-status-running' && !isTask() ? ' shimmer-progress' : ''}`}
          >
            {props.title}
          </span>
          <Show when={visibleTaskTokenUsage()}>
            {(tokens) => (
              <span class="tool-invocation-token-stats" title="Subagent tokens">
                ↑ {formatNumber(tokens().input)} ↓ {formatNumber(tokens().output)}
              </span>
            )}
          </Show>
          <Show when={searchResultCount()}>
            {(result) => {
              const label = () =>
                `${result().count}${result().truncated ? ' or more' : ''} search ${result().count === 1 && !result().truncated ? 'result' : 'results'}`;
              return (
                <span class="tool-invocation-search-count" title={label()} aria-label={label()}>
                  {result().count}
                  {result().truncated ? '+' : ''}
                </span>
              );
            }}
          </Show>
          <Show when={completedDurationLabel()}>
            <span class="tool-invocation-duration">{completedDurationLabel()}</span>
          </Show>
          <Show when={visibleRunningDurationLabel()}>
            <span class="tool-invocation-duration" title="Elapsed time">
              {visibleRunningDurationLabel()}
            </span>
          </Show>
          <Show when={taskActivityAgeDuration()}>
            {(duration) => (
              <span class="tool-invocation-activity-age" title="Last session activity">
                last active <span class="tool-invocation-activity-time">{duration()}</span> ago
              </span>
            )}
          </Show>
          <Show when={taskRetryStatus()}>
            {(retry) => (
              <span class="tool-invocation-retry-label">retrying #{retry().attempt}</span>
            )}
          </Show>
          <Show when={props.state.status === 'error' && !isExpanded()}>
            <span
              class={`tool-invocation-error-label${isAborted() ? ' is-aborted' : ''}${isPermissionRejected() || isQuestionSkipped() ? ' is-rejected' : ''}`}
            >
              {isPermissionRejected()
                ? 'rejected'
                : isQuestionSkipped()
                  ? 'skipped'
                  : isAborted()
                    ? 'aborted'
                    : 'failed'}
            </span>
          </Show>
          <Show when={hasExpandableContent()}>
            <UiIcon
              source={navArrowRightIcon}
              class={`tool-invocation-chevron ${isExpanded() ? 'expanded' : ''}`}
            />
          </Show>
        </button>
        <Show when={showHeaderCommandCopy()}>
          <CopyIconButton text={bashCommand()} label="command" />
        </Show>
      </div>
      <Show when={isExpanded()}>
        <div id={bodyId} class="tool-invocation-detail animate-fade-in">
          <Show
            when={isBash() && bashCommand()}
            fallback={
              <StructuredToolCard
                inputEntries={detailInputEntries()}
                result={structuredResult()}
                onOpenPath={openGenericToolFile}
                toolTitle={props.title}
              />
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
              <Show when={props.state.status === 'running' && !isBlank(props.runningOutput)}>
                <div class="terminal-command-row terminal-command-row-output">
                  <LiveTerminalOutput content={props.runningOutput} />
                </div>
              </Show>
              <Show when={props.state.status === 'error'}>
                <div
                  class={`terminal-command-row terminal-command-row-output terminal-command-row-error${isAborted() ? ' is-aborted' : ''}`}
                >
                  <ClampedToolText
                    content={props.state.status === 'error' ? props.state.error : ''}
                    title={`${props.title} (error)`}
                    language="plaintext"
                    class={`terminal-command-text terminal-command-output tool-invocation-error${isAborted() ? ' is-aborted' : ''}`}
                    role="alert"
                  />
                </div>
              </Show>
            </div>
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
                <UiIcon
                  source={hourglassIcon}
                  class="tool-invocation-working-icon"
                  width="12"
                  height="12"
                  aria-hidden="true"
                />
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
 * The command always occupies exactly one row - it is a label for the output
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

function LiveTerminalOutput(props: { content: string }) {
  let viewportRef: HTMLDivElement | undefined;
  let contentRef: HTMLPreElement | undefined;

  const scrollToBottom = () => {
    if (!viewportRef) return;
    const bottom = Math.max(0, viewportRef.scrollHeight - viewportRef.clientHeight);
    if (Math.abs(viewportRef.scrollTop - bottom) <= 1) return;
    viewportRef.scrollTop = bottom;
  };

  createEffect(() => {
    void props.content;
    queueMicrotask(scrollToBottom);
  });

  onMount(() => {
    if (!contentRef || globalThis.ResizeObserver === undefined) return;
    const observer = new ResizeObserver(scrollToBottom);
    observer.observe(contentRef);
    onCleanup(() => observer.disconnect());
  });

  return (
    <div
      ref={(el) => (viewportRef = el)}
      class="terminal-command-output-viewport"
      role="log"
      aria-label="Live command output"
      aria-live="polite"
    >
      <pre ref={(el) => (contentRef = el)} class="terminal-command-text terminal-command-output">
        {props.content}
      </pre>
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
              {isPathKey(key) && isString(value) ? (
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
            class={`structured-tool-row structured-tool-row-result${result().status ? ` structured-tool-row-${result().status}` : ''}`}
          >
            <span class="structured-tool-label">{result().label}</span>
            <ClampedToolText
              content={result().value}
              title={`${props.toolTitle} (${result().label})`}
              language={result().status ? 'plaintext' : undefined}
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

function shouldShowStructuredToolValueAsBlock<T>(key: string, value: T): boolean {
  if (isPathKey(key)) return false;
  if (isString(value)) {
    if (key === 'pattern' && !value.includes('\n')) return false;
    return value.includes('\n') || value.length > 100;
  }
  return asRecord(value) !== null || Array.isArray(value);
}

function formatExpandedValue<T>(key: string, value: T): string {
  if (isString(value)) {
    return key === 'command'
      ? formatCommandDisplay(value, appState.editorContext.workspacePath)
      : value;
  }
  if (isNumber(value) || isBoolean(value)) return String(value);
  return JSON.stringify(value, null, 2);
}
