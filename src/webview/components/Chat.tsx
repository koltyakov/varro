import {
  connectionInitialized,
  desktopSessionPaneSide,
  state,
  showSessionPicker,
  setPersistentShowSessionPicker as setShowSessionPicker,
  showModels,
  openAttentionSessionsKey,
  openCompletedSessionsKey,
  sessionSearchFocusKey,
  isLoading,
  isSessionAwaitingInput,
  isSessionUnread,
  isActiveSessionWorking,
  getSessionTreeRootId,
  getSelectedAgentForSession,
  persistLastOpenedView,
  setShowModels,
  showPermissionSettings,
  setShowPermissionSettings,
} from '../lib/state';
import { Show, createSignal, onMount, onCleanup, createEffect, createMemo, on } from 'solid-js';
import { selectSession, deleteSessionImmediately } from '../hooks/useOpenCode';
import { normalizeSessionTitle } from '../../shared/session-title';
import { ChatWorkspace } from './chat/ChatWorkspace';
import { ralphStore } from '../lib/stores/ralph-store';
import { getDiscardableActiveBlankSessionId, startNewChatDraft } from '../lib/new-chat-draft';
import {
  shouldHideEmptySessionFromList,
  isEmptySession as isEmptySessionMetadata,
  shouldPruneEmptySession,
} from '../lib/empty-session';
import {
  createStableSessionIndicators,
  deriveSessionIndicators,
  getRecentSessions,
  getRecycleBinSessionIds,
  getPrimarySessionsForFilter,
  getSessionListFilterLabel,
  groupSessions,
  isPrimarySession,
  isRunningSession,
  isSessionFailureUnread,
  shouldShowSessionHeaderBadge,
} from './chat/SessionListView';
import type { SessionListFilter } from './chat/SessionListView';
import {
  onMessage,
  onSlowApiRequestsChange,
  postMessage,
  type SlowApiRequest,
} from '../lib/bridge';
import { compareSessionsForDisplay } from '../lib/session-order';
import {
  consumeProviderConnectionRequest,
  providerConnectionRequest,
} from '../lib/provider-connection-state';
import { client } from '../lib/client';
import type { Provider } from '../types';
import {
  clearDirectSessionReturn,
  clearDirectSessionReturnUnless,
  getDirectSessionReturnId,
} from '../lib/session-navigation';
import { isFunction } from '../lib/runtime-values';
import { ProviderConnectionDialog } from './ProviderConnectionDialog';
import { readWebviewInstanceContext } from '../lib/state-stored-values';

type HeaderSessionCounts = {
  running: number;
  attention: number;
  failed: number;
  planReady: number;
  completed: number;
  sidebarRunning: number;
  sidebarAttention: number;
  sidebarFailed: number;
  sidebarPlanReady: number;
  sidebarCompleted: number;
};

type PublishedUnreadState = {
  kind: 'completed' | 'plan-ready';
  unread: boolean;
  markerAt: number;
};

const DESKTOP_SESSION_LAYOUT_MEDIA_QUERY = '(min-width: 1400px)';
const RECONNECT_BANNER_SHOW_DELAY_MS = 10_000;
const RECONNECT_BANNER_MIN_VISIBLE_MS = 2000;
const EMPTY_SESSION_DELETE_DELAY_MS = 0;
const SESSION_LIST_CLOCK_INTERVAL_MS = 60_000;

function isDesktopSessionPaneRight() {
  return desktopSessionPaneSide() === 'right';
}

function isDirectlyRunningSession(sessionId: string) {
  return isRunningSession(sessionId) || (sessionId === state.activeSessionId && isLoading());
}

export function Chat() {
  const webviewContext = readWebviewInstanceContext();
  const isEditorSurface = webviewContext?.surface === 'editor';
  const [providerConnectionData, setProviderConnectionData] = createSignal<{
    providers: Provider[];
    error: string;
    loading: boolean;
    providerID: string | null;
  } | null>(null);

  createEffect(() => {
    const request = providerConnectionRequest();
    if (!request || providerConnectionData()) return;
    consumeProviderConnectionRequest(request.id);
    const loadingState = {
      providers: [],
      error: '',
      loading: true,
      providerID: request.providerID,
    };
    setProviderConnectionData(loadingState);
    void client.config.providerCatalog().then(
      (catalog) => {
        if (providerConnectionData() !== loadingState) return;
        setProviderConnectionData({
          providers: catalog.all,
          error: '',
          loading: false,
          providerID: request.providerID,
        });
      },
      (error) => {
        if (providerConnectionData() !== loadingState) return;
        setProviderConnectionData({
          providers: [],
          error: error instanceof Error ? error.message : String(error),
          loading: false,
          providerID: request.providerID,
        });
      }
    );
  });
  const [sessionFilter, setSessionFilter] = createSignal<SessionListFilter | null>(null);
  const [subagentParentId, setSubagentParentId] = createSignal<string | null>(null);
  const [sidebarSubagentParentId, setSidebarSubagentParentId] = createSignal<string | null>(null);
  const [isDesktopSessionLayout, setIsDesktopSessionLayout] = createSignal(false);
  const [showReconnectBanner, setShowReconnectBanner] = createSignal(false);
  const [slowApiRequests, setSlowApiRequests] = createSignal<readonly SlowApiRequest[]>([]);
  const [sessionListNow, setSessionListNow] = createSignal(Date.now());
  const rawSessionIndicators = createMemo(() => deriveSessionIndicators(state.sessions));
  const sessionIndicators = createStableSessionIndicators(rawSessionIndicators);
  let publishedUnreadWorkspace: string | null = null;
  const publishedUnreadStates = new Map<string, PublishedUnreadState>();
  let publishedCommandState = '';
  createEffect(() => {
    const workspacePath = state.editorContext.workspacePath;
    // Publish from the settled indicators, and never while a session's turn is
    // still running (including the settle window between steps). Raw indicators
    // drop in and out of plan-ready/completed in the idle gaps of a stepping
    // turn, and mirroring those flaps to the host makes its attention state -
    // and the status bar item - flicker for the whole turn.
    const indicators = sessionIndicators();
    if (!workspacePath) return;
    if (publishedUnreadWorkspace !== workspacePath) {
      publishedUnreadWorkspace = workspacePath;
      publishedUnreadStates.clear();
    }
    for (const session of state.sessions) {
      if (!isPrimarySession(session)) continue;
      if (indicators.runningIds.has(session.id)) continue;
      const previous = publishedUnreadStates.get(session.id);
      const completedAt = state.completedSessionResponses[session.id];
      const seenAt = state.lastSeenSessions[session.id];
      const kind = indicators.planReadyIds.has(session.id)
        ? 'plan-ready'
        : indicators.newlyCompletedIds.has(session.id)
          ? 'completed'
          : undefined;
      let next: PublishedUnreadState | undefined;
      if (kind) {
        if (kind === 'completed') {
          if (completedAt === undefined) continue;
          next = { kind, unread: true, markerAt: completedAt };
        } else {
          const unread = isSessionUnread(session.id, session.time.updated);
          next = {
            kind,
            unread,
            markerAt: unread ? session.time.updated : (seenAt ?? session.time.updated),
          };
        }
      } else if (
        seenAt !== undefined &&
        (completedAt === undefined || seenAt >= completedAt) &&
        getSelectedAgentForSession(session.id) !== 'plan'
      ) {
        next = {
          kind: 'completed',
          unread: false,
          markerAt: seenAt,
        };
      } else if (completedAt !== undefined && seenAt !== undefined && seenAt >= completedAt) {
        next = { kind: 'plan-ready', unread: false, markerAt: seenAt };
      } else if (previous?.kind === 'plan-ready') {
        next = { kind: 'plan-ready', unread: false, markerAt: session.time.updated };
      }
      if (!next) continue;
      if (
        previous?.kind === next.kind &&
        previous.unread === next.unread &&
        previous.markerAt === next.markerAt
      ) {
        continue;
      }
      publishedUnreadStates.set(session.id, next);
      postMessage({
        type: 'session-unread-state/update',
        payload: {
          sessionId: session.id,
          directory: session.directory,
          ...next,
        },
      });
    }
  });
  const recycleBinSessionIds = createMemo(() => getRecycleBinSessionIds(state.recycleBinEntries));
  const visibleSessions = createMemo(() => {
    const indicators = sessionIndicators();
    return state.sessions.filter(
      (session) =>
        !recycleBinSessionIds().has(session.id) && !shouldHideSessionFromList(session, indicators)
    );
  });
  const primarySessions = createMemo(() => visibleSessions().filter(isPrimarySession));
  const recentSessions = createMemo(() => {
    const indicators = sessionIndicators();
    return getRecentSessions(
      groupSessions(
        visibleSessions(),
        (sessionId) => indicators.runningIds.has(sessionId),
        (sessionId) => indicators.attentionIds.has(sessionId),
        (sessionId) => indicators.failedIds.has(sessionId),
        (session) => indicators.planReadyIds.has(session.id),
        (session) => indicators.newlyCompletedIds.has(session.id),
        sessionListNow(),
        (sessionId) => state.pinnedSessionIds.includes(sessionId),
        state.pinnedSessionIds
      )
    );
  });
  const sessionsById = createMemo(
    () => new Map(state.sessions.map((session) => [session.id, session]))
  );
  const isEventStreamDegraded = createMemo(
    () => state.serverStatus.state === 'running' && state.serverStatus.eventStream === 'degraded'
  );
  const shouldRenderWorkspace = () =>
    isEditorSurface || !showSessionPicker() || isDesktopSessionLayout();
  let reconnectBannerShowTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectBannerHideTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectBannerVisibleSince = 0;
  const pendingEmptySessionDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  createEffect(() => {
    const activeSessionId = state.activeSessionId;
    const selectedModel = state.selectedModel;
    const modelPayload = selectedModel
      ? {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
          variant: selectedModel.variant ? selectedModel.variant : undefined,
        }
      : null;
    const canSwitchSessions =
      shouldRenderWorkspace() &&
      !showModels() &&
      primarySessions().length >= 2 &&
      Boolean(
        activeSessionId && primarySessions().some((session) => session.id === activeSessionId)
      );
    const payload = {
      canAbort: Boolean(activeSessionId) && isActiveSessionWorking(),
      canSwitchSessions,
      model: modelPayload,
      sessionId: activeSessionId,
    };
    const key = JSON.stringify(payload);
    if (key === publishedCommandState) return;
    publishedCommandState = key;
    postMessage({ type: 'commands/state', payload });
  });

  let initialEditorRouteReconciled = false;
  createEffect(() => {
    if (initialEditorRouteReconciled || !isEditorSurface || !connectionInitialized()) return;
    initialEditorRouteReconciled = true;
    const initialRoute = webviewContext.initialRoute;
    if (initialRoute.type === 'session' && state.activeSessionId !== initialRoute.sessionId) {
      void (initialRoute.directory
        ? selectSession(initialRoute.sessionId, { directory: initialRoute.directory })
        : selectSession(initialRoute.sessionId));
    }
  });

  createEffect(() => {
    if (!isEditorSurface || !connectionInitialized()) return;
    const sessionId = state.activeSessionId;
    const title = activeSession()?.title;
    const directory = activeSession()?.directory;
    const rootSessionId = sessionId ? getSessionTreeRootId(sessionId) || sessionId : undefined;
    persistLastOpenedView(
      sessionId
        ? directory
          ? { type: 'session', sessionId, directory }
          : { type: 'session', sessionId }
        : { type: 'new-session' }
    );
    postMessage({
      type: 'editor/route-changed',
      payload: {
        route: sessionId
          ? { type: 'session', sessionId, directory, rootSessionId, title }
          : { type: 'new-session' },
      },
    });
  });
  onCleanup(() => {
    postMessage({
      type: 'commands/state',
      payload: { canAbort: false, canSwitchSessions: false, model: null },
    });
  });

  const clearReconnectBannerShowTimer = () => {
    if (reconnectBannerShowTimer == null) return;
    clearTimeout(reconnectBannerShowTimer);
    reconnectBannerShowTimer = undefined;
  };

  const clearReconnectBannerHideTimer = () => {
    if (reconnectBannerHideTimer == null) return;
    clearTimeout(reconnectBannerHideTimer);
    reconnectBannerHideTimer = undefined;
  };

  onMount(() => {
    if (!isFunction(window.matchMedia)) return;

    const mediaQuery = window.matchMedia(DESKTOP_SESSION_LAYOUT_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktopSessionLayout(event.matches);
    };

    setIsDesktopSessionLayout(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    onCleanup(() => mediaQuery.removeEventListener('change', handleChange));
  });

  onMount(() => {
    const unsubscribe = onSlowApiRequestsChange(setSlowApiRequests);
    onCleanup(unsubscribe);
  });

  onMount(() => {
    const clock = setInterval(() => setSessionListNow(Date.now()), SESSION_LIST_CLOCK_INTERVAL_MS);
    onCleanup(() => clearInterval(clock));
  });

  createEffect(
    on(isEventStreamDegraded, (isDegraded) => {
      if (isDegraded) {
        clearReconnectBannerHideTimer();
        if (showReconnectBanner() || reconnectBannerShowTimer != null) return;

        reconnectBannerShowTimer = setTimeout(() => {
          reconnectBannerShowTimer = undefined;
          reconnectBannerVisibleSince = Date.now();
          setShowReconnectBanner(true);
        }, RECONNECT_BANNER_SHOW_DELAY_MS);
        return;
      }

      clearReconnectBannerShowTimer();
      if (!showReconnectBanner()) return;

      const remainingVisibleMs =
        RECONNECT_BANNER_MIN_VISIBLE_MS - (Date.now() - reconnectBannerVisibleSince);
      if (remainingVisibleMs <= 0) {
        reconnectBannerVisibleSince = 0;
        setShowReconnectBanner(false);
        return;
      }

      if (reconnectBannerHideTimer != null) return;
      reconnectBannerHideTimer = setTimeout(() => {
        reconnectBannerHideTimer = undefined;
        reconnectBannerVisibleSince = 0;
        if (!isEventStreamDegraded()) setShowReconnectBanner(false);
      }, remainingVisibleMs);
    })
  );

  createEffect(
    on(
      () => state.activeSessionId,
      (sessionId) => clearDirectSessionReturnUnless(sessionId)
    )
  );

  createEffect(
    on(
      sessionSearchFocusKey,
      (key) => {
        if (key === 0) return;
        setSessionFilter(null);
        setSubagentParentId(null);
        setShowModels(false);
        setShowSessionPicker(true);
      },
      { defer: true }
    )
  );

  createEffect(() => {
    const indicators = sessionIndicators();
    const candidateIds = new Set<string>();
    for (const session of state.sessions) {
      if (!shouldAutoDeleteEmptySession(session, state.activeSessionId, indicators)) continue;
      candidateIds.add(session.id);
      if (pendingEmptySessionDeleteTimers.has(session.id)) continue;

      const timer = setTimeout(() => {
        pendingEmptySessionDeleteTimers.delete(session.id);
        const latestSession = state.sessions.find((item) => item.id === session.id);
        if (!latestSession) return;
        if (
          !shouldAutoDeleteEmptySession(latestSession, state.activeSessionId, sessionIndicators())
        ) {
          return;
        }
        void deleteEmptySession(session.id);
      }, EMPTY_SESSION_DELETE_DELAY_MS);
      pendingEmptySessionDeleteTimers.set(session.id, timer);
    }

    for (const [sessionId, timer] of pendingEmptySessionDeleteTimers) {
      if (candidateIds.has(sessionId)) continue;
      clearTimeout(timer);
      pendingEmptySessionDeleteTimers.delete(sessionId);
    }
  });

  onCleanup(() => {
    clearReconnectBannerShowTimer();
    clearReconnectBannerHideTimer();
    for (const timer of pendingEmptySessionDeleteTimers.values()) {
      clearTimeout(timer);
    }
    pendingEmptySessionDeleteTimers.clear();
  });

  const activeTitle = () => {
    const sessionId = state.pendingSessionSelectionId ?? state.activeSessionId;
    if (!sessionId) return 'New Chat';
    const session = sessionsById().get(sessionId);
    return normalizeSessionTitle(session?.title) || 'New Chat';
  };
  const headerSessionCounts = createMemo(() => {
    const indicators = sessionIndicators();
    return getHeaderSessionCounts(
      recentSessions(),
      state.activeSessionId,
      isEditorSurface ? false : showSessionPicker(),
      isDirectlyRunningSession,
      (sessionId) => indicators.attentionIds.has(sessionId),
      (sessionId) => indicators.failedIds.has(sessionId) && isSessionFailureUnread(sessionId),
      (session) =>
        indicators.planReadyIds.has(session.id) &&
        isSessionUnread(session.id, session.time.updated),
      (session) => indicators.newlyCompletedIds.has(session.id)
    );
  });
  const runningSessionsCount = () => headerSessionCounts().running;
  const attentionSessionsCount = () => headerSessionCounts().attention;
  const failedSessionsCount = () => headerSessionCounts().failed;
  const planReadySessionsCount = () => headerSessionCounts().planReady;
  const completedSessionsCount = () => headerSessionCounts().completed;
  const sessionSidebarRunningCount = () => headerSessionCounts().sidebarRunning;
  const sessionSidebarAttentionCount = () => headerSessionCounts().sidebarAttention;
  const sessionSidebarFailedCount = () => headerSessionCounts().sidebarFailed;
  const sessionSidebarPlanReadyCount = () => headerSessionCounts().sidebarPlanReady;
  const sessionSidebarCompletedCount = () => headerSessionCounts().sidebarCompleted;
  const primarySessionsCount = () => primarySessions().length;

  const openParentSession = async (parentSessionId: string) => {
    setSessionFilter(null);
    setSubagentParentId(null);
    setShowSessionPicker(false);
    await selectSession(parentSessionId);
  };

  const openSessionFilter = async (filter: SessionListFilter) => {
    const indicators = sessionIndicators();
    const matchingSessions = getPrimarySessionsForFilter(
      recentSessions(),
      filter,
      filter === 'running'
        ? isDirectlyRunningSession
        : (sessionId) => indicators.runningIds.has(sessionId),
      (sessionId) => indicators.attentionIds.has(sessionId),
      (sessionId) => indicators.failedIds.has(sessionId),
      (session) => indicators.planReadyIds.has(session.id),
      (session) => indicators.newlyCompletedIds.has(session.id)
    );
    if (matchingSessions.length === 0) return;

    const autoOpenSessionId = getAutoOpenSessionIdForFilter(
      recentSessions(),
      filter,
      state.activeSessionId,
      showSessionPicker(),
      filter === 'running'
        ? isDirectlyRunningSession
        : (sessionId) => indicators.runningIds.has(sessionId),
      (sessionId) => indicators.attentionIds.has(sessionId),
      (sessionId) => indicators.failedIds.has(sessionId),
      (session) => indicators.planReadyIds.has(session.id),
      (session) => indicators.newlyCompletedIds.has(session.id)
    );

    if (autoOpenSessionId) {
      setSessionFilter(null);
      setSubagentParentId(null);
      await selectSession(autoOpenSessionId);
      return;
    }

    setSubagentParentId(null);
    setSessionFilter(filter);
    setShowSessionPicker(true);
  };

  createEffect(() => {
    if (!showSessionPicker()) {
      setSessionFilter(null);
      setSubagentParentId(null);
    }
  });

  createEffect(
    on(
      openAttentionSessionsKey,
      () => {
        openAttentionSessionsFromCommand();
      },
      { defer: true }
    )
  );

  createEffect(
    on(
      openCompletedSessionsKey,
      () => {
        openCompletedSessions();
      },
      { defer: true }
    )
  );

  const openAllSessions = async () => {
    setSessionFilter(null);
    setSubagentParentId(null);
    const sessionId = state.activeSessionId;
    const directReturnSessionId = getDirectSessionReturnId(sessionId);
    if (directReturnSessionId) {
      clearDirectSessionReturn();
      setShowSessionPicker(false);
      await selectSession(directReturnSessionId);
      return;
    }
    // Ralph owns its iteration and repair sessions, so return to the dashboard
    // before applying generic sub-agent navigation.
    const ralphParentId = ralphStore.findManagerSessionIdForChild(sessionId);
    if (ralphParentId && ralphParentId !== sessionId) {
      setShowSessionPicker(false);
      await selectSession(ralphParentId);
      return;
    }
    const parentSessionId = sessionId ? sessionsById().get(sessionId)?.parentID : null;
    if (parentSessionId) {
      const rootSessionId = getSessionTreeRootId(sessionId) || parentSessionId;
      if (isDesktopSessionLayout()) {
        setShowSessionPicker(false);
        await selectSession(rootSessionId);
        return;
      }
      setSubagentParentId(rootSessionId);
      setShowSessionPicker(true);
      return;
    }
    const discardableActiveBlankSessionId = getDiscardableActiveBlankSessionId();
    if (sessionId && discardableActiveBlankSessionId) {
      setShowSessionPicker(true);
      await deleteEmptySession(discardableActiveBlankSessionId);
      return;
    }
    setShowSessionPicker(true);
  };

  const switchActiveSession = (direction: -1 | 1) => {
    if (!shouldRenderWorkspace() || showModels()) return;

    const activeSessionId = state.activeSessionId;
    if (!activeSessionId) return;

    const now = Date.now();
    const orderedSessions = primarySessions().toSorted((left, right) =>
      compareSessionsForDisplay(left, right, now, state.pinnedSessionIds)
    );
    if (orderedSessions.length < 2) return;

    const activeIndex = orderedSessions.findIndex((session) => session.id === activeSessionId);
    if (activeIndex === -1) return;

    const nextIndex = (activeIndex + direction + orderedSessions.length) % orderedSessions.length;
    void selectSession(orderedSessions[nextIndex]!.id);
  };

  onMount(() => {
    const disposeBridge = onMessage((message) => {
      if (message.type !== 'command/switch-session') return;
      switchActiveSession(message.payload.direction === 'previous' ? -1 : 1);
    });
    const handleKeydown = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }

      // Target handlers run before this window listener, while other window
      // handlers may run after it.
      const wasHandled = event.defaultPrevented;
      queueMicrotask(() => {
        if (
          wasHandled ||
          event.defaultPrevented ||
          // SAFETY: The surrounding shape or discriminator check establishes the KeyboardEvent contract used below.
          (event as KeyboardEvent & { varroHandled?: boolean }).varroHandled
        ) {
          return;
        }
        if (showPermissionSettings()) {
          setShowPermissionSettings(false);
          return;
        }
        if (showModels()) {
          setShowModels(false);
          return;
        }
        if (showSessionPicker()) return;
        void openAllSessions();
      });
    };

    window.addEventListener('keydown', handleKeydown);
    onCleanup(() => {
      disposeBridge();
      window.removeEventListener('keydown', handleKeydown);
    });
  });

  const openSubagentListParentSession = () => {
    const parentSessionId = subagentParentId();
    if (!parentSessionId) return;
    void openParentSession(parentSessionId);
  };

  const openRunningSessions = () => {
    void openSessionFilter('running');
  };

  const openAttentionSessions = () => {
    void openSessionFilter('attention');
  };

  const openAttentionSessionsFromCommand = () => {
    const attentionCount = getHeaderAttentionCount(
      recentSessions(),
      (sessionId) => sessionIndicators().attentionIds.has(sessionId),
      state.activeSessionId,
      false
    );
    if (attentionCount > 0) {
      void openSessionFilter('attention');
      return;
    }
    const failedCount = failedSessionsCount();
    if (failedCount > 0) {
      void openSessionFilter('failed');
      return;
    }
    void openSessionFilter('plan-ready');
  };

  const openFailedSessions = () => {
    void openSessionFilter('failed');
  };

  const openPlanReadySessions = () => {
    void openSessionFilter('plan-ready');
  };

  const openCompletedSessions = () => {
    void openSessionFilter('completed');
  };

  const openSubagentSessions = (parentSessionId: string) => {
    setSessionFilter(null);
    setSubagentParentId(parentSessionId);
    setShowSessionPicker(true);
  };

  const openSidebarSubagentSessions = (parentSessionId: string) => {
    if (showSessionPicker()) {
      setSessionFilter(null);
      setSubagentParentId(parentSessionId);
      return;
    }
    setSidebarSubagentParentId(parentSessionId);
  };

  const openTopLevelSidebarSessions = () => {
    setSessionFilter(null);
    setSubagentParentId(null);
    setSidebarSubagentParentId(null);
  };

  const activeSession = createMemo(() => {
    const sessionId = state.activeSessionId;
    return sessionId ? sessionsById().get(sessionId) || null : null;
  });
  const managedSubagentParent = createMemo(() => {
    const parentId = activeSession()?.parentID;
    return parentId ? sessionsById().get(parentId) || null : null;
  });
  const managedSubagentParentTitle = createMemo(() => {
    const parent = managedSubagentParent();
    return parent ? normalizeSessionTitle(parent.title) || null : null;
  });
  const returnToManagedSubagentParent = () => {
    const parentId = activeSession()?.parentID;
    if (parentId) void openParentSession(parentId);
  };
  const activeBackTitle = createMemo(() => {
    if (
      getDirectSessionReturnId(state.activeSessionId) ||
      ralphStore.findManagerSessionIdForChild(state.activeSessionId) ||
      (isDesktopSessionLayout() && activeSession()?.parentID)
    ) {
      return 'Back to parent session';
    }
    return activeSession()?.parentID ? 'Back to sub-agent sessions' : 'Back to sessions';
  });
  createEffect(
    on(
      [
        () => state.activeSessionId,
        () => activeSession()?.parentID || null,
        () => getSessionTreeRootId(state.activeSessionId),
      ],
      ([, parentSessionId, rootSessionId]) => {
        setSidebarSubagentParentId(parentSessionId ? rootSessionId || parentSessionId : null);
      }
    )
  );
  const activeSubagentRootId = createMemo(() => {
    const session = activeSession();
    return session && !session.parentID ? session.id : null;
  });
  const activeSubagentCount = createMemo(() => {
    const rootSessionId = activeSubagentRootId();
    if (!rootSessionId) return 0;
    return sessionIndicators().subagentCounts.get(rootSessionId) || 0;
  });
  const activeSubagentLabel = createMemo(() => {
    const count = activeSubagentCount();
    return `Show ${count} sub-agent session${count === 1 ? '' : 's'}`;
  });

  const clearSessionListView = () => {
    setSessionFilter(null);
    setSubagentParentId(null);
  };

  const activeSubagentParent = createMemo(() => {
    const parentId = subagentParentId();
    if (!parentId) return null;
    return sessionsById().get(parentId) || null;
  });
  const sessionListFilterLabel = createMemo(() => {
    const subagentParent = activeSubagentParent();
    if (subagentParent) {
      return `Sub-agents for ${normalizeSessionTitle(subagentParent.title) || 'Untitled'}`;
    }
    if (subagentParentId()) return 'Sub-agents';
    return getSessionListFilterLabel(sessionFilter());
  });
  const sessionListFilterPrefix = createMemo(() => (subagentParentId() ? 'Viewing:' : 'Filtered:'));
  const sessionListFilterTitle = createMemo(() => {
    const subagentParent = activeSubagentParent();
    if (subagentParent) {
      return `Sub-agents for ${normalizeSessionTitle(subagentParent.title) || 'Untitled'}`;
    }

    const label = sessionListFilterLabel();
    return label ? `Filtered by ${label}` : undefined;
  });
  const shouldShowHeaderBadge = (filter: SessionListFilter) =>
    shouldShowSessionHeaderBadge(sessionFilter(), filter);
  const sidebarSubagentParent = createMemo(() => {
    const parentId = sidebarSubagentParentId();
    return parentId ? sessionsById().get(parentId) || null : null;
  });
  const sidebarSessionListFilterLabel = createMemo(() => {
    const parent = sidebarSubagentParent();
    if (parent) return `Sub-agents for ${normalizeSessionTitle(parent.title) || 'Untitled'}`;
    return sidebarSubagentParentId() ? 'Sub-agents' : null;
  });
  const sidebarSessionListFilterTitle = createMemo(() => {
    const label = sidebarSessionListFilterLabel();
    return label || undefined;
  });

  return (
    <>
      <ChatWorkspace
        shouldRenderWorkspace={shouldRenderWorkspace()}
        isDesktopSessionPaneRight={isDesktopSessionPaneRight()}
        showDesktopSessionPane={!isEditorSurface}
        showSessionHeader={!isEditorSurface}
        showSessionPicker={isEditorSurface ? false : showSessionPicker()}
        showModels={showModels()}
        showPermissionSettings={showPermissionSettings()}
        showReconnectBanner={showReconnectBanner()}
        slowApiRequests={slowApiRequests()}
        sessionFilter={sessionFilter()}
        subagentParentId={subagentParentId()}
        sidebarSubagentParentId={sidebarSubagentParentId()}
        sessionListFilterLabel={sessionListFilterLabel()}
        sessionListFilterPrefix={sessionListFilterPrefix()}
        sessionListFilterTitle={sessionListFilterTitle()}
        sidebarSessionListFilterLabel={sidebarSessionListFilterLabel()}
        sidebarSessionListFilterTitle={sidebarSessionListFilterTitle()}
        primarySessionsCount={primarySessionsCount()}
        shouldShowFailedBadge={shouldShowHeaderBadge('failed')}
        shouldShowAttentionBadge={shouldShowHeaderBadge('attention')}
        shouldShowPlanReadyBadge={shouldShowHeaderBadge('plan-ready')}
        shouldShowCompletedBadge={shouldShowHeaderBadge('completed')}
        shouldShowRunningBadge={shouldShowHeaderBadge('running')}
        failedSessionsCount={failedSessionsCount()}
        attentionSessionsCount={attentionSessionsCount()}
        planReadySessionsCount={planReadySessionsCount()}
        completedSessionsCount={completedSessionsCount()}
        runningSessionsCount={runningSessionsCount()}
        sessionSidebarFailedCount={sessionSidebarFailedCount()}
        sessionSidebarAttentionCount={sessionSidebarAttentionCount()}
        sessionSidebarPlanReadyCount={sessionSidebarPlanReadyCount()}
        sessionSidebarCompletedCount={sessionSidebarCompletedCount()}
        sessionSidebarRunningCount={sessionSidebarRunningCount()}
        activeTitle={activeTitle()}
        activeBackTitle={activeBackTitle()}
        showDesktopBackButton={
          isDesktopSessionLayout() &&
          (!!activeSession()?.parentID || !!getDirectSessionReturnId(state.activeSessionId))
        }
        activeSubagentRootId={activeSubagentCount() > 0 ? activeSubagentRootId() : null}
        activeSubagentCount={activeSubagentCount()}
        activeSubagentLabel={activeSubagentLabel()}
        managedSubagentParentId={activeSession()?.parentID || null}
        managedSubagentParentTitle={managedSubagentParentTitle()}
        onClearSessionListView={clearSessionListView}
        onOpenAllSessions={() => {
          void openAllSessions();
        }}
        onReturnToManagedSubagentParent={returnToManagedSubagentParent}
        onOpenParentSession={openSubagentListParentSession}
        onOpenSubagentSessions={openSubagentSessions}
        onOpenSidebarSubagentSessions={openSidebarSubagentSessions}
        onOpenTopLevelSidebarSessions={openTopLevelSidebarSessions}
        onOpenFailedSessions={openFailedSessions}
        onOpenAttentionSessions={openAttentionSessions}
        onOpenPlanReadySessions={openPlanReadySessions}
        onOpenCompletedSessions={openCompletedSessions}
        onOpenRunningSessions={openRunningSessions}
        onCreateSessionFromPicker={startNewChatDraft}
        onCreateSession={startNewChatDraft}
      />
      <Show when={providerConnectionData()}>
        {(data) => (
          <ProviderConnectionDialog
            catalogProviders={data().providers}
            providerLoadError={data().error}
            isLoadingProviders={data().loading}
            initialProviderID={data().providerID}
            lockProvider={Boolean(data().providerID)}
            reauthentication={Boolean(data().providerID)}
            onClose={() => setProviderConnectionData(null)}
          />
        )}
      </Show>
    </>
  );
}

async function deleteEmptySession(sessionId: string) {
  await deleteSessionImmediately(sessionId);
}

export {
  SessionListSectionHeader,
  archiveSessionGroup,
  deriveSessionIndicators,
  getDiffSummaryStats,
  getPrimarySessionsForFilter,
  getRecentSessions,
  getRecycleBinSessionIds,
  getSessionListFilterLabel,
  getSessionSummaryStats,
  getSubagentSessionsForParent,
  groupSessions,
  isFailedSession,
  isRunningSession,
  shouldShowSessionHeaderBadge,
} from './chat/SessionListView';
export type { SessionListFilter } from './chat/SessionListView';

export function getAttentionSessions(
  sessions: typeof state.sessions,
  isNeedingAttention: (sessionId: string) => boolean
) {
  return sessions.filter((session) => isNeedingAttention(session.id));
}

export function getAutoOpenSessionIdForFilter(
  sessions: typeof state.sessions,
  filter: SessionListFilter,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean,
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isCompleted: (session: (typeof state.sessions)[number]) => boolean
) {
  if (isSessionPickerOpen) return null;

  const matchingSessions = getPrimarySessionsForFilter(
    sessions,
    filter,
    isRunning,
    isNeedingAttention,
    isFailed,
    isPlanReady,
    isCompleted
  ).filter((session) => session.id !== activeSessionId);

  return matchingSessions.length === 1 ? matchingSessions[0]?.id || null : null;
}

export function getOtherSessions(
  sessions: typeof state.sessions,
  isNeedingAttention: (sessionId: string) => boolean
) {
  return sessions.filter((session) => !isNeedingAttention(session.id));
}

export function getHeaderAttentionCount(
  sessions: typeof state.sessions,
  isNeedingAttention: (sessionId: string) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return getAttentionSessions(sessions, isNeedingAttention).reduce((count, session) => {
    if (!isPrimarySession(session)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

export function isEmptySession(session: (typeof state.sessions)[number]) {
  return isEmptySessionMetadata(session);
}

export function shouldAutoDeleteEmptySession(
  session: (typeof state.sessions)[number],
  activeSessionId: string | null,
  indicators: Pick<
    ReturnType<typeof deriveSessionIndicators>,
    'runningIds' | 'attentionIds' | 'failedIds' | 'planReadyIds'
  >
) {
  return shouldPruneEmptySession(session, {
    activeSessionId,
    isQueued: (sessionId) => state.queuedMessages.some((item) => item.sessionId === sessionId),
    isAwaitingInput: isSessionAwaitingInput,
    isRunning: (sessionId) => indicators.runningIds.has(sessionId),
    needsAttention: (sessionId) => indicators.attentionIds.has(sessionId),
    isFailed: (sessionId) => indicators.failedIds.has(sessionId),
    isPlanReady: (item) => indicators.planReadyIds.has(item.id),
    preserve: ralphStore.isRalphSession(session.id),
    statusType: state.sessionStatus[session.id]?.type,
  });
}

function shouldHideSessionFromList(
  session: (typeof state.sessions)[number],
  indicators: Pick<
    ReturnType<typeof deriveSessionIndicators>,
    'runningIds' | 'attentionIds' | 'failedIds' | 'planReadyIds'
  >
) {
  return shouldHideEmptySessionFromList(session, {
    isQueued: (sessionId) => state.queuedMessages.some((item) => item.sessionId === sessionId),
    isAwaitingInput: isSessionAwaitingInput,
    isRunning: (sessionId) => indicators.runningIds.has(sessionId),
    needsAttention: (sessionId) => indicators.attentionIds.has(sessionId),
    isFailed: (sessionId) => indicators.failedIds.has(sessionId),
    isPlanReady: (item) => indicators.planReadyIds.has(item.id),
    preserve: ralphStore.isRalphSession(session.id),
    statusType: state.sessionStatus[session.id]?.type,
  });
}

export function getHeaderFailedCount(
  sessions: typeof state.sessions,
  isFailed: (sessionId: string) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return sessions.reduce((count, session) => {
    if (!isPrimarySession(session) || !isFailed(session.id)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

export function getHeaderRunningCount(
  sessions: typeof state.sessions,
  isRunning: (sessionId: string) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return sessions.reduce((count, session) => {
    if (!isPrimarySession(session) || !isRunning(session.id)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

export function getHeaderPlanReadyCount(
  sessions: typeof state.sessions,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return sessions.reduce((count, session) => {
    if (!isPrimarySession(session) || !isPlanReady(session)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

export function getHeaderCompletedCount(
  sessions: typeof state.sessions,
  isCompleted: (session: (typeof state.sessions)[number]) => boolean,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean
) {
  return sessions.reduce((count, session) => {
    if (!isPrimarySession(session) || !isCompleted(session)) return count;
    if (!isSessionPickerOpen && session.id === activeSessionId) return count;
    return count + 1;
  }, 0);
}

function getHeaderSessionCounts(
  sessions: typeof state.sessions,
  activeSessionId: string | null,
  isSessionPickerOpen: boolean,
  isRunning: (sessionId: string) => boolean,
  isNeedingAttention: (sessionId: string) => boolean,
  isFailed: (sessionId: string) => boolean,
  isPlanReady: (session: (typeof state.sessions)[number]) => boolean,
  isCompleted: (session: (typeof state.sessions)[number]) => boolean
): HeaderSessionCounts {
  const counts: HeaderSessionCounts = {
    running: 0,
    attention: 0,
    failed: 0,
    planReady: 0,
    completed: 0,
    sidebarRunning: 0,
    sidebarAttention: 0,
    sidebarFailed: 0,
    sidebarPlanReady: 0,
    sidebarCompleted: 0,
  };

  for (const session of sessions) {
    if (!isPrimarySession(session)) continue;

    const includeHeader = isSessionPickerOpen || session.id !== activeSessionId;
    if (isFailed(session.id)) {
      counts.sidebarFailed += 1;
      if (includeHeader) counts.failed += 1;
    }
    if (isPlanReady(session)) {
      counts.sidebarPlanReady += 1;
      if (includeHeader) counts.planReady += 1;
    }
    if (isCompleted(session)) {
      counts.sidebarCompleted += 1;
      if (includeHeader) counts.completed += 1;
    }
    if (isNeedingAttention(session.id)) {
      counts.sidebarAttention += 1;
      if (includeHeader) counts.attention += 1;
    }
    if (isRunning(session.id)) {
      counts.sidebarRunning += 1;
      if (includeHeader) counts.running += 1;
    }
  }

  return counts;
}

export function getArchiveSessionGroupConfirmationMessage(label: string, count: number) {
  return `Archive ${count} session${count === 1 ? '' : 's'} in ${label}? This cannot be undone.`;
}
