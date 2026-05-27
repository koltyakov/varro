import { Show } from 'solid-js';
import { MessageList } from '../MessageList';
import { ChatInput } from '../ChatInput';
import { ModelsPanel } from '../ModelsPanel';
import { ActiveChatHeader, SessionPickerHeader } from './ChatHeader';
import { SessionListView } from './SessionListView';
import type { SessionListFilter } from './SessionListView';
import { RalphDashboard } from '../ralph/RalphDashboard';
import { ralphStore } from '../../lib/stores/ralph-store';
import { state } from '../../lib/state';

function activeRalphSessionId() {
  const id = state.activeSessionId;
  return id && ralphStore.isRalphSession(id) ? id : null;
}

export function ChatWorkspace(props: {
  isEnteringChatView: boolean;
  shouldRenderWorkspace: boolean;
  isDesktopSessionPaneRight: boolean;
  showSessionPicker: boolean;
  showSettings: boolean;
  showReconnectBanner: boolean;
  sessionFilter: SessionListFilter | null;
  subagentParentId: string | null;
  sessionListFilterLabel: string | null;
  sessionListFilterPrefix: string;
  sessionListFilterTitle?: string;
  primarySessionsCount: number;
  shouldShowFailedBadge: boolean;
  shouldShowAttentionBadge: boolean;
  shouldShowPlanReadyBadge: boolean;
  shouldShowCompletedBadge: boolean;
  shouldShowRunningBadge: boolean;
  failedSessionsCount: number;
  attentionSessionsCount: number;
  planReadySessionsCount: number;
  completedSessionsCount: number;
  runningSessionsCount: number;
  sessionSidebarFailedCount: number;
  sessionSidebarAttentionCount: number;
  sessionSidebarPlanReadyCount: number;
  sessionSidebarCompletedCount: number;
  sessionSidebarRunningCount: number;
  isCreatingSessionFromPicker: boolean;
  activeTitle: string;
  activeSubagentRootId: string | null;
  activeSubagentLabel: string;
  onClearSessionListView: () => void;
  onOpenAllSessions: () => void;
  onOpenSubagentSessions: (parentSessionId: string) => void;
  onOpenFailedSessions: () => void;
  onOpenAttentionSessions: () => void;
  onOpenPlanReadySessions: () => void;
  onOpenCompletedSessions: () => void;
  onOpenRunningSessions: () => void;
  onCreateSessionFromPicker: () => void;
  onCreateSession: () => void;
}) {
  const sessionPickerHeader = (useSidebarCounts = false) => (
    <SessionPickerHeader
      filterLabel={props.sessionListFilterLabel}
      filterPrefix={props.sessionListFilterPrefix}
      filterTitle={props.sessionListFilterTitle}
      primarySessionsCount={props.primarySessionsCount}
      showFailedBadge={props.shouldShowFailedBadge}
      showAttentionBadge={props.shouldShowAttentionBadge}
      showPlanReadyBadge={props.shouldShowPlanReadyBadge}
      showCompletedBadge={props.shouldShowCompletedBadge}
      showRunningBadge={props.shouldShowRunningBadge}
      failedCount={useSidebarCounts ? props.sessionSidebarFailedCount : props.failedSessionsCount}
      attentionCount={
        useSidebarCounts ? props.sessionSidebarAttentionCount : props.attentionSessionsCount
      }
      planReadyCount={
        useSidebarCounts ? props.sessionSidebarPlanReadyCount : props.planReadySessionsCount
      }
      completedCount={
        useSidebarCounts ? props.sessionSidebarCompletedCount : props.completedSessionsCount
      }
      runningCount={
        useSidebarCounts ? props.sessionSidebarRunningCount : props.runningSessionsCount
      }
      showNewChatButton
      createSessionDisabled={props.isCreatingSessionFromPicker}
      onClearFilter={props.onClearSessionListView}
      onOpenFailedSessions={props.onOpenFailedSessions}
      onOpenAttentionSessions={props.onOpenAttentionSessions}
      onOpenPlanReadySessions={props.onOpenPlanReadySessions}
      onOpenCompletedSessions={props.onOpenCompletedSessions}
      onOpenRunningSessions={props.onOpenRunningSessions}
      onCreateSession={props.onCreateSessionFromPicker}
    />
  );

  const activeChatHeader = (showBackButton: boolean, showActions = true) => (
    <ActiveChatHeader
      title={props.activeTitle}
      showBackButton={showBackButton}
      showActions={showActions}
      activeSubagentRootId={props.activeSubagentRootId}
      activeSubagentLabel={props.activeSubagentLabel}
      failedCount={props.failedSessionsCount}
      attentionCount={props.attentionSessionsCount}
      planReadyCount={props.planReadySessionsCount}
      completedCount={props.completedSessionsCount}
      runningCount={props.runningSessionsCount}
      onBack={props.onOpenAllSessions}
      onOpenSubagents={props.onOpenSubagentSessions}
      onOpenFailedSessions={props.onOpenFailedSessions}
      onOpenAttentionSessions={props.onOpenAttentionSessions}
      onOpenPlanReadySessions={props.onOpenPlanReadySessions}
      onOpenCompletedSessions={props.onOpenCompletedSessions}
      onOpenRunningSessions={props.onOpenRunningSessions}
      onCreateSession={props.onCreateSession}
    />
  );

  const sessionSidebar = () => (
    <aside class="chat-session-sidebar" aria-label="Sessions">
      <div class="chat-header chat-session-sidebar-header">
        <div class="chat-header-inner chat-session-sidebar-header-inner">
          {sessionPickerHeader(true)}
        </div>
      </div>
      <SessionListView
        embedded
        class="session-list-view-sidebar"
        sessionFilter={props.showSessionPicker ? props.sessionFilter : null}
        subagentParentId={props.showSessionPicker ? props.subagentParentId : null}
        onOpenSubagents={props.showSessionPicker ? props.onOpenSubagentSessions : undefined}
      />
    </aside>
  );

  const mainShell = () => (
    <div class="chat-main-shell">
      <div class="chat-header chat-header-chat-desktop">
        <div class="chat-header-inner">{activeChatHeader(false)}</div>
      </div>
      <div class="chat-main-column-shell">
        <Show
          when={activeRalphSessionId()}
          fallback={
            <>
              <MessageList />
              <ChatInput />
            </>
          }
        >
          {(sessionId) => <RalphDashboard sessionId={sessionId()} />}
        </Show>
      </div>
    </div>
  );

  return (
    <div
      class={`interactive-session ${props.isEnteringChatView ? 'chat-view-entering' : ''}`.trim()}
    >
      <div
        class={`chat-header ${props.shouldRenderWorkspace ? 'chat-header-centered chat-header-chat-layout' : ''}`}
      >
        <div class="chat-header-inner">
          <Show when={props.showSessionPicker} fallback={activeChatHeader(true)}>
            {sessionPickerHeader()}
          </Show>
        </div>
      </div>

      <Show when={props.showReconnectBanner}>
        <div
          class={`chat-transport-banner ${props.shouldRenderWorkspace ? 'chat-main-column' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div class="chat-transport-copy">
            <span class="chat-transport-title">Live updates are reconnecting</span>
            <span class="chat-transport-message">
              Chat actions still work, but session status may lag until the event stream recovers.
            </span>
          </div>
        </div>
      </Show>

      <Show
        when={props.shouldRenderWorkspace}
        fallback={
          <SessionListView
            sessionFilter={props.sessionFilter}
            subagentParentId={props.subagentParentId}
            onOpenSubagents={props.onOpenSubagentSessions}
          />
        }
      >
        <Show when={props.showSettings}>
          <ModelsPanel />
        </Show>

        <div
          class={`chat-workspace ${props.isDesktopSessionPaneRight ? 'chat-workspace-pane-right' : ''}`}
        >
          <Show
            when={props.isDesktopSessionPaneRight}
            fallback={
              <>
                {sessionSidebar()}
                {mainShell()}
              </>
            }
          >
            <>
              {mainShell()}
              {sessionSidebar()}
            </>
          </Show>
        </div>
      </Show>
    </div>
  );
}
