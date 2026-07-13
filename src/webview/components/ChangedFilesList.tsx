import { For, Show, createMemo, createSignal } from 'solid-js';
import { isActiveSessionWorking, state } from '../lib/state';
import { postMessage } from '../lib/bridge';
import {
  getDiffFileChanges,
  getMessageFileChanges,
  type FileChange,
  type FileChangeKind,
} from '../lib/tool-file-change';
import { getDiffSummaryStats, getMessageToolSummaryStats } from './chat/SessionListView';
import { formatDisplayPath, getLeafPathName } from '../lib/path-display';
import { formatEditCount } from '../lib/format';

const KIND_BADGE: Record<FileChangeKind, { label: string; title: string; class: string }> = {
  added: { label: 'A', title: 'Added', class: 'is-added' },
  edited: { label: 'M', title: 'Modified', class: 'is-edited' },
  removed: { label: 'D', title: 'Removed', class: 'is-removed' },
  moved: { label: 'R', title: 'Renamed', class: 'is-moved' },
};

function getActiveSession() {
  return state.sessions.find((session) => session.id === state.activeSessionId);
}

export function ChangedFilesList() {
  let cachedSessionId: string | null = null;
  let cachedChanges: FileChange[] = [];
  let cachedSummaryStats: ReturnType<typeof getMessageToolSummaryStats> = null;
  const activeMessages = createMemo(() => {
    const sessionId = state.activeSessionId;
    return sessionId ? state.messages.filter((entry) => entry.info.sessionID === sessionId) : [];
  });

  const resetCacheForSession = (sessionId: string | null) => {
    if (cachedSessionId === sessionId) return;
    cachedSessionId = sessionId;
    cachedChanges = [];
    cachedSummaryStats = null;
  };

  // The file rows reflect what THIS session's agent changed — the file-changing
  // tool calls and patch parts in its own messages. The backend session summary
  // (`session.summary.diffs`) can describe workspace-wide git changes — files
  // edited by hand or by a sibling session — that a read-only session never
  // touched, so it is only used to bridge the brief gap before a running
  // session's edits stream in, never for an idle session.
  const changes = createMemo(() => {
    const session = getActiveSession();
    resetCacheForSession(state.activeSessionId);

    const summaryDiffs = session?.summary?.diffs;
    const messageChanges = getMessageFileChanges(
      activeMessages(),
      state.editorContext.workspacePath
    );

    if (summaryDiffs && summaryDiffs.length > 0 && messageChanges.length === 0) {
      if (isActiveSessionWorking()) {
        cachedChanges = getDiffFileChanges(summaryDiffs);
        return cachedChanges;
      }
      cachedChanges = [];
      return cachedChanges;
    }

    if (isActiveSessionWorking() && cachedChanges.length > 0 && messageChanges.length === 0) {
      return cachedChanges;
    }

    cachedChanges = messageChanges;
    return cachedChanges;
  });
  // The header counter tracks the same session-scoped source as the rows.
  // Backend summary counts only stand in while a session is running and its
  // edits have not streamed in yet; otherwise counts come from the session's
  // own messages so unrelated git changes can't inflate them.
  const summaryStats = createMemo(() => {
    const session = getActiveSession();
    resetCacheForSession(state.activeSessionId);
    if (!session) return null;

    const messageStats = getMessageToolSummaryStats(activeMessages());
    const summaryDiffs = session.summary?.diffs;
    const working = isActiveSessionWorking();

    if (summaryDiffs && summaryDiffs.length > 0 && messageStats === null && working) {
      const fromDiffs = getDiffSummaryStats(summaryDiffs);
      if (
        fromDiffs &&
        (fromDiffs.files > 0 || fromDiffs.additions > 0 || fromDiffs.deletions > 0)
      ) {
        cachedSummaryStats = fromDiffs;
        return fromDiffs;
      }
    }

    if (working && messageStats === null && cachedSummaryStats) return cachedSummaryStats;

    cachedSummaryStats = messageStats;
    return messageStats;
  });
  const total = () => summaryStats()?.files ?? changes().length;
  const additions = () =>
    summaryStats()?.additions ??
    changes().reduce((sum, change) => sum + (change.additions ?? 0), 0);
  const deletions = () =>
    summaryStats()?.deletions ??
    changes().reduce((sum, change) => sum + (change.deletions ?? 0), 0);
  const hasLineCounts = () => additions() > 0 || deletions() > 0;
  // The board always starts collapsed; the user opens it on demand.
  const [collapsed, setCollapsed] = createSignal(true);

  return (
    <Show when={total() > 0}>
      <div class="todo-block changed-files-block animate-fade-in">
        <button
          type="button"
          class="todo-block-header"
          onClick={() => setCollapsed(!collapsed())}
          aria-expanded={!collapsed()}
        >
          <svg
            class={`todo-block-chevron ${collapsed() ? 'collapsed' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
          <span class="todo-block-title">Files</span>
          <span class="todo-block-count">{total()}</span>
          <Show when={hasLineCounts()}>
            <span class="changed-files-lines">
              <span class="diff-lines-added">+{formatEditCount(additions())}</span>{' '}
              <span class="diff-lines-removed">-{formatEditCount(deletions())}</span>
            </span>
          </Show>
        </button>
        <Show when={!collapsed()}>
          <ul class="todo-block-list changed-files-list">
            <For each={changes()}>{(change) => <ChangedFileItem change={change} />}</For>
          </ul>
        </Show>
      </div>
    </Show>
  );
}

function ChangedFileItem(props: { change: FileChange }) {
  const badge = () => KIND_BADGE[props.change.kind];
  const openPath = () => props.change.toPath || props.change.path;
  const displayPath = () => formatDisplayPath(openPath(), state.editorContext.workspacePath);
  const leaf = () => getLeafPathName(openPath());
  const dir = () => {
    const path = displayPath();
    const name = leaf();
    return path.endsWith(name) ? path.slice(0, path.length - name.length) : '';
  };
  const openFile = () => {
    postMessage({
      type: 'vscode/open',
      payload: { path: openPath(), kind: 'file', view: 'diff' },
    });
  };

  const content = (
    <>
      <span
        class={`changed-files-badge ${badge().class}`}
        role="img"
        aria-label={badge().title}
        title={badge().title}
      >
        {badge().label}
      </span>
      <span class="changed-files-path">
        <span class="changed-files-dir">{dir()}</span>
        <span class="changed-files-name">{leaf()}</span>
      </span>
      <Show when={(props.change.additions ?? 0) > 0 || (props.change.deletions ?? 0) > 0}>
        <span class="changed-files-item-lines">
          <Show when={(props.change.additions ?? 0) > 0}>
            <span class="diff-lines-added">+{props.change.additions}</span>
          </Show>
          <Show when={(props.change.deletions ?? 0) > 0}>
            {' '}
            <span class="diff-lines-removed">-{props.change.deletions}</span>
          </Show>
        </span>
      </Show>
    </>
  );

  return (
    <li class={`todo-block-item changed-files-item kind-${props.change.kind}`}>
      <button
        type="button"
        class="changed-files-row changed-files-row-button"
        onClick={openFile}
        title={`Open diff for ${displayPath()}`}
      >
        {content}
      </button>
    </li>
  );
}
