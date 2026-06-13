import { For, Show, createMemo, createSignal } from 'solid-js';
import { isActiveSessionWorking, state } from '../lib/state';
import { postMessage } from '../lib/bridge';
import {
  getDiffFileChanges,
  getMessageFileChanges,
  type FileChange,
  type FileChangeKind,
} from '../lib/tool-file-change';
import { getMessageToolSummaryStats, getSessionSummaryStats } from './chat/SessionListView';
import { formatDisplayPath, getLeafPathName } from '../lib/path-display';

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
  // The file rows: prefer the session's authoritative diff summary (the source
  // the session list counts from) so they match; fall back to scanning messages
  // only when no summary is available. Skip the scan entirely while streaming —
  // the block is hidden then, and short-circuiting avoids re-running on every
  // message update.
  const changes = createMemo(() => {
    if (isActiveSessionWorking()) return [];
    const diffs = getActiveSession()?.summary?.diffs;
    if (diffs && diffs.length > 0) return getDiffFileChanges(diffs);
    return getMessageFileChanges(state.messages, state.editorContext.workspacePath);
  });
  // The header counter mirrors the session list exactly: same summary
  // resolution with the same message-derived fallback. Unlike the list, the
  // active session's messages are already loaded, so the fallback resolves
  // synchronously — no "0 0 0" placeholder here.
  const summaryStats = createMemo(() => {
    if (isActiveSessionWorking()) return null;
    const session = getActiveSession();
    if (!session) return null;
    const direct = getSessionSummaryStats(session);
    if (direct && (direct.files > 0 || direct.additions > 0 || direct.deletions > 0)) {
      return direct;
    }
    return getSessionSummaryStats(session, getMessageToolSummaryStats(state.messages));
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
              <span class="diff-lines-added">+{additions()}</span>{' '}
              <span class="diff-lines-removed">-{deletions()}</span>
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
  // A removed file no longer exists on disk, so there is nothing to open.
  const isOpenable = () => props.change.kind !== 'removed';
  const openFile = () => {
    if (!isOpenable()) return;
    postMessage({ type: 'vscode/open', payload: { path: openPath(), kind: 'file' } });
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
      <Show when={isOpenable()} fallback={<span class="changed-files-row">{content}</span>}>
        <button
          type="button"
          class="changed-files-row changed-files-row-button"
          onClick={openFile}
          title={`Open ${displayPath()}`}
        >
          {content}
        </button>
      </Show>
    </li>
  );
}
