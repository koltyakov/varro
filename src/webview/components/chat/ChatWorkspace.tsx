import { Show, Suspense, createSignal, lazy } from 'solid-js';
import { Portal } from 'solid-js/web';
import { MessageList } from '../MessageList';
import { ChatInput } from '../ChatInput';
import { ActiveChatHeader, SessionPickerHeader } from './ChatHeader';
import { SessionListView } from './SessionListView';
import type { SessionListFilter } from './SessionListView';
import type { SlowApiRequest } from '../../lib/bridge';
import { inlineEditMount } from '../../lib/message-edit-state';
import { ralphStore } from '../../lib/stores/ralph-store';
import { state } from '../../lib/state';
import { ManagedSubagentFooter } from './ManagedSubagentFooter';

const LazyModelsPanel = lazy(() =>
  import('../ModelsPanel').then((module) => ({ default: module.ModelsPanel }))
);
const LazyRalphDashboard = lazy(() =>
  import('../ralph/RalphDashboard').then((module) => ({ default: module.RalphDashboard }))
);

function activeRalphSessionId() {
  const id = state.activeSessionId;
  return id && ralphStore.isRalphSession(id) ? id : null;
}

// Hosts the single live ChatInput. While a message is being edited the
// composer DOM relocates into the edited message row (the Portal moves the
// existing nodes - component state is preserved); otherwise it sits in the
// bottom slot.
function ComposerHost() {
  const [bottomMount, setBottomMount] = createSignal<HTMLElement | null>(null);
  const mountTarget = () => inlineEditMount() ?? bottomMount();

  return (
    <>
      <div class="composer-bottom-slot" ref={setBottomMount} />
      <Show when={!!mountTarget()}>
        <Portal
          mount={mountTarget()!}
          ref={(el) => {
            el.style.display = 'contents';
          }}
        >
          <ChatInput />
        </Portal>
      </Show>
    </>
  );
}

export function ChatWorkspace(props: {
  shouldRenderWorkspace: boolean;
  isDesktopSessionPaneRight: boolean;
  showSessionPicker: boolean;
  showSettings: boolean;
  showReconnectBanner: boolean;
  slowApiRequests: readonly SlowApiRequest[];
  sessionFilter: SessionListFilter | null;
  subagentParentId: string | null;
  sidebarSubagentParentId: string | null;
  sessionListFilterLabel: string | null;
  sessionListFilterPrefix: string;
  sessionListFilterTitle?: string;
  sidebarSessionListFilterLabel: string | null;
  sidebarSessionListFilterTitle?: string;
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
  activeTitle: string;
  activeBackTitle: string;
  showDesktopBackButton: boolean;
  activeSubagentRootId: string | null;
  activeSubagentCount: number;
  activeSubagentLabel: string;
  managedSubagentParentId: string | null;
  managedSubagentParentTitle: string | null;
  onClearSessionListView: () => void;
  onOpenAllSessions: () => void;
  onReturnToManagedSubagentParent: () => void;
  onOpenParentSession: () => void;
  onOpenSubagentSessions: (parentSessionId: string) => void;
  onOpenSidebarSubagentSessions: (parentSessionId: string) => void;
  onOpenTopLevelSidebarSessions: () => void;
  onOpenFailedSessions: () => void;
  onOpenAttentionSessions: () => void;
  onOpenPlanReadySessions: () => void;
  onOpenCompletedSessions: () => void;
  onOpenRunningSessions: () => void;
  onCreateSessionFromPicker: () => void;
  onCreateSession: () => void;
}) {
  let chatContentRef: HTMLDivElement | undefined;
  const showActiveSessionCue = () => {
    if (!chatContentRef) return;
    chatContentRef.classList.remove('active-session-reselected');
    void chatContentRef.offsetWidth;
    chatContentRef.classList.add('active-session-reselected');
  };
  const sidebarSubagentParentId = () =>
    props.showSessionPicker ? props.subagentParentId : props.sidebarSubagentParentId;
  const sidebarFilterLabel = () =>
    props.showSessionPicker ? props.sessionListFilterLabel : props.sidebarSessionListFilterLabel;
  const sidebarFilterPrefix = () =>
    props.showSessionPicker ? props.sessionListFilterPrefix : 'Viewing:';
  const sidebarFilterTitle = () =>
    props.showSessionPicker ? props.sessionListFilterTitle : props.sidebarSessionListFilterTitle;
  const sessionPickerHeader = (useSidebarCounts = false) => (
    <SessionPickerHeader
      filterLabel={useSidebarCounts ? sidebarFilterLabel() : props.sessionListFilterLabel}
      filterPrefix={useSidebarCounts ? sidebarFilterPrefix() : props.sessionListFilterPrefix}
      filterTitle={useSidebarCounts ? sidebarFilterTitle() : props.sessionListFilterTitle}
      primarySessionsCount={props.primarySessionsCount}
      showBackButton={!!(useSidebarCounts ? sidebarSubagentParentId() : props.subagentParentId)}
      backTitle={useSidebarCounts ? 'Back to sessions' : undefined}
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
      onBack={useSidebarCounts ? props.onOpenTopLevelSidebarSessions : props.onOpenParentSession}
      onClearFilter={
        useSidebarCounts ? props.onOpenTopLevelSidebarSessions : props.onClearSessionListView
      }
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
      backTitle={props.activeBackTitle}
      showActions={showActions}
      activeSubagentRootId={props.activeSubagentRootId}
      activeSubagentCount={props.activeSubagentCount}
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
        subagentParentId={sidebarSubagentParentId()}
        onOpenSubagents={props.onOpenSidebarSubagentSessions}
        onActiveSessionReselect={showActiveSessionCue}
      />
    </aside>
  );

  const mainShell = () => (
    <div class="chat-main-shell">
      <div class="chat-header chat-header-chat-desktop">
        <div class="chat-header-inner">{activeChatHeader(props.showDesktopBackButton)}</div>
      </div>
      <div
        ref={(element) => {
          chatContentRef = element;
        }}
        class="chat-main-column-shell"
      >
        <Show
          when={activeRalphSessionId()}
          fallback={
            <>
              <MessageList />
              <Show when={props.managedSubagentParentId} fallback={<ComposerHost />}>
                <ManagedSubagentFooter
                  parentTitle={props.managedSubagentParentTitle}
                  onReturnToParent={props.onReturnToManagedSubagentParent}
                />
              </Show>
            </>
          }
        >
          {(sessionId) => (
            <Suspense>
              <LazyRalphDashboard sessionId={sessionId()} />
            </Suspense>
          )}
        </Show>
      </div>
    </div>
  );

  return (
    <div class="interactive-session">
      <div
        class={`chat-header ${props.shouldRenderWorkspace ? 'chat-header-centered chat-header-chat-layout' : ''}`}
      >
        <div class="chat-header-inner">
          <Show
            when={props.showSessionPicker}
            fallback={activeChatHeader(!props.showDesktopBackButton)}
          >
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

      <Show when={props.slowApiRequests.length > 0}>
        <div
          class={`chat-transport-banner chat-api-warning-banner ${props.shouldRenderWorkspace ? 'chat-main-column' : ''}`}
          role="status"
          aria-live="polite"
        >
          <div class="chat-transport-copy">
            <span class="chat-transport-title">Some requests are taking longer than expected</span>
            <span class="chat-transport-message">
              {props.slowApiRequests
                .slice(0, 3)
                .map((request) => `${request.method} ${request.path}`)
                .join(' · ')}
              {props.slowApiRequests.length > 3
                ? ` · ${props.slowApiRequests.length - 3} more`
                : ''}
            </span>
          </div>
        </div>
      </Show>

      <Show when={props.showSettings}>
        <Suspense fallback={<div class="settings-panel" />}>
          <LazyModelsPanel />
        </Suspense>
      </Show>

      <Show
        when={props.shouldRenderWorkspace}
        fallback={
          <>
            <SessionListView
              sessionFilter={props.sessionFilter}
              subagentParentId={props.subagentParentId}
              onOpenSubagents={props.onOpenSubagentSessions}
            />
            <div class="session-list-new-session">
              <ChatInput newSession onBeforeSend={props.onCreateSessionFromPicker} />
            </div>
          </>
        }
      >
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
