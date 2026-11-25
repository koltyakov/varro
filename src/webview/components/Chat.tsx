import {
  Show,
  createSignal,
  onSettled,
  onCleanup,
  createEffect,
  createMemo,
  untrack,
} from 'solid-js';
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
  getSessionPlanUpdatedAt,
  isActiveSessionWorking,
  getSessionTreeRootId,
  getSelectedAgentForSession,
  persistLastOpenedView,
  setShowModels,
  showPermissionSettings,
  setShowPermissionSettings,
  showMcpSettings,
  setShowMcpSettings,
  requestComposerFocus,
} from '../lib/state';
import { selectSession, deleteSessionImmediately, refreshRoutingState } from '../hooks/useOpenCode';
import { normalizeSessionTitle } from '../../shared/session-title';
import { ChatWorkspace } from './chat/ChatWorkspace';
import { createProviderSetupPrompt } from './chat/provider-setup-prompt';
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
  requestProviderConnection,
} from '../lib/provider-connection-state';
import { client } from '../lib/client';
import { createPendingBackgroundSessionIds } from '../lib/background-session-status';
import type { Provider, Session } from '../types';
import {
  clearDirectSessionReturn,
  clearDirectSessionReturnUnless,
  getDirectSessionReturnId,
} from '../lib/session-navigation';
import { isFunction } from '../lib/runtime-values';
import { ProviderConnectionDialog } from './ProviderConnectionDialog';
import { BackgroundProcessDialog } from './BackgroundProcessDialog';
import { SideQuestionDialog } from './SideQuestionDialog';
import { sideQuestionView, closeSideQuestion } from '../lib/side-question';
import { backgroundProcessView, closeBackgroundProcessView } from '../lib/background-process-view';
import {
  clearSubagentSessionsRequest,
  subagentSessionsRequest,
} from '../lib/subagent-sessions-view';
import { readWebviewInstanceContext } from '../lib/state-stored-values';
import { isSessionTransferHidden } from '../lib/session-transfer';

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

function isDirectlyRunningSession(session: Session, compactingSessionIds: ReadonlySet<string>) {
  return (
    isRunningSession(
      session.id,
      compactingSessionIds.has(session.id) || !!session.time.compacting
    ) ||
    (session.id === state.activeSessionId && isLoading())
  );
}

export function Chat() {
  const webviewContext = readWebviewInstanceContext();
  const isEditorSurface = webviewContext?.surface === 'editor';
  const [providerConnectionData, setProviderConnectionData] = createSignal<{
    providers: Provider[];
    error: string;
    loading: boolean;
    providerID: string | null;
    methodID?: string;
  } | null>(null);

  createEffect(
    () => ({ request: providerConnectionRequest(), data: providerConnectionData() }),
    ({ request, data }) => {
      if (!request || data) return;
      untrack(() => consumeProviderConnectionRequest(request.id));
      const loadingState = {
        providers: [],
        error: '',
        loading: true,
        providerID: request.providerID,
        methodID: request.methodID,
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
            methodID: request.methodID,
          });
        },
        (error) => {
          if (providerConnectionData() !== loadingState) return;
          setProviderConnectionData({
            providers: [],
            error: error instanceof Error ? error.message : String(error),
            loading: false,
            providerID: request.providerID,
            methodID: request.methodID,
          });
        }
      );
    }
  );
  const [sessionFilter, setSessionFilter] = createSignal<SessionListFilter | null>(null);
  createEffect(
    () => {
      const view = backgroundProcessView();
      return !!view && view.sessionID !== state.activeSessionId;
    },
    (close) => {
      if (close) closeBackgroundProcessView();
    }
  );
  onCleanup(closeBackgroundProcessView);
  createEffect(
    () => {
      const view = sideQuestionView();
      if (!view) return false;
      const session = state.sessions.find((entry) => entry.id === view.sessionID);
      return (
        state.activeSessionId !== view.sessionID ||
        session?.directory !== view.directory ||
        state.serverStatus.state !== 'running' ||
        state.serverStatus.url !== view.serverURL ||
        state.serverStatus.apiVersion !== 2
      );
    },
    (close) => {
      if (close) closeSideQuestion();
    }
  );
  onCleanup(closeSideQuestion);
  const [subagentParentId, setSubagentParentId] = createSignal<string | null>(null);
  const [sidebarSubagentParentId, setSidebarSubagentParentId] = createSignal<string | null>(null);
  const [isDesktopSessionLayout, setIsDesktopSessionLayout] = createSignal(false);
  const [showReconnectBanner, setShowReconnectBanner] = createSignal(false);
  // An inline prompt instead of opening provider setup: a server that briefly
  // reports no providers must not take over the view.
  const providerSetupNeeded = createProviderSetupPrompt({
    isReady: () =>
      connectionInitialized() &&
      state.serverStatus.state === 'running' &&
      !state.serverReconnecting &&
      state.providersLoaded,
    hasProviders: () => state.providers.length > 0,
    refreshProviders: refreshRoutingState,
  });
  const showProviderSetupBanner = () => providerSetupNeeded() && !showModels();
  const openProviderSetup = () => {
    setShowModels(true);
    requestProviderConnection();
  };
  const [slowApiRequests, setSlowApiRequests] = createSignal<readonly SlowApiRequest[]>([]);
  const [sessionListNow, setSessionListNow] = createSignal(Date.now());
  const pendingBackgroundIds = createPendingBackgroundSessionIds(() => state.sessionStatus);
  const rawSessionIndicators = createMemo(() =>
    deriveSessionIndicators(state.sessions, pendingBackgroundIds())
  );
  const sessionIndicators = createStableSessionIndicators(rawSessionIndicators);
  // Keep direct activity visible through the same settle window as completion,
  // without counting parents whose only activity comes from their subagents.
  const directSessionIndicators = createStableSessionIndicators(() => {
    const compactingSessionIds = new Set(state.compactingSessionIds);
    return {
      ...rawSessionIndicators(),
      runningIds: new Set(
        state.sessions
          .filter((session) => isDirectlyRunningSession(session, compactingSessionIds))
          .map((session) => session.id)
      ),
    };
  });
  const isStablyDirectlyRunningSession = (sessionId: string) =>
    directSessionIndicators().runningIds.has(sessionId);
  let publishedUnreadWorkspace: string | null = null;
  const publishedUnreadStates = new Map<string, PublishedUnreadState>();
  let publishedCommandState = '';
  createEffect(
    () => {
      const workspacePath = state.editorContext.workspacePath;
      // Publish from the settled indicators, and never while a session's turn is
      // still running (including the settle window between steps). Raw indicators
      // drop in and out of plan-ready/completed in the idle gaps of a stepping
      // turn, and mirroring those flaps to the host makes its attention state -
      // and the status bar item - flicker for the whole turn.
      const indicators = sessionIndicators();
      if (!workspacePath) return null;
      const updates: Array<{ sessionId: string; directory: string; next: PublishedUnreadState }> =
        [];
      for (const session of state.sessions) {
        if (!isPrimarySession(session)) continue;
        if (indicators.runningIds.has(session.id)) continue;
        const previous =
          publishedUnreadWorkspace === workspacePath
            ? publishedUnreadStates.get(session.id)
            : undefined;
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
            const updatedAt = getSessionPlanUpdatedAt(session.id, session.time.updated);
            const unread = isSessionUnread(session.id, updatedAt);
            next = {
              kind,
              unread,
              markerAt: unread ? updatedAt : (seenAt ?? updatedAt),
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
        updates.push({ sessionId: session.id, directory: session.directory, next });
      }
      return { workspacePath, updates };
    },
    (publication) => {
      if (!publication) return;
      const { workspacePath, updates } = publication;
      if (publishedUnreadWorkspace !== workspacePath) {
        publishedUnreadWorkspace = workspacePath;
        publishedUnreadStates.clear();
      }
      for (const { sessionId, directory, next } of updates) {
        const previous = publishedUnreadStates.get(sessionId);
        if (
          previous?.kind === next.kind &&
          previous.unread === next.unread &&
          previous.markerAt === next.markerAt
        ) {
          continue;
        }
        publishedUnreadStates.set(sessionId, next);
        postMessage({
          type: 'session-unread-state/update',
          payload: {
            sessionId,
            directory,
            ...next,
          },
        });
      }
    }
  );
  const recycleBinSessionIds = createMemo(() => getRecycleBinSessionIds(state.recycleBinEntries));
  const visibleSessions = createMemo(() => {
    const indicators = sessionIndicators();
    const directory =
      (state.editorContext.workspaceFolders?.length ?? 0) > 1
        ? null
        : (state.editorContext.workspacePath ?? state.editorContext.workspaceFolders?.[0]?.path);
    return state.sessions.filter(
      (session) =>
        !isSessionTransferHidden(session, directory) &&
        !recycleBinSessionIds().has(session.id) &&
        !shouldHideSessionFromList(session, indicators)
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
  const activeSession = createMemo(() => {
    const sessionId = state.activeSessionId;
    return sessionId ? sessionsById().get(sessionId) || null : null;
  });
  const isEventStreamDegraded = createMemo(
    () => state.serverStatus.state === 'running' && state.serverStatus.eventStream === 'degraded'
  );
  const shouldRenderWorkspace = () =>
    isEditorSurface || !showSessionPicker() || isDesktopSessionLayout();
  let reconnectBannerShowTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectBannerHideTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectBannerVisibleSince = 0;
  const pendingEmptySessionDeleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

  createEffect(
    () => {
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
      return {
        canAbort: Boolean(activeSessionId) && isActiveSessionWorking(),
        canSwitchSessions,
        model: modelPayload,
        modelVisible: shouldRenderWorkspace() && !showModels(),
        sessionId: activeSessionId,
      };
    },
    (payload) => {
      const key = JSON.stringify(payload);
      if (key === publishedCommandState) return;
      publishedCommandState = key;
      postMessage({ type: 'commands/state', payload });
    }
  );

  let initialEditorRouteReconciled = false;
  let preRestoreSessionId: string | null | undefined;
  const [restoreSettled, setRestoreSettled] = createSignal(false);
  createEffect(
    () => {
      if (!isEditorSurface || !connectionInitialized()) return null;
      const sessionId = state.activeSessionId;
      const title = activeSession()?.title;
      const directory = activeSession()?.directory;
      const rootSessionId = sessionId ? getSessionTreeRootId(sessionId) || sessionId : undefined;
      const initialRoute = webviewContext.initialRoute;
      const restorePending =
        initialRoute.type === 'session' &&
        initialRoute.sessionId !== sessionId &&
        !restoreSettled();
      return { sessionId, title, directory, rootSessionId, initialRoute, restorePending };
    },
    (route) => {
      if (!route) return;
      const { sessionId, title, directory, rootSessionId, initialRoute } = route;
      if (!initialEditorRouteReconciled) {
        initialEditorRouteReconciled = true;
        if (initialRoute.type === 'session' && initialRoute.sessionId !== sessionId) {
          preRestoreSessionId = sessionId;
          void (
            initialRoute.directory
              ? selectSession(initialRoute.sessionId, { directory: initialRoute.directory })
              : selectSession(initialRoute.sessionId)
          ).finally(() => setRestoreSettled(true));
          return;
        }
      }
      // A selection can wait for directory activation. Don't serialize the old route in that gap.
      if (route.restorePending && preRestoreSessionId === sessionId) return;
      preRestoreSessionId = undefined;
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
    }
  );
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

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    if (!isFunction(window.matchMedia))
      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };

    const mediaQuery = window.matchMedia(DESKTOP_SESSION_LAYOUT_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktopSessionLayout(event.matches);
    };

    setIsDesktopSessionLayout(mediaQuery.matches);
    mediaQuery.addEventListener('change', handleChange);
    cleanups.push(() => mediaQuery.removeEventListener('change', handleChange));

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    const unsubscribe = onSlowApiRequestsChange(setSlowApiRequests);
    cleanups.push(unsubscribe);

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  onSettled(() => {
    const cleanups: Array<() => void> = [];

    const clock = setInterval(() => setSessionListNow(Date.now()), SESSION_LIST_CLOCK_INTERVAL_MS);
    cleanups.push(() => clearInterval(clock));

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  createEffect(isEventStreamDegraded, (isDegraded) => {
    if (isDegraded) {
      clearReconnectBannerHideTimer();
      if (untrack(showReconnectBanner) || reconnectBannerShowTimer != null) return;

      reconnectBannerShowTimer = setTimeout(() => {
        reconnectBannerShowTimer = undefined;
        reconnectBannerVisibleSince = Date.now();
        setShowReconnectBanner(true);
      }, RECONNECT_BANNER_SHOW_DELAY_MS);
      return;
    }

    clearReconnectBannerShowTimer();
    if (!untrack(showReconnectBanner)) return;

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
  });

  createEffect(
    () => state.activeSessionId,
    (sessionId) => clearDirectSessionReturnUnless(sessionId)
  );

  createEffect(
    sessionSearchFocusKey,
    (key) => {
      if (key === 0) return;
      // Actions persist the current view state; the focus key alone decides when they run.
      untrack(() => {
        setSessionFilter(null);
        setSubagentParentId(null);
        setShowModels(false);
        setShowSessionPicker(true);
      });
    },
    { defer: true }
  );

  createEffect(
    () => {
      const indicators = sessionIndicators();
      return state.sessions
        .filter((session) =>
          shouldAutoDeleteEmptySession(session, state.activeSessionId, indicators)
        )
        .map((session) => session.id);
    },
    (candidates) => {
      const candidateIds = new Set(candidates);
      for (const sessionId of candidates) {
        if (pendingEmptySessionDeleteTimers.has(sessionId)) continue;

        const timer = setTimeout(() => {
          pendingEmptySessionDeleteTimers.delete(sessionId);
          const latestSession = state.sessions.find((item) => item.id === sessionId);
          if (!latestSession) return;
          if (
            !shouldAutoDeleteEmptySession(latestSession, state.activeSessionId, sessionIndicators())
          ) {
            return;
          }
          void deleteEmptySession(sessionId);
        }, EMPTY_SESSION_DELETE_DELAY_MS);
        pendingEmptySessionDeleteTimers.set(sessionId, timer);
      }

      for (const [sessionId, timer] of pendingEmptySessionDeleteTimers) {
        if (candidateIds.has(sessionId)) continue;
        clearTimeout(timer);
        pendingEmptySessionDeleteTimers.delete(sessionId);
      }
    }
  );

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
      (sessionId) =>
        isStablyDirectlyRunningSession(sessionId) && !indicators.pendingIds.has(sessionId),
      (sessionId) => indicators.attentionIds.has(sessionId),
      (sessionId) => indicators.failedIds.has(sessionId) && isSessionFailureUnread(sessionId),
      (session) =>
        indicators.planReadyIds.has(session.id) &&
        isSessionUnread(session.id, getSessionPlanUpdatedAt(session.id, session.time.updated)),
      (session) => indicators.newlyCompletedIds.has(session.id)
    );
  });
  const runningSessionsCount = () => headerSessionCounts().running;
  const pendingSessionCounts = createMemo(() => {
    const indicators = sessionIndicators();
    return getHeaderSessionCounts(
      recentSessions(),
      state.activeSessionId,
      isEditorSurface ? false : showSessionPicker(),
      (sessionId) => indicators.pendingIds.has(sessionId),
      () => false,
      () => false,
      () => false,
      () => false
    );
  });
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
        ? isStablyDirectlyRunningSession
        : (sessionId) => indicators.runningIds.has(sessionId),
      (sessionId) => indicators.attentionIds.has(sessionId),
      (sessionId) => indicators.failedIds.has(sessionId),
      (session) => indicators.planReadyIds.has(session.id),
      (session) => indicators.newlyCompletedIds.has(session.id),
      (sessionId) => indicators.pendingIds.has(sessionId)
    );
    if (matchingSessions.length === 0) return;

    const autoOpenSessionId = getAutoOpenSessionIdForFilter(
      recentSessions(),
      filter,
      state.activeSessionId,
      showSessionPicker(),
      filter === 'running'
        ? isStablyDirectlyRunningSession
        : (sessionId) => indicators.runningIds.has(sessionId),
      (sessionId) => indicators.attentionIds.has(sessionId),
      (sessionId) => indicators.failedIds.has(sessionId),
      (session) => indicators.planReadyIds.has(session.id),
      (session) => indicators.newlyCompletedIds.has(session.id),
      (sessionId) => indicators.pendingIds.has(sessionId)
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

  createEffect(showSessionPicker, (show) => {
    if (!show) {
      setSessionFilter(null);
      setSubagentParentId(null);
    }
  });

  createEffect(
    openAttentionSessionsKey,
    () => {
      untrack(openAttentionSessionsFromCommand);
    },
    { defer: true }
  );

  createEffect(
    openCompletedSessionsKey,
    () => {
      untrack(openCompletedSessions);
    },
    { defer: true }
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

  onSettled(() => {
    const cleanups: Array<() => void> = [];

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
        if (showMcpSettings()) {
          setShowMcpSettings(false);
          requestComposerFocus();
          return;
        }
        if (showPermissionSettings()) {
          setShowPermissionSettings(false);
          requestComposerFocus();
          return;
        }
        if (showModels()) {
          setShowModels(false);
          requestComposerFocus();
          return;
        }
        if (showSessionPicker()) return;
        void openAllSessions();
      });
    };

    window.addEventListener('keydown', handleKeydown);
    cleanups.push(() => {
      disposeBridge();
      window.removeEventListener('keydown', handleKeydown);
    });

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  const openSubagentListParentSession = () => {
    const parentSessionId = subagentParentId();
    if (!parentSessionId) return;
    void openParentSession(parentSessionId);
  };

  const openRunningSessions = () => {
    void openSessionFilter('running');
  };

  const openPendingSessions = () => {
    void openSessionFilter('pending');
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

  createEffect(subagentSessionsRequest, (request) => {
    if (!request) return;
    clearSubagentSessionsRequest();
    // Editor tabs have no session list, so open the named subagent instead.
    if (!isEditorSurface) openSubagentSessions(request.rootSessionID);
    else if (request.childSessionID) void selectSession(request.childSessionID);
  });
  onCleanup(clearSubagentSessionsRequest);

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
    () =>
      [
        (() => state.activeSessionId)(),
        (() => activeSession()?.parentID || null)(),
        (() => getSessionTreeRootId(state.activeSessionId))(),
      ] as const,
    ([, parentSessionId, rootSessionId]) => {
      setSidebarSubagentParentId(parentSessionId ? rootSessionId || parentSessionId : null);
    }
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
        rawSessionIndicators={rawSessionIndicators()}
        shouldRenderWorkspace={shouldRenderWorkspace()}
        isDesktopSessionPaneRight={isDesktopSessionPaneRight()}
        showDesktopSessionPane={!isEditorSurface}
        showSessionHeader={!isEditorSurface}
        showSessionPicker={isEditorSurface ? false : showSessionPicker()}
        showModels={showModels()}
        showPermissionSettings={showPermissionSettings()}
        showMcpSettings={showMcpSettings()}
        showReconnectBanner={showReconnectBanner()}
        showProviderSetupBanner={showProviderSetupBanner()}
        onConnectProvider={openProviderSetup}
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
        shouldShowPendingBadge={shouldShowHeaderBadge('pending')}
        failedSessionsCount={failedSessionsCount()}
        attentionSessionsCount={attentionSessionsCount()}
        planReadySessionsCount={planReadySessionsCount()}
        completedSessionsCount={completedSessionsCount()}
        runningSessionsCount={runningSessionsCount()}
        pendingSessionsCount={pendingSessionCounts().running}
        activePending={sessionIndicators().pendingIds.has(state.activeSessionId ?? '')}
        sessionSidebarFailedCount={sessionSidebarFailedCount()}
        sessionSidebarAttentionCount={sessionSidebarAttentionCount()}
        sessionSidebarPlanReadyCount={sessionSidebarPlanReadyCount()}
        sessionSidebarCompletedCount={sessionSidebarCompletedCount()}
        sessionSidebarRunningCount={sessionSidebarRunningCount()}
        sessionSidebarPendingCount={pendingSessionCounts().sidebarRunning}
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
        onOpenPendingSessions={openPendingSessions}
        onSendFromPicker={() => setShowSessionPicker(false)}
        onCreateSession={startNewChatDraft}
      />
      <Show when={backgroundProcessView()} keyed>
        {(view) => (
          <BackgroundProcessDialog
            sessionID={view.sessionID}
            directory={view.directory}
            processID={view.processID}
            onClose={closeBackgroundProcessView}
          />
        )}
      </Show>
      <Show when={sideQuestionView()} keyed>
        {(view) => (
          <SideQuestionDialog
            sessionID={view.sessionID}
            directory={view.directory}
            question={view.question}
            context={view.context}
            onClose={closeSideQuestion}
          />
        )}
      </Show>
      <Show when={providerConnectionData()}>
        {(data) => (
          <ProviderConnectionDialog
            catalogProviders={data().providers}
            providerLoadError={data().error}
            isLoadingProviders={data().loading}
            initialProviderID={data().providerID}
            initialMethodID={data().methodID}
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
  isCompleted: (session: (typeof state.sessions)[number]) => boolean,
  isPending: (sessionId: string) => boolean = () => false
) {
  if (isSessionPickerOpen) return null;

  const matchingSessions = getPrimarySessionsForFilter(
    sessions,
    filter,
    isRunning,
    isNeedingAttention,
    isFailed,
    isPlanReady,
    isCompleted,
    isPending
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
