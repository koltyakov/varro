import { Show } from 'solid-js';
import {
  AttentionSessionsBadge,
  CompletedSessionsBadge,
  FailedSessionsBadge,
  PlanReadyBadge,
  RunningSessionsBadge,
} from './HeaderBadges';
import type { SessionListFilter } from './SessionListView';

export function SessionPickerHeader(props: {
  filterLabel: string | null;
  filterPrefix: string;
  filterTitle?: string;
  primarySessionsCount: number;
  showBackButton?: boolean;
  showFailedBadge: boolean;
  showAttentionBadge: boolean;
  showPlanReadyBadge: boolean;
  showCompletedBadge: boolean;
  showRunningBadge: boolean;
  failedCount: number;
  attentionCount: number;
  planReadyCount: number;
  completedCount: number;
  runningCount: number;
  showNewChatButton?: boolean;
  onBack?: () => void;
  onClearFilter: () => void;
  onOpenFailedSessions: () => void;
  onOpenAttentionSessions: () => void;
  onOpenPlanReadySessions: () => void;
  onOpenCompletedSessions: () => void;
  onOpenRunningSessions: () => void;
  onCreateSession: () => void;
}) {
  return (
    <>
      <div class="chat-header-left">
        <Show when={props.showBackButton}>
          <button
            class="chat-header-btn"
            onClick={() => props.onBack?.()}
            title="Back to parent session"
          >
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
            </svg>
          </button>
        </Show>
        <Show
          when={props.filterLabel}
          fallback={
            <span class="chat-header-title-text">
              Sessions <span class="chat-header-title-count">({props.primarySessionsCount})</span>
            </span>
          }
        >
          {(label) => (
            <>
              <span class="chat-header-filter-prefix">{props.filterPrefix}</span>
              <span class="chat-header-filter-chip" title={props.filterTitle}>
                <span class="chat-header-filter-chip-label">{label()}</span>
                <button
                  type="button"
                  class="chat-header-filter-chip-remove"
                  onClick={props.onClearFilter}
                  title="Clear filter"
                  aria-label={`Clear ${label()} filter`}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                  </svg>
                </button>
              </span>
            </>
          )}
        </Show>
      </div>
      <div class="chat-header-actions">
        <Show when={props.showFailedBadge}>
          <FailedSessionsBadge count={props.failedCount} onClick={props.onOpenFailedSessions} />
        </Show>
        <Show when={props.showAttentionBadge}>
          <AttentionSessionsBadge
            count={props.attentionCount}
            onClick={props.onOpenAttentionSessions}
          />
        </Show>
        <Show when={props.showPlanReadyBadge}>
          <PlanReadyBadge count={props.planReadyCount} onClick={props.onOpenPlanReadySessions} />
        </Show>
        <Show when={props.showCompletedBadge}>
          <CompletedSessionsBadge
            count={props.completedCount}
            onClick={props.onOpenCompletedSessions}
          />
        </Show>
        <Show when={props.showRunningBadge}>
          <RunningSessionsBadge count={props.runningCount} onClick={props.onOpenRunningSessions} />
        </Show>
        <Show when={props.showNewChatButton}>
          <button class="chat-header-btn" onClick={props.onCreateSession} title="New chat">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </Show>
      </div>
    </>
  );
}

export function ActiveChatHeader(props: {
  title: string;
  showBackButton: boolean;
  isSubagentSession: boolean;
  showActions?: boolean;
  activeSubagentRootId: string | null;
  activeSubagentCount: number;
  activeSubagentLabel: string;
  failedCount: number;
  attentionCount: number;
  planReadyCount: number;
  completedCount: number;
  runningCount: number;
  onBack: () => void;
  onOpenSubagents: (rootSessionId: string) => void;
  onOpenFailedSessions: () => void;
  onOpenAttentionSessions: () => void;
  onOpenPlanReadySessions: () => void;
  onOpenCompletedSessions: () => void;
  onOpenRunningSessions: () => void;
  onCreateSession: () => void;
}) {
  return (
    <>
      <div class="chat-header-left">
        <Show when={props.showBackButton}>
          <button
            class="chat-header-btn"
            onClick={props.onBack}
            title={props.isSubagentSession ? 'Go to top session' : 'Back to sessions'}
          >
            <Show
              when={props.isSubagentSession}
              fallback={
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <path d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z" />
                </svg>
              }
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path
                  d="M5.928 7.976l4.357-4.357-.618-.62L4.69 7.976l4.977 4.977.618-.618z"
                  transform="rotate(90 8 8)"
                />
              </svg>
            </Show>
          </button>
        </Show>
        <span class="chat-header-title-text">{props.title}</span>
        <Show when={props.activeSubagentRootId}>
          {(rootSessionId) => (
            <button
              type="button"
              class="session-item-subagents session-item-subagents-counter chat-header-subagents"
              onClick={() => props.onOpenSubagents(rootSessionId())}
              title={props.activeSubagentLabel}
              aria-label={props.activeSubagentLabel}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M5.5 2.5a2 2 0 110 4 2 2 0 010-4zm5 1a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM2 9.25c0-1.8 2.1-2.75 3.5-2.75S9 7.45 9 9.25V10H2v-.75zm7.5.75v-.5c0-.66-.2-1.23-.54-1.7.5-.19 1.04-.3 1.54-.3 1.22 0 3 .73 3 2.25V10h-4z" />
              </svg>
              <span class="session-item-subagents-count">{props.activeSubagentCount}</span>
            </button>
          )}
        </Show>
      </div>
      <Show when={props.showActions}>
        <div class="chat-header-actions">
          <FailedSessionsBadge count={props.failedCount} onClick={props.onOpenFailedSessions} />
          <AttentionSessionsBadge
            count={props.attentionCount}
            onClick={props.onOpenAttentionSessions}
          />
          <PlanReadyBadge count={props.planReadyCount} onClick={props.onOpenPlanReadySessions} />
          <CompletedSessionsBadge
            count={props.completedCount}
            onClick={props.onOpenCompletedSessions}
          />
          <RunningSessionsBadge count={props.runningCount} onClick={props.onOpenRunningSessions} />
          <button class="chat-header-btn" onClick={props.onCreateSession} title="New chat">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>
        </div>
      </Show>
    </>
  );
}

export type { SessionListFilter };
