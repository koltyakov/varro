/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- REST payloads are untrusted and validated against endpoint contracts before use. */
/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Endpoint assertions follow route-specific runtime validation. */
import * as vscode from 'vscode';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, realpathSync } from 'fs';
import { posix, win32 } from 'path';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import {
  estimateContextBreakdownFromCharacters,
  estimateNestedContextBreakdown,
  type ContextCharacterCounts,
  type ContextBreakdownKey,
  type ContextMessageEntry,
} from '../shared/context-breakdown';
import type {
  Message,
  OpenCodePermissionConfig,
  OpenCodePermissionConfigSource,
  OpenCodeServerMemoryPermission,
  OpenCodeServerMemoryPermissions,
  Part,
  PermissionRule,
} from '../shared/opencode-types';
import { parseSessionPromptEndpoint } from '../shared/opencode-endpoints';
import {
  createSessionWorkspaceMetadata,
  getSessionWorkspaceScopeFromMetadata,
  isSessionHistoryScope,
  isSafePersistedSessionId,
  isSessionWorkspaceScope,
  VARRO_API_ENDPOINTS,
} from '../shared/protocol';
import type {
  AutoApproveJudgeReference,
  AutoApproveJudgeRequest,
  OpenCodeModelRouting,
  PermissionMode,
  ServerStatus,
  SessionDiffSummary,
  SessionHistoryScope,
  SessionTokenBreakdown,
  SessionTokenUsage,
  SessionWorkspaceScope,
  WebviewMessage,
  WorkspaceFilePick,
} from '../shared/protocol';
import {
  getRelativePathWithinWorkspace,
  isSameWorkspacePath,
  normalizeWorkspaceIdentity,
} from '../shared/workspace-path';
import type { AutoApproveJudge } from './auto-approve-judge';
import type { HiddenSessionManager } from './hidden-session-manager';
import { isAllowedApiRequest } from './util/webview-message';
import type { ContextProvider } from './context-provider';
import type { LocalSessionSummaryData } from './local-session-summary';
import { logger } from './logger';
import type { ProviderLimitService } from './provider-limit-service';
import type { PinnedSessionManager } from './pinned-session-manager';
import type { OpenCodeServer } from './server';
import { getOpenCodeConfigPaths } from './open-code-process';
import {
  OpenCodeResponseTooLargeError,
  type OpenCodeRequestOptions,
  type OpenCodeResponseMetadata,
} from './open-code-transport';
import type {
  PendingAttentionReconciliation,
  SessionBusyAttempt,
  SessionStateManager,
} from './session-state-manager';
import type { SessionTitleFallback } from './session-title-fallback';
import type { SessionDeleteTarget, SessionTrashManager } from './session-trash-manager';
import { asRecord, parseModelRoute } from './sidebar-provider-utils';
import {
  getOpenCodePlansDirectory,
  getPlanFileName,
  normalizePlanMarkdown,
} from './util/plan-file';
import { getRelativePath } from './util/path';
import { FULL_SESSION_LIST_LIMIT, FULL_SESSION_LIST_PATH } from './util/session-list';
import { WorkspaceSessionStatusCoordinator } from './workspace-session-status-coordinator';
import {
  isGeneratedDependencyPath,
  projectFileDiffs,
  projectPartFileLists,
  projectSummaryDiffs,
} from './util/summary-projection';

type ApiRequestPayload = Extract<WebviewMessage, { type: 'api/request' }>['payload'];
type ApiCancelPayload = Extract<WebviewMessage, { type: 'api/cancel' }>['payload'];
type ApiResponsePayload = { id: number; data?: unknown; error?: string };
const SESSION_SUMMARY_DESCENDANT_CONCURRENCY = 4;
const SESSION_VISIBILITY_LOOKUP_CONCURRENCY = 4;
const SESSION_SUMMARY_CACHE_TTL_MS = 2_000;
const SESSION_SUMMARY_CACHE_LIMIT = 200;
const CURRENT_PROJECT_CACHE_TTL_MS = 2_000;
const SESSION_EVENT_CATALOG_REFRESH_MS = 1_000;
const SESSION_MESSAGE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_MESSAGE_FALLBACK_MAX_BYTES = 256 * 1024 * 1024;
const PERMANENT_DELETION_TOMBSTONE_LIMIT = 256;
const INTERNAL_HELPER_CLEANUP_STATE_LIMIT = 256;
const INTERNAL_HELPER_CLEANUP_QUEUE_LIMIT = 256;
const INTERNAL_HELPER_CLEANUP_MAX_CONCURRENCY = 4;
const INTERNAL_HELPER_CLEANUP_RETRY_INITIAL_MS = 5_000;
const INTERNAL_HELPER_CLEANUP_RETRY_MAX_MS = 5 * 60_000;
const INTERNAL_HELPER_CLEANUP_SETTLED_TTL_MS = 30_000;
const INTERNAL_HELPER_CLEANUP_FAILURE_STATE_TTL_MS = 30 * 60_000;
const openCodeConfigUpdateLocks = new Map<string, Promise<void>>();

type RecycleBinRequest =
  | { kind: 'list' }
  | { kind: 'empty' }
  | { kind: 'restore'; rootID: string }
  | { kind: 'delete'; rootID: string };

type PermanentDeleteRequest = { sessionID: string };

type InternalHelperCleanupState = {
  failures: number;
  nextAttemptAt: number;
  expiresAt: number;
  settled: boolean;
};

type InternalHelperCleanupOutcome = 'settled' | 'deferred';

type InternalHelperCleanupJob = {
  sessionID: string;
  run(): Promise<InternalHelperCleanupOutcome>;
  retainSettled(): void;
};

export class InternalHelperCleanupCoordinator {
  private readonly activeRequests = new Set<string>();
  private readonly states = new Map<string, InternalHelperCleanupState>();
  private readonly pendingJobs = new Map<string, InternalHelperCleanupJob>();

  enqueue(
    sessionIDs: string[],
    run: (sessionID: string) => Promise<InternalHelperCleanupOutcome>,
    retainSettled: (sessionID: string) => void,
    now = Date.now()
  ) {
    this.pruneExpiredStates(now);
    for (const sessionID of sessionIDs) {
      const state = this.states.get(sessionID);
      if (state?.settled && state.nextAttemptAt > now) {
        retainSettled(sessionID);
        continue;
      }
      if (state && state.nextAttemptAt > now) {
        state.expiresAt = now + INTERNAL_HELPER_CLEANUP_FAILURE_STATE_TTL_MS;
        continue;
      }
      if (this.activeRequests.has(sessionID) || this.pendingJobs.has(sessionID)) continue;
      if (this.pendingJobs.size >= INTERNAL_HELPER_CLEANUP_QUEUE_LIMIT) break;
      this.pendingJobs.set(sessionID, {
        sessionID,
        run: () => run(sessionID),
        retainSettled: () => retainSettled(sessionID),
      });
    }
    this.drain();
  }

  private drain() {
    while (
      this.activeRequests.size < INTERNAL_HELPER_CLEANUP_MAX_CONCURRENCY &&
      this.pendingJobs.size > 0
    ) {
      const sessionID = this.pendingJobs.keys().next().value;
      if (!sessionID) break;
      const job = this.pendingJobs.get(sessionID);
      this.pendingJobs.delete(sessionID);
      if (!job) continue;

      const now = Date.now();
      this.pruneExpiredStates(now);
      const state = this.states.get(sessionID);
      if (state?.settled && state.nextAttemptAt > now) {
        job.retainSettled();
        continue;
      }
      if (state && state.nextAttemptAt > now) continue;
      if (!state && this.states.size >= INTERNAL_HELPER_CLEANUP_STATE_LIMIT) continue;

      const previousFailures = state?.failures ?? 0;
      this.remember(sessionID, {
        failures: previousFailures,
        nextAttemptAt: 0,
        expiresAt: now + INTERNAL_HELPER_CLEANUP_FAILURE_STATE_TTL_MS,
        settled: false,
      });
      this.activeRequests.add(sessionID);
      void job
        .run()
        .then((outcome) => {
          const completedAt = Date.now();
          if (outcome === 'settled') {
            this.remember(sessionID, {
              failures: 0,
              nextAttemptAt: completedAt + INTERNAL_HELPER_CLEANUP_SETTLED_TTL_MS,
              expiresAt: completedAt + INTERNAL_HELPER_CLEANUP_SETTLED_TTL_MS,
              settled: true,
            });
            return;
          }
          this.defer(sessionID, previousFailures, completedAt);
        })
        .catch((err: unknown) => {
          this.defer(sessionID, previousFailures, Date.now());
          logger.warn(
            `Unexpected stale internal helper cleanup failure for ${sessionID}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        })
        .finally(() => {
          this.activeRequests.delete(sessionID);
          this.drain();
        });
    }
  }

  private defer(sessionID: string, previousFailures: number, now: number) {
    const failures = Math.min(previousFailures + 1, 7);
    const delay = Math.min(
      INTERNAL_HELPER_CLEANUP_RETRY_INITIAL_MS * 2 ** (failures - 1),
      INTERNAL_HELPER_CLEANUP_RETRY_MAX_MS
    );
    this.remember(sessionID, {
      failures,
      nextAttemptAt: now + delay,
      expiresAt: now + INTERNAL_HELPER_CLEANUP_FAILURE_STATE_TTL_MS,
      settled: false,
    });
  }

  private pruneExpiredStates(now: number) {
    for (const [sessionID, state] of this.states) {
      if (state.expiresAt <= now && !this.activeRequests.has(sessionID)) {
        this.states.delete(sessionID);
      }
    }
  }

  private remember(sessionID: string, state: InternalHelperCleanupState) {
    this.states.delete(sessionID);
    this.states.set(sessionID, state);
  }
}

type OpenCodeConfigRequest =
  | { kind: 'get' }
  | {
      kind: 'update';
      target: 'small_model' | 'agent' | 'commit_message' | 'auto_approve';
      providerID: string;
      modelID: string;
      agentName?: string;
      unset: boolean;
    };

type OpenCodePermissionConfigRequest =
  | { kind: 'get' }
  | { kind: 'update'; rules: PermissionRule[] };

type SessionPermissionRulesRequest =
  | { kind: 'get'; sessionID: string }
  | { kind: 'update'; sessionID: string; rules: PermissionRule[] };

type ServerMemoryPermissionRequest =
  | { kind: 'list'; sessionID?: string }
  | { kind: 'remove'; sessionID?: string; id: string };

type OpenCodeConfigFile = {
  path: string;
  uri: vscode.Uri;
  raw: string;
  config: Record<string, unknown>;
};

type OpenCodeConfigSnapshot = {
  workspacePath: string;
  files: OpenCodeConfigFile[];
  config: Record<string, unknown>;
  target: OpenCodeConfigFile;
};

type SessionSummaryCacheEntry = {
  expiresAt: number;
  request: Promise<SessionDiffSummary>;
};

type WorkspaceSession = Record<string, unknown> & {
  id: string;
  directory: string;
};

type ResolvedSessionCatalogScope =
  | { kind: 'exact'; root: string }
  | { kind: 'descendants'; root: string }
  | { kind: 'project'; root: string; projectID: string };

type SessionCatalogProject = {
  id: string;
  worktree: string;
  vcs?: string;
};

type AuthorizedSessionDirectory = {
  directory: string;
  catalogRoot: string;
};

type SessionHistoryScopeRequest = {
  directory: string;
  scope?: SessionHistoryScope;
};

export { scopeOpenCodeRequest, getOpenCodeDirectoryHeaders } from './util/opencode-request';

export interface RestProxyCallbacks {
  server: Pick<OpenCodeServer, 'getWorkspaceCwd' | 'request'>;
  contextProvider: Pick<
    ContextProvider,
    'context' | 'getOpenWorkspaceRoot' | 'readFile' | 'resolvePath'
  >;
  providerLimitService: Pick<ProviderLimitService, 'get'>;
  sessionState: Pick<
    SessionStateManager,
    | 'handleServerEvent'
    | 'getSessionWorkspaceMatch'
    | 'isSessionInWorkspace'
    | 'workspaceScopeFor'
    | 'markSessionBusy'
    | 'beginPendingAttentionReconciliation'
    | 'finishPendingAttentionReconciliation'
    | 'deferPromptFailure'
    | 'reconcilePromptFailure'
    | 'reconcilePendingAttention'
    | 'removeSessions'
  >;
  sessionTrash: Pick<
    SessionTrashManager,
    | 'cleanupExpired'
    | 'deletePermanently'
    | 'empty'
    | 'filterVisibleSessionRequests'
    | 'filterVisibleSessions'
    | 'filterVisibleSessionStatuses'
    | 'isHidden'
    | 'list'
    | 'moveToTrash'
    | 'restore'
  >;
  pinnedSessions: Pick<PinnedSessionManager, 'setPinned'>;
  hiddenSessions: Pick<
    HiddenSessionManager,
    | 'filterVisibleSessionRequests'
    | 'filterVisibleSessionStatuses'
    | 'filterVisibleSessions'
    | 'isHidden'
    | 'observeSessionList'
    | 'retainUntilDeleted'
  >;
  autoApproveJudge: Pick<AutoApproveJudge, 'judge' | 'resolveModel'>;
  sessionTitleFallback: Pick<SessionTitleFallback, 'renameIfUntitled'>;
  readLocalSessionSummary?(sessionID: string): Promise<LocalSessionSummaryData | null>;
  simulateNoProviders: boolean;
  getRequestGeneration(): number;
  getStatus(): ServerStatus;
  getSessionHistoryScope?(root: string): SessionHistoryScope;
  getSessionHistoryScopeByKey?(key: string): SessionHistoryScope;
  associateSessionHistoryScope?(root: string, key: string): Promise<void>;
  updateSessionHistoryScope?(key: string, scope: SessionHistoryScope): Promise<void>;
  getWorkspacePath?(): string | null | undefined;
  resolvePendingAttentionRequest?(
    requestID: string
  ): { sessionID: string; directory?: string } | undefined;
  shouldAbortSessionBeforeRecycle?(sessionID: string): boolean;
  ensureServerStarted(): Promise<string | undefined>;
  workspaceSessionStatusCoordinator?: WorkspaceSessionStatusCoordinator;
  internalHelperCleanupCoordinator?: InternalHelperCleanupCoordinator;
  confirmPromptAdmission(workspacePath: string): Promise<boolean>;
  refreshOpenCodeConfig?(
    previousRouting: OpenCodeModelRouting,
    currentRouting: OpenCodeModelRouting,
    workspacePath: string
  ): Promise<void>;
  cleanupExpiredRecycleBin(): Promise<void>;
  removeSessionImages(sessionIds: Iterable<string>): Promise<void>;
  rememberServerMemoryPermissions(rules: readonly OpenCodeServerMemoryPermission[]): void;
  forgetServerMemoryPermission(rule: OpenCodeServerMemoryPermission): void;
  getServerMemoryPermissions(projectID: string): readonly OpenCodeServerMemoryPermission[];
  postApiResponse(requestGeneration: number, payload: ApiResponsePayload): void;
  isPermissionAutomationLeaseCurrent(
    lease: number,
    request: { sessionID?: string; permissionID?: string; workspaceDirectory?: string }
  ): boolean;
  beginQueuedMessageDispatchClaim(
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number,
    messageId: string
  ): Promise<boolean>;
  isQueuedMessageDispatchClaimCurrent(
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number
  ): boolean;
  completeQueuedMessageDispatchClaim(
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number
  ): Promise<boolean>;
  releaseQueuedMessageDispatchClaim(
    sessionId: string,
    itemId: string,
    lease: number,
    requestId: number
  ): void;
  updatePermissionMode(
    sessionID: string,
    mode: PermissionMode,
    directory?: string,
    preconfigured?: boolean,
    defaultPermission?: PermissionRule[]
  ): Promise<unknown>;
  allowPermissionForSession(
    sessionID: string,
    permission: string,
    patterns: string[],
    directory?: string
  ): Promise<void>;
  updatePermissionRulesForSession?(
    sessionID: string,
    rules: PermissionRule[],
    directory?: string
  ): Promise<PermissionRule[]>;
  activateSession(
    sessionID: string,
    directory: string,
    catalogRoot: string,
    signal?: AbortSignal
  ): Promise<unknown>;
}

export class RestProxy {
  private readonly requestWorkspaceDirectory = new AsyncLocalStorage<string | undefined>();
  private sessionDirectories = new Map<string, string>();
  private authorizedSessionDirectories = new Map<string, AuthorizedSessionDirectory>();
  private authorizedSessionCatalogs = new Map<
    string,
    { rootIdentity: string; sessions: Map<string, AuthorizedSessionDirectory> }
  >();
  private sessionWorkspaceScopes = new Map<string, SessionWorkspaceScope>();
  private currentProjects = new Map<
    string,
    { expiresAt: number; request: Promise<SessionCatalogProject> }
  >();
  private sessionEventCatalogRefreshes = new Map<
    string,
    { expiresAt: number; request: Promise<void> }
  >();
  private readonly workspaceSessionStatusCoordinator: WorkspaceSessionStatusCoordinator;
  private hasSessionDirectorySnapshot = false;
  private sessionDirectoryBootstrapPromise: Promise<ReadonlyMap<string, string>> | null = null;
  private readonly internalHelperCleanupCoordinator: InternalHelperCleanupCoordinator;
  private internalHelperCleanupCursor = 0;
  private readonly permanentlyDeletedSessionIds = new Set<string>();
  private sessionSummaryListRequests = new Map<
    string,
    { expiresAt: number; request: Promise<unknown> }
  >();
  private sessionSummaryRequests = new Map<string, SessionSummaryCacheEntry>();
  private activeSessionSummaryDescendantRequests = 0;
  private sessionSummaryDescendantWaiters: Array<() => void> = [];
  private readonly activeRequests = new Map<
    string,
    { id: number; generation: number; controller: AbortController }
  >();
  private readonly workspaceRequests = new Set<{
    directories: Set<string>;
    controller: AbortController;
  }>();
  private disposed = false;

  constructor(private readonly callbacks: RestProxyCallbacks) {
    this.workspaceSessionStatusCoordinator =
      callbacks.workspaceSessionStatusCoordinator ?? new WorkspaceSessionStatusCoordinator();
    this.internalHelperCleanupCoordinator =
      callbacks.internalHelperCleanupCoordinator ?? new InternalHelperCleanupCoordinator();
  }

  cancelRequest(payload: ApiCancelPayload) {
    const request = this.activeRequests.get(payload.cancelKey);
    if (!request || request.id !== payload.id) return;
    this.activeRequests.delete(payload.cancelKey);
    request.controller.abort(new Error('API call aborted'));
  }

  cancelRequestsBeforeGeneration(generation: number) {
    for (const [cancelKey, request] of this.activeRequests) {
      if (request.generation >= generation) continue;
      this.activeRequests.delete(cancelKey);
      request.controller.abort(new Error('Webview reloaded'));
    }
  }

  cancelAllRequests(reason = 'Workspace changed') {
    for (const request of this.workspaceRequests) {
      request.controller.abort(new Error(reason));
    }
    for (const request of this.activeRequests.values()) {
      if (!request.controller.signal.aborted) request.controller.abort(new Error(reason));
    }
    this.workspaceRequests.clear();
    this.activeRequests.clear();
  }

  invalidateSessionCatalog() {
    this.workspaceSessionStatusCoordinator.clearCatalogs();
    this.currentProjects.clear();
    this.sessionEventCatalogRefreshes.clear();
    this.authorizedSessionDirectories.clear();
    this.authorizedSessionCatalogs.clear();
    this.hasSessionDirectorySnapshot = false;
  }

  async loadPermissionModeRecoveryCatalog(): Promise<{
    complete: boolean;
    sessions: WorkspaceSession[];
  }> {
    const roots = this.getOpenWorkspaceRoots();
    if (roots.length === 0) return { complete: false, sessions: [] };
    const results = await Promise.allSettled(
      roots.map(async (root) => {
        const scope = await this.resolveSessionCatalogScope(root);
        return this.loadWorkspaceStatusSessionCatalog(root, undefined, true, scope);
      })
    );
    const catalogs = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    return {
      complete: catalogs.length === roots.length && catalogs.every((catalog) => catalog.complete),
      sessions: this.mergeWorkspaceSessions(catalogs.flatMap((catalog) => catalog.sessions)),
    };
  }

  isSessionCatalogEventAuthorized(sessionID: string, directory?: string): boolean {
    const authorized = this.authorizedSessionDirectories.get(sessionID);
    if (authorized) {
      return !directory || isSameWorkspacePath(authorized.directory, directory);
    }
    if (!directory) return false;
    for (const root of this.getOpenWorkspaceRoots()) {
      const mode = this.callbacks.getSessionHistoryScope?.(root) ?? 'directory';
      if (mode === 'directory' && isSameWorkspacePath(directory, root)) return true;
      if (mode !== 'descendants' || getRelativePathWithinWorkspace(directory, root) === null) {
        continue;
      }
      this.authorizedSessionDirectories.set(sessionID, { directory, catalogRoot: root });
      return true;
    }
    return false;
  }

  isSessionCatalogInventoryAuthorized(sessionID: string, directory?: string): boolean {
    const authorized = this.authorizedSessionDirectories.get(sessionID);
    return Boolean(
      authorized && (!directory || isSameWorkspacePath(authorized.directory, directory))
    );
  }

  async authorizeSessionDirectory(sessionID: string, directory: string): Promise<boolean> {
    if (!sessionID.trim() || !normalizeWorkspaceIdentity(directory)) return false;
    try {
      this.requireOpenWorkspaceRoot(directory);
      return true;
    } catch {
      // Nested directories and project worktrees require a fresh catalog match.
    }

    const scopes = await Promise.all(
      this.getOpenWorkspaceRoots().map((root) => this.resolveSessionCatalogScope(root))
    );
    const candidateScopes = scopes.filter(
      (scope): scope is Extract<ResolvedSessionCatalogScope, { kind: 'descendants' | 'project' }> =>
        scope.kind === 'project' ||
        (scope.kind === 'descendants' &&
          getRelativePathWithinWorkspace(directory, scope.root) !== null)
    );
    const catalogs = await Promise.all(
      candidateScopes.map((scope) =>
        this.loadWorkspaceStatusSessionCatalog(scope.root, undefined, true, scope)
      )
    );
    return catalogs.some((catalog) =>
      catalog.sessions.some(
        (session) => session.id === sessionID && isSameWorkspacePath(session.directory, directory)
      )
    );
  }

  async refreshSessionCatalogEventAuthorization(
    sessionIDs: readonly string[],
    directory?: string
  ): Promise<boolean> {
    const hasDirectoryDrift = Boolean(
      directory &&
      sessionIDs.some((sessionID) => {
        const authorized = this.authorizedSessionDirectories.get(sessionID);
        return authorized && !isSameWorkspacePath(authorized.directory, directory);
      })
    );
    if (
      sessionIDs.length > 0 &&
      sessionIDs.every((sessionID) => this.isSessionCatalogEventAuthorized(sessionID, directory))
    ) {
      return true;
    }
    const scopes = await Promise.all(
      this.getOpenWorkspaceRoots().map((root) => this.resolveSessionCatalogScope(root))
    );
    const matchingDescendantScope = directory
      ? scopes.find(
          (scope) =>
            scope.kind === 'descendants' &&
            getRelativePathWithinWorkspace(directory, scope.root) !== null
        )
      : undefined;
    if (!hasDirectoryDrift && matchingDescendantScope && directory && sessionIDs.length > 0) {
      for (const sessionID of sessionIDs) {
        this.authorizedSessionDirectories.set(sessionID, {
          directory,
          catalogRoot: matchingDescendantScope.root,
        });
      }
      return true;
    }
    const refreshScopes = scopes.filter(
      (scope): scope is Extract<ResolvedSessionCatalogScope, { kind: 'descendants' | 'project' }> =>
        scope.kind === 'project' || (scope.kind === 'descendants' && hasDirectoryDrift)
    );
    if (refreshScopes.length === 0) {
      return Boolean(
        directory &&
        scopes.some(
          (scope) =>
            scope.kind === 'descendants' &&
            getRelativePathWithinWorkspace(directory, scope.root) !== null
        )
      );
    }
    await Promise.all(
      refreshScopes.map((scope) => this.refreshSessionEventCatalog(scope, hasDirectoryDrift))
    );
    return (
      sessionIDs.length > 0 &&
      sessionIDs.every((sessionID) => this.isSessionCatalogEventAuthorized(sessionID, directory))
    );
  }

  cancelRequestsOutsideDirectories(
    directories: readonly string[],
    reason = 'Workspace folder was removed'
  ) {
    const openIdentities = new Set(
      directories
        .map((directory) => normalizeWorkspaceIdentity(directory))
        .filter((identity): identity is string => identity !== null)
    );
    for (const request of this.workspaceRequests) {
      const referencesClosedDirectory = [...request.directories].some((directory) => {
        const identity = normalizeWorkspaceIdentity(directory);
        return identity !== null && !openIdentities.has(identity);
      });
      if (!referencesClosedDirectory) continue;
      request.controller.abort(new Error(reason));
      this.workspaceRequests.delete(request);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelAllRequests('REST proxy disposed');
  }

  handleRequest(payload: ApiRequestPayload, defaultWorkspaceDirectory?: string) {
    return this.requestWorkspaceDirectory.run(defaultWorkspaceDirectory, () =>
      this.handleRequestInScope(payload)
    );
  }

  private async handleRequestInScope(payload: ApiRequestPayload) {
    const requestGeneration = this.callbacks.getRequestGeneration();
    const method = payload.method.toUpperCase();
    let queuedDispatchSessionID: string | undefined;
    let queuedDispatch: ApiRequestPayload['queuedMessageDispatch'];
    let queuedDispatchActive = false;
    let workspaceRequest: { directories: Set<string>; controller: AbortController } | undefined;
    if (this.disposed) {
      this.callbacks.postApiResponse(requestGeneration, {
        id: payload.id,
        error: 'REST proxy disposed',
      });
      return;
    }
    const request = payload.cancelKey
      ? { id: payload.id, generation: requestGeneration, controller: new AbortController() }
      : undefined;
    try {
      if (!isAllowedApiRequest(method, payload.path)) {
        throw new Error('Unsupported API request');
      }
      const promptSessionID = this.parsePromptSessionID(method, payload.path);
      if (payload.interruptedRecovery && !promptSessionID) {
        throw new Error('Interrupted recovery marker is only valid for session prompts');
      }
      const sessionCreationScope = this.parseSessionCreationScope(
        method,
        payload.path,
        payload.body
      );
      const queuedHistorySessionID = this.parseQueuedHistorySessionID(method, payload);
      queuedDispatchSessionID = promptSessionID ?? queuedHistorySessionID;
      queuedDispatch = queuedDispatchSessionID ? payload.queuedMessageDispatch : undefined;
      const queuedMessageId = queuedDispatch ? asRecord(payload.body)?.messageID : undefined;
      if (
        queuedDispatch &&
        (!isSafePersistedSessionId(queuedMessageId) ||
          !(await this.callbacks.beginQueuedMessageDispatchClaim(
            queuedDispatchSessionID!,
            queuedDispatch.itemId,
            queuedDispatch.lease,
            payload.id,
            queuedMessageId
          )))
      ) {
        throw new Error('Queued message dispatch lease is no longer current');
      }
      queuedDispatchActive = queuedDispatch !== undefined;
      if (payload.cancelKey && request) {
        const existing = this.activeRequests.get(payload.cancelKey);
        if (existing) throw new Error('Duplicate API request cancellation key');
        this.activeRequests.set(payload.cancelKey, request);
      }
      this.assertPermissionAutomationLeaseCurrent(method, payload);

      const attentionReplyRequestID = parseAttentionReplyRequestID(method, payload.path);
      const attentionReplyDirectory = attentionReplyRequestID
        ? this.resolvePendingAttentionReplyDirectory(attentionReplyRequestID)
        : null;

      const queuedHistoryWorkspaceDirectory = queuedHistorySessionID
        ? asRecord(payload.body)?.workspaceDirectory
        : undefined;
      const requestedWorkspaceDirectory =
        getExplicitWorkspaceDirectory(payload.path) ??
        (typeof queuedHistoryWorkspaceDirectory === 'string'
          ? queuedHistoryWorkspaceDirectory.trim() || null
          : null);
      const directSessionID = parseDirectSessionID(payload.path);
      let explicitWorkspaceDirectory: string | null = null;
      if (requestedWorkspaceDirectory) {
        if (directSessionID) {
          explicitWorkspaceDirectory = this.requireAuthorizedSessionDirectory(
            directSessionID,
            requestedWorkspaceDirectory
          );
        } else if (attentionReplyDirectory) {
          if (!isSameWorkspacePath(requestedWorkspaceDirectory, attentionReplyDirectory)) {
            throw new Error('404 Attention request not found');
          }
          explicitWorkspaceDirectory = attentionReplyDirectory;
        } else {
          explicitWorkspaceDirectory = this.requireOpenWorkspaceRoot(requestedWorkspaceDirectory);
        }
      }
      const scopedWorkspaceDirectory = explicitWorkspaceDirectory ?? attentionReplyDirectory;
      const activationRequest = this.parseSessionActivationRequest(
        method,
        payload.path,
        payload.body
      );
      const sessionHistoryScopeRequest = this.parseSessionHistoryScopeRequest(
        method,
        payload.path,
        payload.body
      );
      const requestPathname = new URL(payload.path, 'http://localhost').pathname;
      const endpointWorkspaceDirectory =
        this.callbacks.getWorkspacePath?.() ??
        this.callbacks.contextProvider.context.workspacePath ??
        this.callbacks.server.getWorkspaceCwd();
      const allowsCrossRootDirectory =
        Boolean(activationRequest || directSessionID || attentionReplyDirectory) ||
        requestPathname === '/session' ||
        requestPathname === VARRO_API_ENDPOINTS.sessionHistoryScope ||
        (method === 'GET' && requestPathname === '/session/status');
      if (
        scopedWorkspaceDirectory &&
        endpointWorkspaceDirectory &&
        !isSameWorkspacePath(scopedWorkspaceDirectory, endpointWorkspaceDirectory) &&
        !allowsCrossRootDirectory
      ) {
        throw new Error('Activate the session workspace before accessing directory-scoped data');
      }
      const requestDirectories =
        !scopedWorkspaceDirectory &&
        method === 'GET' &&
        (requestPathname === '/session' ||
          requestPathname === '/session/status' ||
          requestPathname === '/permission' ||
          requestPathname === '/question')
          ? this.getOpenWorkspaceRoots()
          : [
              scopedWorkspaceDirectory ??
                this.getCurrentWorkspaceResolutionRoot() ??
                endpointWorkspaceDirectory,
            ].filter((directory): directory is string => Boolean(directory));
      if (requestDirectories.length > 0) {
        workspaceRequest = {
          directories: new Set(requestDirectories),
          controller: request?.controller ?? new AbortController(),
        };
        this.workspaceRequests.add(workspaceRequest);
      }
      const requestSignal = request?.controller.signal ?? workspaceRequest?.controller.signal;
      if (scopedWorkspaceDirectory) {
        this.requestWorkspaceDirectory.enterWith(scopedWorkspaceDirectory);
      }
      const promptWorkspaceDirectory = promptSessionID
        ? (explicitWorkspaceDirectory ??
          this.getCurrentWorkspaceResolutionRoot() ??
          this.getCurrentWorkspacePath())
        : undefined;
      let forwardedPath = explicitWorkspaceDirectory
        ? setExplicitWorkspaceDirectory(payload.path, explicitWorkspaceDirectory)
        : payload.path;
      let forwardedBody = payload.body;

      if (directSessionID && !activationRequest) {
        const currentWorkspaceDirectory = this.getCurrentWorkspaceResolutionRoot();
        const sessionWorkspaceDirectory = explicitWorkspaceDirectory ?? currentWorkspaceDirectory;
        await this.assertSessionInWorkspace(
          directSessionID,
          sessionWorkspaceDirectory ?? this.getCurrentWorkspacePath(),
          sessionWorkspaceDirectory ?? explicitWorkspaceDirectory ?? undefined
        );
      }

      const recycleBinRequest = this.parseRecycleBinRequest(method, payload.path);
      if (recycleBinRequest) {
        const data = await this.handleRecycleBinRequest(recycleBinRequest);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const permanentDeleteRequest = this.parsePermanentDeleteRequest(method, payload.path);
      if (permanentDeleteRequest) {
        const data = await this.deleteSessionPermanently(
          permanentDeleteRequest.sessionID,
          explicitWorkspaceDirectory ?? undefined
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const pinRequest = this.parsePinRequest(method, payload.path, payload.body);
      if (pinRequest) {
        await this.assertSessionInWorkspace(
          pinRequest.sessionID,
          explicitWorkspaceDirectory ?? this.getCurrentWorkspacePath(),
          explicitWorkspaceDirectory ?? undefined
        );
        const data = await this.callbacks.pinnedSessions.setPinned(
          pinRequest.sessionID,
          pinRequest.pinned
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const planOpenRequest = this.parsePlanOpenRequest(method, payload.path, payload.body);
      if (planOpenRequest) {
        const data = await this.openPlanDocument(planOpenRequest.content);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const openCodeConfigRequest = this.parseOpenCodeConfigRequest(
        method,
        payload.path,
        payload.body
      );
      if (openCodeConfigRequest) {
        const data =
          openCodeConfigRequest.kind === 'get'
            ? await this.readOpenCodeModelRouting()
            : await this.updateModelRouting(openCodeConfigRequest);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const permissionConfigRequest = this.parseOpenCodePermissionConfigRequest(
        method,
        payload.path,
        payload.body
      );
      if (permissionConfigRequest) {
        const data =
          permissionConfigRequest.kind === 'get'
            ? await this.readOpenCodePermissionConfig()
            : await this.updateOpenCodePermissionConfig(permissionConfigRequest.rules);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const sessionPermissionRulesRequest = this.parseSessionPermissionRulesRequest(
        method,
        payload.path,
        payload.body
      );
      if (sessionPermissionRulesRequest) {
        const directory = explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot();
        await this.assertSessionInWorkspace(
          sessionPermissionRulesRequest.sessionID,
          directory,
          directory
        );
        if (sessionPermissionRulesRequest.kind === 'get') {
          const session = asRecord(
            await this.requestServer(
              'GET',
              `/session/${encodeURIComponent(sessionPermissionRulesRequest.sessionID)}`,
              undefined,
              { directory: directory ?? undefined }
            )
          );
          const data = this.normalizeSessionPermissionRules(session?.permission);
          this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
          return;
        }
        if (!this.callbacks.updatePermissionRulesForSession) {
          throw new Error('Session permission editing is unavailable');
        }
        const data = await this.callbacks.updatePermissionRulesForSession(
          sessionPermissionRulesRequest.sessionID,
          sessionPermissionRulesRequest.rules,
          directory ?? undefined
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const serverMemoryRequest = this.parseServerMemoryPermissionRequest(
        method,
        payload.path,
        payload.body
      );
      if (serverMemoryRequest) {
        const directory = explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot();
        if (serverMemoryRequest.sessionID) {
          await this.assertSessionInWorkspace(serverMemoryRequest.sessionID, directory, directory);
        }
        const data = await this.readServerMemoryPermissions(
          serverMemoryRequest.sessionID,
          directory ?? undefined,
          serverMemoryRequest.kind === 'remove' ? serverMemoryRequest.id : undefined
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      // These paths arrive from the webview, so they stay confined to the
      // workspace - the extension host must not be a read primitive for
      // arbitrary local files.
      const workspaceFileRequest = this.parseWorkspaceFileRequest(method, payload.path);
      if (workspaceFileRequest) {
        const data = await this.callbacks.contextProvider.readFile(workspaceFileRequest.path, {
          restrictToWorkspace: true,
          workspaceDirectory: this.getCurrentWorkspaceResolutionRoot(),
        });
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const workspaceResolveRequest = this.parseWorkspaceResolveRequest(method, payload.path);
      if (workspaceResolveRequest) {
        const data = await this.callbacks.contextProvider.resolvePath(
          workspaceResolveRequest.path,
          {
            restrictToWorkspace: true,
            workspaceDirectory: this.getCurrentWorkspaceResolutionRoot(),
            allowSiblingWorkspaceFolders: true,
          }
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (this.isWorkspaceFilePickRequest(method, payload.path)) {
        const data = await this.pickWorkspaceFile();
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (this.callbacks.getStatus().state !== 'running') {
        await this.callbacks.ensureServerStarted();
      }
      await this.callbacks.cleanupExpiredRecycleBin();

      if (sessionHistoryScopeRequest) {
        const data = await this.handleSessionHistoryScopeRequest(
          sessionHistoryScopeRequest,
          requestSignal
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (activationRequest) {
        const authorization = this.requireAuthorizedSessionActivation(
          activationRequest.sessionID,
          activationRequest.directory
        );
        const value = await this.callbacks.activateSession(
          activationRequest.sessionID,
          authorization.directory,
          authorization.catalogRoot,
          requestSignal
        );
        const session = asRecord(value);
        const data = session
          ? this.withSessionWorkspaceScope(
              session,
              this.readAndRememberSessionWorkspaceScope(session)
            )
          : value;
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (this.isSessionListRequest(method, payload.path)) {
        const data = await this.requestWorkspaceSessions(payload.path, requestSignal);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (
        method === 'GET' &&
        new URL(payload.path, 'http://localhost').pathname === '/session/status'
      ) {
        const data = await this.requestWorkspaceSessionStatuses(requestSignal);
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const diffSummaryRequest = this.parseSessionDiffSummaryRequest(method, payload.path);
      if (diffSummaryRequest) {
        if (this.isHiddenSession(diffSummaryRequest.sessionID)) {
          throw new Error('404 Session not found');
        }
        const directory = explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot();
        await this.assertSessionInWorkspace(diffSummaryRequest.sessionID, directory, directory);
        const data = await this.requestWorkspaceDirectory.run(directory, () =>
          this.readCachedSessionDiffSummary(
            diffSummaryRequest.sessionID,
            diffSummaryRequest.cacheKey && directory
              ? `${normalizeWorkspaceIdentity(directory)}:${diffSummaryRequest.cacheKey}`
              : diffSummaryRequest.cacheKey
          )
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const permissionModeRequest = this.parsePermissionModeRequest(
        method,
        payload.path,
        payload.body
      );
      if (permissionModeRequest) {
        const directory = explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot();
        await this.assertSessionInWorkspace(permissionModeRequest.sessionID, directory, directory);
        const data = permissionModeRequest.preconfigured
          ? await this.callbacks.updatePermissionMode(
              permissionModeRequest.sessionID,
              permissionModeRequest.mode,
              directory ?? undefined,
              true
            )
          : permissionModeRequest.defaultPermission
            ? await this.callbacks.updatePermissionMode(
                permissionModeRequest.sessionID,
                permissionModeRequest.mode,
                directory ?? undefined,
                false,
                permissionModeRequest.defaultPermission
              )
            : await this.callbacks.updatePermissionMode(
                permissionModeRequest.sessionID,
                permissionModeRequest.mode,
                directory ?? undefined
              );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const sessionPermissionAllowRequest = this.parsePermissionAllowRequest(
        VARRO_API_ENDPOINTS.permissionSessionAllow,
        method,
        payload.path,
        payload.body
      );
      if (sessionPermissionAllowRequest) {
        const directory = explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot();
        await this.assertSessionInWorkspace(
          sessionPermissionAllowRequest.sessionId,
          directory,
          directory
        );
        const scope = await this.getPendingPermissionAllowScope(
          sessionPermissionAllowRequest,
          directory ?? undefined,
          requestSignal
        );
        const data = await this.callbacks.allowPermissionForSession(
          sessionPermissionAllowRequest.sessionId,
          scope.permission,
          scope.patterns,
          directory ?? undefined
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const projectPermissionAllowRequest = this.parsePermissionAllowRequest(
        VARRO_API_ENDPOINTS.permissionProjectAllow,
        method,
        payload.path,
        payload.body
      );
      if (projectPermissionAllowRequest) {
        const directory = explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot();
        await this.assertSessionInWorkspace(
          projectPermissionAllowRequest.sessionId,
          directory,
          directory
        );
        const data = await this.persistProjectPermissionAllow(
          projectPermissionAllowRequest,
          directory ?? undefined,
          requestSignal
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const judgePermissionRequest = this.parseJudgePermissionRequest(
        method,
        payload.path,
        payload.body
      );
      if (judgePermissionRequest) {
        const permission = asRecord(judgePermissionRequest.permission);
        const sessionID = typeof permission?.sessionID === 'string' ? permission.sessionID : '';
        const workspacePath = sessionID
          ? await this.resolveJudgeWorkspacePath(sessionID)
          : undefined;
        this.assertPermissionAutomationLeaseCurrent(method, payload);
        const data = await this.callbacks.autoApproveJudge.judge(
          judgePermissionRequest,
          workspacePath
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const judgeModelRequest = this.parseJudgeModelRequest(method, payload.path);
      if (judgeModelRequest) {
        const data = await this.callbacks.autoApproveJudge.resolveModel(
          judgeModelRequest.model,
          explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot()
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const renameSessionID = this.parseRenameIfUntitledRequest(method, payload.path);
      if (renameSessionID) {
        const data = await this.callbacks.sessionTitleFallback.renameIfUntitled(
          renameSessionID,
          explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot()
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      const providerLimitRequest = this.parseProviderLimitRequest(method, payload.path);
      if (providerLimitRequest) {
        const data = await this.callbacks.providerLimitService.get(
          providerLimitRequest.providerID,
          providerLimitRequest.modelID
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      if (
        this.callbacks.simulateNoProviders &&
        method === 'GET' &&
        payload.path === '/config/providers'
      ) {
        this.callbacks.postApiResponse(requestGeneration, {
          id: payload.id,
          data: { providers: [], default: {} },
        });
        return;
      }

      const hiddenSessionID = this.getHiddenSessionIdFromPath(payload.path);
      if (hiddenSessionID) {
        throw new Error('404 Session not found');
      }

      const softDeleteSessionID = this.parseSoftDeleteSessionRequest(method, payload.path);
      if (softDeleteSessionID) {
        const directory = explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot();
        const data = await this.requestWorkspaceDirectory.run(directory, () =>
          this.moveSessionToRecycleBin(softDeleteSessionID)
        );
        this.callbacks.postApiResponse(requestGeneration, { id: payload.id, data });
        return;
      }

      // Optimistically mark the session busy before the prompt is admitted.
      // opencode emits the SSE `session.status { busy }` event only after
      // admission, and on fast turns the finish can land first; pre-marking
      // here ensures the busy marker exists before any finish event arrives.
      if (promptSessionID) {
        if (
          promptWorkspaceDirectory &&
          normalizeWorkspaceIdentity(promptWorkspaceDirectory) &&
          !(await this.confirmPromptAdmission(promptWorkspaceDirectory, requestSignal))
        ) {
          throw new Error('Prompt cancelled because generated dependencies are not ignored by Git');
        }
        if (
          queuedDispatch &&
          !this.callbacks.isQueuedMessageDispatchClaimCurrent(
            promptSessionID,
            queuedDispatch.itemId,
            queuedDispatch.lease,
            payload.id
          )
        ) {
          throw new Error('Queued message dispatch lease is no longer current');
        }
        if (
          payload.interruptedRecovery &&
          !(await this.shouldAdmitInterruptedRecovery(
            promptSessionID,
            promptWorkspaceDirectory,
            requestSignal
          ))
        ) {
          this.callbacks.postApiResponse(requestGeneration, {
            id: payload.id,
            data: { skipped: true },
          });
          return;
        }
      }
      if (promptSessionID && promptWorkspaceDirectory) {
        forwardedBody = this.withWorkspaceScopeSystemPrompt(
          forwardedBody,
          this.getSessionWorkspaceScope(promptSessionID),
          promptWorkspaceDirectory
        );
      }
      const promptAttempt = promptSessionID
        ? this.callbacks.sessionState.markSessionBusy(promptSessionID)
        : undefined;
      const pendingAttentionKind =
        method === 'GET' && requestPathname === '/permission'
          ? ('permission' as const)
          : method === 'GET' && requestPathname === '/question'
            ? ('question' as const)
            : undefined;
      const workspaceDirectory =
        this.callbacks.contextProvider.context.workspaceDirectory ?? undefined;
      const pendingAttentionReconciliation = pendingAttentionKind
        ? this.callbacks.sessionState.beginPendingAttentionReconciliation(
            pendingAttentionKind,
            this.getCurrentWorkspacePath(),
            workspaceDirectory,
            Boolean(
              workspaceDirectory &&
              this.callbacks.contextProvider.context.workspaceFolders?.some((folder) =>
                isSameWorkspacePath(folder.path, workspaceDirectory)
              )
            )
          )
        : undefined;

      const sessionPageLimit = this.parseSessionPageLimit(method, payload.path);
      const constrainedSessionList = this.isConstrainedSessionListRequest(method, payload.path);
      if (sessionPageLimit !== null) {
        if (!constrainedSessionList) this.hasSessionDirectorySnapshot = false;
        const url = new URL(forwardedPath, 'http://localhost');
        url.searchParams.set('limit', String(sessionPageLimit + 1));
        forwardedPath = `${url.pathname}${url.search}`;
      }
      const paginatedMessages = this.isPaginatedMessagesRequest(method, payload.path);
      const defaultModelRequest = method === 'GET' && payload.path === '/model/default';
      const legacyServerMemoryRules = await this.prepareLegacyServerMemoryRules(
        method,
        payload.path,
        payload.body,
        explicitWorkspaceDirectory ?? this.getCurrentWorkspaceResolutionRoot()
      );
      let responsePromise: Promise<unknown>;
      try {
        if (defaultModelRequest) {
          responsePromise = this.requestDefaultModel(
            this.getCurrentWorkspaceResolutionRoot() ?? this.getCurrentWorkspacePath(),
            requestSignal
          );
        } else if (paginatedMessages) {
          if (
            queuedDispatch &&
            !this.callbacks.isQueuedMessageDispatchClaimCurrent(
              queuedDispatchSessionID!,
              queuedDispatch.itemId,
              queuedDispatch.lease,
              payload.id
            )
          ) {
            throw new Error('Queued message dispatch lease is no longer current');
          }
          responsePromise = this.requestPaginatedMessages(
            method,
            forwardedPath,
            queuedHistorySessionID ? undefined : payload.body,
            requestSignal,
            queuedDispatch ? (explicitWorkspaceDirectory ?? undefined) : undefined
          );
        } else if (pendingAttentionKind && !scopedWorkspaceDirectory) {
          responsePromise = this.requestWorkspacePendingAttention(
            pendingAttentionKind === 'permission' ? '/permission' : '/question',
            requestSignal
          );
        } else {
          this.assertPermissionAutomationLeaseCurrent(method, payload);
          requestSignal?.throwIfAborted();
          if (
            queuedDispatch &&
            !this.callbacks.isQueuedMessageDispatchClaimCurrent(
              queuedDispatchSessionID!,
              queuedDispatch.itemId,
              queuedDispatch.lease,
              payload.id
            )
          ) {
            throw new Error('Queued message dispatch lease is no longer current');
          }
          const queuedWorkspaceDirectory = queuedDispatch
            ? (explicitWorkspaceDirectory ?? undefined)
            : undefined;
          responsePromise = requestSignal
            ? queuedWorkspaceDirectory
              ? this.requestServer(method, forwardedPath, forwardedBody, {
                  signal: requestSignal,
                  directory: queuedWorkspaceDirectory,
                })
              : this.requestServer(method, forwardedPath, forwardedBody, {
                  signal: requestSignal,
                })
            : queuedWorkspaceDirectory
              ? this.requestServer(method, forwardedPath, forwardedBody, {
                  directory: queuedWorkspaceDirectory,
                })
              : this.requestServer(method, forwardedPath, forwardedBody);
        }
        if (this.isSessionListRequest(method, payload.path) && sessionPageLimit === null) {
          this.trackSessionDirectoryBootstrap(responsePromise, false);
        }
      } catch (err) {
        if (pendingAttentionReconciliation) {
          this.callbacks.sessionState.finishPendingAttentionReconciliation(
            pendingAttentionReconciliation
          );
        }
        if (promptAttempt) {
          await this.reconcileFailedPrompt(promptAttempt, err, promptWorkspaceDirectory);
        }
        throw err;
      }
      let response: unknown;
      try {
        response = await responsePromise;
      } catch (err) {
        if (pendingAttentionReconciliation) {
          this.callbacks.sessionState.finishPendingAttentionReconciliation(
            pendingAttentionReconciliation
          );
        }
        if (promptAttempt) {
          await this.reconcileFailedPrompt(promptAttempt, err, promptWorkspaceDirectory);
        }
        throw err;
      }
      this.callbacks.rememberServerMemoryPermissions(legacyServerMemoryRules);
      if (queuedDispatch && promptSessionID) {
        try {
          const completed = await this.callbacks.completeQueuedMessageDispatchClaim(
            promptSessionID!,
            queuedDispatch.itemId,
            queuedDispatch.lease,
            payload.id
          );
          if (!completed) {
            logger.warn('Queued message dispatch claim changed after successful admission');
          }
        } catch (err) {
          logger.warn(
            `Accepted queued message could not be durably removed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        queuedDispatchActive = false;
      }
      if (sessionCreationScope) {
        const session = asRecord(response);
        if (!isSafePersistedSessionId(session?.id)) {
          throw new Error('Malformed session creation response');
        }
        response = this.withSessionWorkspaceScope(session, sessionCreationScope);
      }
      const forkParentSessionID = this.parseForkParentSessionID(method, payload.path);
      if (forkParentSessionID) {
        const session = asRecord(response);
        if (isSafePersistedSessionId(session?.id)) {
          const inheritedScope = this.getSessionWorkspaceScope(forkParentSessionID);
          response = await this.persistForkWorkspaceScope(session, inheritedScope);
        }
      }
      let data: unknown;
      try {
        data = paginatedMessages
          ? await this.formatPaginatedMessagesResponse(
              method,
              payload.path,
              response as OpenCodeResponseMetadata
            )
          : sessionPageLimit !== null
            ? this.formatPaginatedSessionsResponse(
                response,
                sessionPageLimit,
                constrainedSessionList
              )
            : await this.filterApiResponse(
                method,
                payload.path,
                response,
                pendingAttentionReconciliation
              );
      } finally {
        if (pendingAttentionReconciliation) {
          this.callbacks.sessionState.finishPendingAttentionReconciliation(
            pendingAttentionReconciliation
          );
        }
      }
      this.callbacks.postApiResponse(requestGeneration, {
        id: payload.id,
        data,
      });
    } catch (err) {
      this.callbacks.postApiResponse(requestGeneration, {
        id: payload.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      if (queuedDispatch && queuedDispatchActive) {
        this.callbacks.releaseQueuedMessageDispatchClaim(
          queuedDispatchSessionID!,
          queuedDispatch.itemId,
          queuedDispatch.lease,
          payload.id
        );
      }
      if (payload.cancelKey && this.activeRequests.get(payload.cancelKey) === request) {
        this.activeRequests.delete(payload.cancelKey);
      }
      if (workspaceRequest) this.workspaceRequests.delete(workspaceRequest);
    }
  }

  private requestServer(
    ...args: Parameters<OpenCodeServer['request']>
  ): ReturnType<OpenCodeServer['request']> {
    const [method, path, body, options] = args;
    const directory = options?.directory ?? this.requestWorkspaceDirectory.getStore();
    if (!directory) return this.callbacks.server.request(...args);
    return this.callbacks.server.request(method, path, body, { ...options, directory });
  }

  private assertPermissionAutomationLeaseCurrent(method: string, payload: ApiRequestPayload) {
    const lease = payload.permissionAutomationLease;
    const pathname = new URL(payload.path, 'http://localhost').pathname;
    if (!isPermissionAutomationRequest(method, payload.path)) return;
    if (lease === undefined) {
      if (pathname === VARRO_API_ENDPOINTS.permissionJudge) {
        throw new Error('Permission automation lease is required');
      }
      return;
    }
    const permission = asRecord(asRecord(payload.body)?.permission);
    const replyMatch = pathname.match(/^\/permission\/([^/]+)\/reply$/);
    const request: {
      sessionID?: string;
      permissionID?: string;
      workspaceDirectory?: string;
    } = {};
    if (typeof permission?.sessionID === 'string') request.sessionID = permission.sessionID;
    if (replyMatch && payload.permissionAutomationSessionID) {
      request.sessionID = payload.permissionAutomationSessionID;
    }
    if (replyMatch?.[1]) request.permissionID = decodeURIComponent(replyMatch[1]);
    if (request.sessionID) {
      request.workspaceDirectory = this.authorizedSessionDirectories.get(
        request.sessionID
      )?.catalogRoot;
    }
    if (!this.callbacks.isPermissionAutomationLeaseCurrent(lease, request)) {
      throw new Error('Permission automation ownership changed');
    }
  }

  private confirmPromptAdmission(workspacePath: string, signal?: AbortSignal): Promise<boolean> {
    const admission = this.callbacks.confirmPromptAdmission(workspacePath);
    if (!signal) return admission;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      void admission.then(
        (confirmed) => {
          signal.removeEventListener('abort', abort);
          resolve(confirmed);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', abort);
          reject(err);
        }
      );
    });
  }

  private async shouldAdmitInterruptedRecovery(
    sessionID: string,
    directory: string | undefined,
    signal?: AbortSignal
  ): Promise<boolean> {
    const options = { directory, signal };
    const [rawStatuses, rawPermissions, rawQuestions] = await Promise.all([
      this.requestServer('GET', '/session/status', undefined, options),
      this.requestServer('GET', '/permission', undefined, options),
      this.requestServer('GET', '/question', undefined, options),
    ]);
    const statuses = asRecord(rawStatuses);
    if (!statuses || !Array.isArray(rawPermissions) || !Array.isArray(rawQuestions)) {
      throw new Error('Cannot safely resume interrupted session: malformed server state');
    }

    const rawStatus = statuses[sessionID];
    if (rawStatus !== undefined) {
      const statusValue = asRecord(rawStatus)?.type;
      const statusType = typeof statusValue === 'string' ? statusValue : undefined;
      if (statusType !== 'idle' && statusType !== 'busy' && statusType !== 'retry') {
        throw new Error('Cannot safely resume interrupted session: malformed session status');
      }
      if (statusType === 'busy' || statusType === 'retry') return false;
    }

    for (const pending of [...rawPermissions, ...rawQuestions]) {
      const pendingValue = asRecord(pending)?.sessionID;
      const pendingSessionID = typeof pendingValue === 'string' ? pendingValue : undefined;
      if (!pendingSessionID) {
        throw new Error('Cannot safely resume interrupted session: malformed pending request');
      }
      if (pendingSessionID === sessionID) return false;
    }
    return true;
  }

  private async requestDefaultModel(
    workspaceDirectory: string | undefined,
    signal?: AbortSignal
  ): Promise<unknown> {
    let response: unknown;
    try {
      response = signal
        ? await this.requestServer('GET', '/model/default', undefined, { signal })
        : await this.requestServer('GET', '/model/default');
    } catch (err) {
      if (signal?.aborted) throw err;
      logger.warn(
        `Default model request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (response === null) return null;
    const endpointModel = asRecord(response);
    const endpointModelID = endpointModel?.modelID ?? endpointModel?.id;
    if (typeof endpointModel?.providerID === 'string' && typeof endpointModelID === 'string') {
      return { providerID: endpointModel.providerID, modelID: endpointModelID };
    }

    try {
      const configPath = workspaceDirectory
        ? `/config?directory=${encodeURIComponent(workspaceDirectory)}`
        : '/config';
      const config = asRecord(
        signal
          ? await this.requestServer('GET', configPath, undefined, { signal })
          : await this.requestServer('GET', configPath)
      );
      return parseModelRoute(config?.model) ?? undefined;
    } catch (err) {
      if (signal?.aborted) throw err;
      logger.warn(
        `Default model config fallback failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  }

  private parseRecycleBinRequest(method: string, path: string): RecycleBinRequest | null {
    const url = new URL(path, 'http://localhost');
    if (url.pathname === VARRO_API_ENDPOINTS.sessionTrash) {
      if (method === 'GET') return { kind: 'list' };
      if (method === 'DELETE') return { kind: 'empty' };
      return null;
    }

    const restoreMatch = url.pathname.match(/^\/varro\/session-trash\/([^/]+)\/restore$/);
    if (restoreMatch && method === 'POST') {
      return { kind: 'restore', rootID: decodeURIComponent(restoreMatch[1]!) };
    }

    const deleteMatch = url.pathname.match(/^\/varro\/session-trash\/([^/]+)\/delete$/);
    if (deleteMatch && method === 'DELETE') {
      return { kind: 'delete', rootID: decodeURIComponent(deleteMatch[1]!) };
    }

    return null;
  }

  private parseSoftDeleteSessionRequest(method: string, path: string) {
    if (method !== 'DELETE') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]!) : null;
  }

  private parsePromptSessionID(method: string, path: string): string | undefined {
    if (method.toUpperCase() !== 'POST') return undefined;
    return parseSessionPromptEndpoint(path) ?? undefined;
  }

  private parseQueuedHistorySessionID(
    method: string,
    payload: ApiRequestPayload
  ): string | undefined {
    if (method !== 'GET' || !payload.queuedMessageDispatch) return undefined;
    const messageID = asRecord(payload.body)?.messageID;
    if (!isSafePersistedSessionId(messageID)) return undefined;
    const pathname = new URL(payload.path, 'http://localhost').pathname;
    const match = pathname.match(/^\/session\/([^/]+)\/message$/);
    return match?.[1] ? decodeURIComponent(match[1]) : undefined;
  }

  private async reconcileFailedPrompt(
    attempt: SessionBusyAttempt,
    requestError: unknown,
    workspaceDirectory?: string
  ): Promise<void> {
    if (isKnownPreAdmissionPromptFailure(requestError)) {
      this.callbacks.sessionState.reconcilePromptFailure(attempt, undefined);
      return;
    }
    try {
      const result = workspaceDirectory
        ? await this.requestServer('GET', '/session/status', undefined, {
            directory: workspaceDirectory,
          })
        : await this.requestServer('GET', '/session/status');
      const statuses = Array.isArray(result) ? undefined : asRecord(result);
      if (!statuses) {
        this.callbacks.sessionState.deferPromptFailure(attempt);
        return;
      }
      this.callbacks.sessionState.reconcilePromptFailure(attempt, statuses[attempt.sessionID]);
    } catch (err) {
      this.callbacks.sessionState.deferPromptFailure(attempt);
      logger.warn(
        `Failed to reconcile rejected prompt for ${attempt.sessionID}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private isPaginatedMessagesRequest(method: string, path: string) {
    if (method !== 'GET') return false;
    const url = new URL(path, 'http://localhost');
    return /^\/session\/[^/]+\/message$/.test(url.pathname) && url.searchParams.has('limit');
  }

  private async requestPaginatedMessages(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    workspaceDirectory?: string
  ) {
    const options: OpenCodeRequestOptions = {
      captureNextCursor: true,
      maxResponseBytes: SESSION_MESSAGE_FALLBACK_MAX_BYTES,
      maxProjectedResponseBytes: SESSION_MESSAGE_RESPONSE_MAX_BYTES,
      stripSummaryDiffs: true,
    };
    if (signal) options.signal = signal;
    if (workspaceDirectory) options.directory = workspaceDirectory;
    try {
      return await this.requestServer(method, path, body, options);
    } catch (err) {
      if (!(err instanceof OpenCodeResponseTooLargeError)) throw err;
      logger.warn(`Retrying oversized message page without tool attachments: ${path}`);
      return this.requestServer(method, path, body, {
        ...options,
        stripToolAttachments: true,
      });
    }
  }

  private parseSessionPageLimit(method: string, path: string) {
    if (method !== 'GET') return null;
    const url = new URL(path, 'http://localhost');
    if (url.pathname !== '/session' || !url.searchParams.has('limit')) return null;
    const limit = Number(url.searchParams.get('limit'));
    return Number.isSafeInteger(limit) && limit > 0 && limit <= FULL_SESSION_LIST_LIMIT
      ? limit
      : null;
  }

  private async requestWorkspaceSessions(path: string, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(path, 'http://localhost');
    const requestedLimit = this.parseSessionPageLimit('GET', path);
    const requestedDirectory = url.searchParams.get('directory');
    url.searchParams.delete('directory');
    const roots = requestedDirectory
      ? [this.requireOpenWorkspaceRoot(requestedDirectory)]
      : this.getOpenWorkspaceRoots();
    if (roots.length === 0) {
      const response = await this.requestServer(
        'GET',
        `${url.pathname}${url.search}`,
        undefined,
        signal ? { signal } : {}
      );
      if (requestedLimit === null) return this.filterApiResponse('GET', path, response);
      return this.formatPaginatedSessionsResponse(
        response,
        requestedLimit,
        this.isConstrainedSessionListRequest('GET', path)
      );
    }

    let perRootLimit = requestedLimit === null ? FULL_SESSION_LIST_LIMIT : requestedLimit;
    const scopeRequests = new Map(
      roots.map((root) => [root, this.resolveSessionCatalogScope(root, signal)] as const)
    );
    while (true) {
      signal?.throwIfAborted();
      const settledRootResults = await Promise.allSettled(
        roots.map(async (root) => {
          const rootUrl = new URL(url.toString());
          const scope = await scopeRequests.get(root)!;
          this.applySessionCatalogScope(rootUrl, scope);
          const catalogLimit = Math.min(perRootLimit + 1, FULL_SESSION_LIST_LIMIT);
          rootUrl.searchParams.set('limit', String(catalogLimit));
          const response = await this.requestSessionCatalog(
            `${rootUrl.pathname}${rootUrl.search}`,
            scope,
            root,
            signal
          );
          if (!Array.isArray(response)) throw new Error('Malformed session list response');
          let catalogValid = true;
          const scopedSessions = this.readSessionCatalog(response, scope, () => {
            catalogValid = false;
          }).filter(
            (session) =>
              !this.isDedicatedWorkspaceDirectory(root) ||
              this.getSessionWorkspaceScope(session.id) === 'workspace'
          );
          const reachedHardCap =
            catalogLimit === FULL_SESSION_LIST_LIMIT && response.length >= catalogLimit;
          const catalogMayHaveMore = response.length >= catalogLimit;
          return {
            catalogComplete: catalogValid && response.length < catalogLimit,
            hasMore: scopedSessions.length > perRootLimit || reachedHardCap,
            incomplete: reachedHardCap,
            needsLargerCatalog:
              scopedSessions.length <= perRootLimit && catalogMayHaveMore && !reachedHardCap,
            root,
            scope,
            sessions: scopedSessions.slice(0, perRootLimit),
          };
        })
      );
      signal?.throwIfAborted();
      const rootResults = settledRootResults.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      );
      const unavailableDirectories = settledRootResults.flatMap((result, index) =>
        result.status === 'rejected' && roots[index] ? [roots[index]] : []
      );
      if (rootResults.length === 0) {
        throw settledRootResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )?.reason;
      }
      for (const result of settledRootResults) {
        if (result.status === 'rejected') {
          logger.warn(
            `Could not load sessions from one workspace root: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
          );
        }
      }
      const sessions = this.mergeWorkspaceSessions(
        rootResults.flatMap((result) => result.sessions)
      );
      for (const result of rootResults) {
        this.rememberAuthorizedSessionCatalog(
          result.root,
          result.scope,
          result.sessions,
          result.catalogComplete
        );
      }
      const hasUnavailableRoot = unavailableDirectories.length > 0;
      const hasIncompleteCatalog = rootResults.some((result) => result.incomplete);
      const catalogSessions = sessions.map((session) =>
        this.projectWorkspaceCatalogSession(session)
      );
      const hasUnfetchedSessions =
        hasUnavailableRoot ||
        hasIncompleteCatalog ||
        rootResults.some((result) => result.hasMore || result.needsLargerCatalog);
      this.rememberSessionPage(
        catalogSessions,
        !hasUnfetchedSessions && !this.isConstrainedSessionListRequest('GET', path),
        this.isConstrainedSessionListRequest('GET', path),
        sessions
      );
      const visible = this.filterWorkspaceVisibleSessions(catalogSessions);
      if (requestedLimit === null) {
        if (hasUnavailableRoot) {
          throw new Error(`Could not load sessions from: ${unavailableDirectories.join(', ')}`);
        }
        return visible;
      }
      if (hasUnavailableRoot || hasIncompleteCatalog) {
        const page: {
          items: WorkspaceSession[];
          hasMore: boolean;
          incomplete: true;
          unavailableDirectories?: string[];
        } = {
          items: visible.slice(0, requestedLimit),
          hasMore:
            visible.length > requestedLimit ||
            rootResults.some((result) => result.hasMore || result.needsLargerCatalog),
          incomplete: true,
        };
        if (unavailableDirectories.length > 0) page.unavailableDirectories = unavailableDirectories;
        return page;
      }
      if (
        visible.length > requestedLimit ||
        !rootResults.some((result) => result.needsLargerCatalog) ||
        perRootLimit >= FULL_SESSION_LIST_LIMIT
      ) {
        return {
          items: visible.slice(0, requestedLimit),
          hasMore: visible.length > requestedLimit || rootResults.some((result) => result.hasMore),
        };
      }
      perRootLimit = Math.min(perRootLimit * 2, FULL_SESSION_LIST_LIMIT);
    }
  }

  private async requestWorkspaceSessionStatuses(signal?: AbortSignal) {
    const roots = this.getOpenWorkspaceRoots();
    if (roots.length === 0) {
      const response = await this.requestServer(
        'GET',
        '/session/status',
        undefined,
        signal ? { signal } : {}
      );
      return this.filterApiResponse('GET', '/session/status', response);
    }

    const scopeRequests = new Map(
      roots.map((root) => [root, this.resolveSessionCatalogScope(root, signal)] as const)
    );
    const resolvedScopes = await Promise.allSettled(scopeRequests.values());
    const openRootIdentities = new Set(
      resolvedScopes.flatMap((result, index) => {
        const root = roots[index];
        if (result.status !== 'fulfilled' || !root) return [];
        const identity = this.getSessionCatalogIdentity(root, result.value);
        return identity ? [identity] : [];
      })
    );
    this.workspaceSessionStatusCoordinator.clearCatalogsOutside(openRootIdentities);

    const settledResults = await Promise.allSettled(
      roots.map(async (root) => {
        const requestOptions = signal ? { signal, directory: root } : { directory: root };
        const scope = await scopeRequests.get(root)!;
        const identity = this.getSessionCatalogIdentity(root, scope);
        const rootStatusRequest = identity
          ? this.requestWorkspaceStatusForDirectory(identity, root, signal)
          : this.requestServer('GET', '/session/status', undefined, requestOptions);
        const [rootStatusValue, catalog] = await Promise.all([
          rootStatusRequest,
          this.loadWorkspaceStatusSessionCatalog(root, signal, true, scope),
        ]);
        const statusDirectories = new Map<string, string>();
        const rootIdentity = normalizeWorkspaceIdentity(root);
        if (rootIdentity) statusDirectories.set(rootIdentity, root);
        for (const session of catalog.sessions) {
          const sessionIdentity = normalizeWorkspaceIdentity(session.directory);
          if (sessionIdentity) statusDirectories.set(sessionIdentity, session.directory);
        }
        const statusValues = await Promise.all([
          rootStatusValue,
          ...[...statusDirectories.entries()]
            .filter(([directoryIdentity]) => directoryIdentity !== rootIdentity)
            .map(([, directory]) =>
              identity
                ? this.requestWorkspaceStatusForDirectory(identity, directory, signal)
                : this.requestServer('GET', '/session/status', undefined, {
                    ...requestOptions,
                    directory,
                  })
            ),
        ]);
        const statuses = Object.assign(
          {},
          ...statusValues.map((statusValue) => {
            if (!statusValue || Array.isArray(statusValue) || typeof statusValue !== 'object') {
              throw new Error('Malformed session status response');
            }
            return statusValue;
          })
        );
        const sessions = catalog.sessions;
        const visibleSessions = this.filterWorkspaceVisibleSessions(sessions);
        const visibleSessionsByID = new Map(
          visibleSessions.map((session) => [session.id, session] as const)
        );
        const endpointWorkspaceDirectory =
          this.callbacks.getWorkspacePath?.() ??
          this.callbacks.contextProvider.context.workspacePath ??
          this.callbacks.server.getWorkspaceCwd();
        return {
          catalogComplete: catalog.complete,
          sessions,
          statuses: Object.fromEntries(
            Object.entries(statuses)
              .filter(([sessionID]) => visibleSessionsByID.has(sessionID))
              .map(([sessionID, status]) => {
                const sessionDirectory = visibleSessionsByID.get(sessionID)?.directory;
                const exposeFullStatus =
                  !endpointWorkspaceDirectory ||
                  isSameWorkspacePath(sessionDirectory, endpointWorkspaceDirectory);
                return [
                  sessionID,
                  exposeFullStatus ? status : projectWorkspaceCatalogStatus(status),
                ];
              })
          ),
        };
      })
    );
    signal?.throwIfAborted();
    const results = settledResults.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : []
    );
    const unavailableDirectories = settledResults.flatMap((result, index) =>
      result.status === 'rejected' && roots[index] ? [roots[index]] : []
    );
    if (unavailableDirectories.length > 0) {
      for (const result of settledResults) {
        if (result.status !== 'rejected') continue;
        logger.warn(
          `Could not load session statuses from one workspace root: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
      throw new Error(`Could not load session statuses from: ${unavailableDirectories.join(', ')}`);
    }
    this.rememberSessionPage(
      this.mergeWorkspaceSessions(results.flatMap((result) => result.sessions)),
      results.every((result) => result.catalogComplete)
    );
    return Object.assign({}, ...results.map((result) => result.statuses));
  }

  private async requestWorkspacePendingAttention(
    path: '/permission' | '/question',
    signal?: AbortSignal
  ): Promise<unknown[]> {
    const roots = this.getOpenWorkspaceRoots();
    if (roots.length === 0) {
      const response = await this.requestServer(
        'GET',
        path,
        undefined,
        signal ? { signal } : undefined
      );
      if (!Array.isArray(response)) {
        throw new Error(`Malformed pending ${path.slice(1)} response`);
      }
      return response;
    }

    const scopes = await Promise.all(
      roots.map((root) => this.resolveSessionCatalogScope(root, signal))
    );
    const catalogs = await Promise.all(
      scopes.map((scope, index) => {
        const root = roots[index]!;
        return scope.kind === 'exact'
          ? Promise.resolve(null)
          : this.loadWorkspaceStatusSessionCatalog(root, signal, true, scope);
      })
    );
    const directories = new Map<string, string>();
    const rememberDirectory = (directory: string) => {
      const identity = normalizeWorkspaceIdentity(directory);
      if (identity) directories.set(identity, directory);
    };
    for (const root of roots) rememberDirectory(root);
    for (const catalog of catalogs) {
      if (!catalog) continue;
      if (!catalog.complete) {
        throw new Error('Cannot reconcile pending requests from an incomplete session catalog');
      }
      for (const session of catalog.sessions) rememberDirectory(session.directory);
    }

    const responses = await Promise.all(
      [...directories.values()].map((directory) =>
        this.requestServer('GET', path, undefined, { directory, signal })
      )
    );
    const requests: unknown[] = [];
    const seenIDs = new Set<string>();
    const seenValues = new Set<unknown>();
    for (const response of responses) {
      if (!Array.isArray(response)) {
        throw new Error(`Malformed pending ${path.slice(1)} response`);
      }
      for (const value of response) {
        const record = asRecord(value);
        const props =
          asRecord(asRecord(record?.properties)?.info) ?? asRecord(record?.info) ?? record;
        const rawID = props?.id ?? props?.permissionID ?? props?.requestID;
        const id = typeof rawID === 'string' ? rawID.trim() : '';
        if (id) {
          if (seenIDs.has(id)) continue;
          seenIDs.add(id);
        } else {
          if (seenValues.has(value)) continue;
          seenValues.add(value);
        }
        requests.push(value);
      }
    }
    return requests;
  }

  private requestWorkspaceStatusForDirectory(
    catalogIdentity: string,
    directory: string,
    signal?: AbortSignal
  ) {
    const directoryIdentity = normalizeWorkspaceIdentity(directory);
    const requestIdentity = `${catalogIdentity}\0${directoryIdentity ?? directory}`;
    return this.workspaceSessionStatusCoordinator.requestStatus(
      requestIdentity,
      () => this.requestServer('GET', '/session/status', undefined, { directory }),
      signal
    );
  }

  private async loadWorkspaceStatusSessionCatalog(
    root: string,
    signal?: AbortSignal,
    force = false,
    resolvedScope?: ResolvedSessionCatalogScope
  ) {
    const scope = resolvedScope ?? (await this.resolveSessionCatalogScope(root, signal));
    const identity = this.getSessionCatalogIdentity(root, scope);
    const scopedListPath = this.getScopedSessionListPath(FULL_SESSION_LIST_PATH, scope);
    const sharedCatalog = identity
      ? await this.workspaceSessionStatusCoordinator.requestCatalog(
          identity,
          () => this.requestSessionCatalog(scopedListPath, scope, root),
          { force, signal }
        )
      : {
          loadedAt: Date.now(),
          sessions: await this.requestSessionCatalog(scopedListPath, scope, root, signal),
        };
    if (!Array.isArray(sharedCatalog.sessions)) throw new Error('Malformed session list response');
    let catalogValid = true;
    const sessions = this.readSessionCatalog(sharedCatalog.sessions, scope, () => {
      catalogValid = false;
    }).filter(
      (session) =>
        !this.isDedicatedWorkspaceDirectory(root) ||
        this.getSessionWorkspaceScope(session.id) === 'workspace'
    );
    const catalog = {
      complete: catalogValid && sharedCatalog.sessions.length < FULL_SESSION_LIST_LIMIT,
      loadedAt: sharedCatalog.loadedAt,
      sessions,
    };
    this.rememberAuthorizedSessionCatalog(root, scope, sessions, catalog.complete);
    return catalog;
  }

  private refreshSessionEventCatalog(
    scope: Extract<ResolvedSessionCatalogScope, { kind: 'descendants' | 'project' }>,
    force = false
  ): Promise<void> {
    const identity = this.getSessionCatalogIdentity(scope.root, scope);
    if (!identity) return Promise.resolve();
    const now = Date.now();
    const cached = this.sessionEventCatalogRefreshes.get(identity);
    if (cached && cached.expiresAt > now) {
      if (!force) return cached.request;
      if (cached.expiresAt === Number.POSITIVE_INFINITY) {
        return cached.request.then(
          () => this.refreshSessionEventCatalog(scope, true),
          () => this.refreshSessionEventCatalog(scope, true)
        );
      }
    }
    const entry = {
      expiresAt: Number.POSITIVE_INFINITY,
      request: this.loadWorkspaceStatusSessionCatalog(scope.root, undefined, true, scope).then(
        () => undefined
      ),
    };
    this.sessionEventCatalogRefreshes.set(identity, entry);
    void entry.request.then(
      () => {
        if (this.sessionEventCatalogRefreshes.get(identity) === entry) {
          entry.expiresAt = Date.now() + SESSION_EVENT_CATALOG_REFRESH_MS;
        }
      },
      () => {
        if (this.sessionEventCatalogRefreshes.get(identity) === entry) {
          this.sessionEventCatalogRefreshes.delete(identity);
        }
      }
    );
    return entry.request;
  }

  private getOpenWorkspaceRoots() {
    const roots = new Map<string, string>();
    for (const folder of this.callbacks.contextProvider.context.workspaceFolders ?? []) {
      const root = this.callbacks.contextProvider.getOpenWorkspaceRoot(folder.path);
      const identity = normalizeWorkspaceIdentity(root);
      if (root && identity) roots.set(identity, root);
    }
    const workspaceDirectory = this.callbacks.contextProvider.context.workspaceDirectory;
    const workspaceIdentity = normalizeWorkspaceIdentity(workspaceDirectory);
    if (workspaceDirectory && workspaceIdentity) {
      roots.set(workspaceIdentity, workspaceDirectory);
    }
    if (roots.size === 0) {
      const current = this.getCurrentWorkspaceResolutionRoot();
      const identity = normalizeWorkspaceIdentity(current);
      if (current && identity) roots.set(identity, current);
    }
    return [...roots.values()];
  }

  private isDedicatedWorkspaceDirectory(directory: string) {
    const workspaceDirectory = this.callbacks.contextProvider.context.workspaceDirectory;
    return (
      Boolean(workspaceDirectory && isSameWorkspacePath(directory, workspaceDirectory)) &&
      !this.callbacks.contextProvider.getOpenWorkspaceRoot(directory)
    );
  }

  private readSessionCatalog(
    values: unknown[],
    scope: ResolvedSessionCatalogScope,
    onMalformed?: () => void
  ) {
    const sessions: WorkspaceSession[] = [];
    let malformedRows = 0;
    for (const value of values) {
      const session = this.validateWorkspaceSession(value, scope);
      if (!session) {
        malformedRows += 1;
        continue;
      }
      if (this.isSessionInCatalogScope(session, scope)) sessions.push(session);
    }
    if (malformedRows > 0) {
      onMalformed?.();
      logger.warn(
        `Skipped ${malformedRows} malformed session catalog ${malformedRows === 1 ? 'row' : 'rows'} for ${scope.root}`
      );
    }
    return sessions;
  }

  private validateWorkspaceSession(
    value: unknown,
    scope: ResolvedSessionCatalogScope
  ): WorkspaceSession | null {
    const session = asRecord(value);
    if (
      !session ||
      typeof session.id !== 'string' ||
      !session.id ||
      typeof session.directory !== 'string' ||
      !normalizeWorkspaceIdentity(session.directory)
    ) {
      return null;
    }
    if (scope.kind === 'exact' && !isSameWorkspacePath(session.directory, scope.root)) {
      throw new Error(`OpenCode returned a session outside workspace root ${scope.root}`);
    }
    const projected = this.withSessionWorkspaceScope(
      {
        ...(projectSummaryDiffs(session) as Record<string, unknown>),
        id: session.id,
        directory: session.directory,
      },
      this.readAndRememberSessionWorkspaceScope(session)
    );
    return projected;
  }

  private isSessionInCatalogScope(
    session: { directory: string; projectID?: unknown },
    scope: ResolvedSessionCatalogScope
  ): boolean {
    if (scope.kind === 'exact') return isSameWorkspacePath(session.directory, scope.root);
    if (scope.kind === 'descendants') {
      return getRelativePathWithinWorkspace(session.directory, scope.root) !== null;
    }
    return session.projectID === scope.projectID;
  }

  private async resolveSessionCatalogScope(
    root: string,
    signal?: AbortSignal
  ): Promise<ResolvedSessionCatalogScope> {
    const mode = this.callbacks.getSessionHistoryScope?.(root) ?? 'directory';
    if (mode === 'directory') return { kind: 'exact', root };
    if (mode === 'descendants') return { kind: 'descendants', root };
    const project = await this.loadSessionCatalogProject(root, signal);
    if (mode === 'project' && project.vcs === 'git') {
      return { kind: 'project', root, projectID: project.id };
    }
    return { kind: 'descendants', root };
  }

  private async loadSessionCatalogProject(
    root: string,
    signal?: AbortSignal
  ): Promise<SessionCatalogProject> {
    const identity = normalizeWorkspaceIdentity(root);
    if (!identity) throw new Error('Invalid project root');
    const now = Date.now();
    let cached = this.currentProjects.get(identity);
    if (!cached || cached.expiresAt <= now) {
      const entry = {
        expiresAt: Number.POSITIVE_INFINITY,
        request: Promise.resolve().then(async () => {
          const value = asRecord(
            await this.requestServer('GET', '/project/current', undefined, { directory: root })
          );
          if (typeof value?.id !== 'string' || typeof value.worktree !== 'string') {
            throw new Error('Malformed current project response');
          }
          const project: SessionCatalogProject = {
            id: value.id,
            worktree: value.worktree,
          };
          if (typeof value.vcs === 'string') project.vcs = value.vcs;
          return project;
        }),
      };
      cached = entry;
      this.currentProjects.set(identity, entry);
      void entry.request.then(
        () => {
          if (this.currentProjects.get(identity) === entry) {
            entry.expiresAt = Date.now() + CURRENT_PROJECT_CACHE_TTL_MS;
          }
        },
        () => {
          if (this.currentProjects.get(identity) === entry) this.currentProjects.delete(identity);
        }
      );
    }
    return raceAgainstAbort(cached.request, signal);
  }

  private getSessionHistoryScopeKey(project: SessionCatalogProject, root: string): string {
    if (project.vcs === 'git') return `project:${project.id}`;
    return `directory:${normalizeWorkspaceIdentity(root) ?? root}`;
  }

  private async handleSessionHistoryScopeRequest(
    request: SessionHistoryScopeRequest,
    signal?: AbortSignal
  ) {
    const project = await this.loadSessionCatalogProject(request.directory, signal);
    const key = this.getSessionHistoryScopeKey(project, request.directory);
    await this.callbacks.associateSessionHistoryScope?.(request.directory, key);
    if (request.scope) {
      const scope =
        request.scope === 'project' && project.vcs !== 'git' ? 'descendants' : request.scope;
      if (!this.callbacks.updateSessionHistoryScope) {
        throw new Error('Session history scope updates are unavailable');
      }
      await this.callbacks.updateSessionHistoryScope(key, scope);
    }
    const stored = this.callbacks.getSessionHistoryScopeByKey?.(key) ?? 'directory';
    const scope = stored === 'project' && project.vcs !== 'git' ? 'descendants' : stored;
    return { scope, git: project.vcs === 'git' };
  }

  private applySessionCatalogScope(url: URL, scope: ResolvedSessionCatalogScope) {
    if (scope.kind === 'descendants') {
      url.pathname = '/experimental/session';
      url.searchParams.delete('scope');
      url.searchParams.delete('path');
      return;
    }
    if (scope.kind === 'project') {
      url.searchParams.set('scope', 'project');
    }
  }

  private getScopedSessionListPath(path: string, scope: ResolvedSessionCatalogScope) {
    const url = new URL(path, 'http://localhost');
    this.applySessionCatalogScope(url, scope);
    return `${url.pathname}${url.search}`;
  }

  private requestSessionCatalog(
    path: string,
    scope: ResolvedSessionCatalogScope,
    root: string,
    signal?: AbortSignal
  ): ReturnType<OpenCodeServer['request']> {
    const options: OpenCodeRequestOptions = {};
    if (signal) options.signal = signal;
    if (scope.kind === 'descendants') {
      options.unscoped = true;
      return this.callbacks.server.request('GET', path, undefined, options);
    }
    options.directory = root;
    return this.requestServer('GET', path, undefined, options);
  }

  private getSessionCatalogIdentity(root: string, scope?: ResolvedSessionCatalogScope) {
    const identity = normalizeWorkspaceIdentity(root);
    if (!identity) return null;
    if (!scope)
      return `${identity}\0${this.callbacks.getSessionHistoryScope?.(root) ?? 'directory'}`;
    return scope.kind === 'project'
      ? `${identity}\0project\0${scope.projectID}`
      : `${identity}\0${scope.kind}`;
  }

  private rememberAuthorizedSessionCatalog(
    root: string,
    scope: ResolvedSessionCatalogScope,
    sessions: WorkspaceSession[],
    complete: boolean
  ) {
    const identity = this.getSessionCatalogIdentity(root, scope);
    const rootIdentity = normalizeWorkspaceIdentity(root);
    if (!identity || !rootIdentity) return;
    for (const [catalogIdentity, catalog] of this.authorizedSessionCatalogs) {
      if (catalog.rootIdentity === rootIdentity && catalogIdentity !== identity) {
        this.authorizedSessionCatalogs.delete(catalogIdentity);
      }
    }
    const previous = this.authorizedSessionCatalogs.get(identity);
    const authorized = complete ? new Map() : new Map(previous?.sessions);
    for (const session of sessions) {
      authorized.set(session.id, { directory: session.directory, catalogRoot: root });
    }
    this.authorizedSessionCatalogs.set(identity, {
      rootIdentity,
      sessions: authorized,
    });
    this.authorizedSessionDirectories = new Map(
      [...this.authorizedSessionCatalogs.values()].flatMap((catalog) => [
        ...catalog.sessions.entries(),
      ])
    );
  }

  private projectWorkspaceCatalogSession<T extends WorkspaceSession>(session: T): T {
    const endpointWorkspaceDirectory =
      this.callbacks.getWorkspacePath?.() ??
      this.callbacks.contextProvider.context.workspacePath ??
      this.callbacks.server.getWorkspaceCwd();
    return endpointWorkspaceDirectory &&
      !isSameWorkspacePath(session.directory, endpointWorkspaceDirectory)
      ? projectWorkspaceCatalogSession(session)
      : session;
  }

  private mergeWorkspaceSessions(
    sessions: Array<Record<string, unknown> & { id: string; directory: string }>
  ) {
    const byID = new Map<string, (typeof sessions)[number]>();
    for (const session of sessions) {
      const existing = byID.get(session.id);
      if (existing && !isSameWorkspacePath(existing.directory, session.directory)) {
        throw new Error(`Session ${session.id} belongs to more than one workspace root`);
      }
      if (!existing || getSessionActivityTime(session) > getSessionActivityTime(existing)) {
        byID.set(session.id, session);
      }
    }
    return [...byID.values()].toSorted((left, right) => {
      const activity = getSessionActivityTime(right) - getSessionActivityTime(left);
      return activity || left.id.localeCompare(right.id);
    });
  }

  private filterWorkspaceVisibleSessions<T extends { id: string }>(sessions: T[]) {
    return this.callbacks.sessionTrash.filterVisibleSessions(
      this.callbacks.hiddenSessions.filterVisibleSessions(sessions)
    );
  }

  private formatPaginatedSessionsResponse(response: unknown, limit: number, constrained: boolean) {
    if (!Array.isArray(response)) throw new Error('Malformed session list response');
    const sessions = response.slice(0, limit).map(projectSummaryDiffs);
    const hasMore = response.length > limit;
    this.rememberSessionPage(sessions, !constrained && !hasMore, constrained);
    return { items: this.filterVisibleSessions(sessions), hasMore };
  }

  private async formatPaginatedMessagesResponse(
    method: string,
    path: string,
    response: OpenCodeResponseMetadata
  ) {
    const result: { items: unknown; nextCursor?: string } = {
      items: await this.filterApiResponse(method, path, response.data),
    };
    if (response.nextCursor) result.nextCursor = response.nextCursor;
    return result;
  }

  private parsePermanentDeleteRequest(method: string, path: string): PermanentDeleteRequest | null {
    if (method !== 'DELETE') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/varro\/session\/([^/]+)\/delete$/);
    if (!match) return null;
    return { sessionID: decodeURIComponent(match[1]!) };
  }

  private parseSessionDiffSummaryRequest(method: string, path: string) {
    if (method !== 'GET') return null;
    const url = new URL(path, 'http://localhost');
    const prefix = `${VARRO_API_ENDPOINTS.session}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const match = url.pathname.slice(prefix.length).match(/^([^/]+)\/diff-summary$/);
    if (!match?.[1]) return null;
    if (
      Array.from(url.searchParams.keys()).some((key) => key !== 'revision' && key !== 'directory')
    ) {
      return null;
    }
    const sessionID = decodeURIComponent(match[1]);
    const revision = url.searchParams.get('revision')?.trim();
    return {
      sessionID,
      cacheKey: revision ? `${sessionID}:${revision}` : null,
    };
  }

  private parsePinRequest(method: string, path: string, body: unknown) {
    if (method !== 'POST') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/varro\/session\/([^/]+)\/pin$/);
    if (!match) return null;
    const record = asRecord(body);
    if (typeof record?.pinned !== 'boolean') throw new Error('Invalid pin request');
    return { sessionID: decodeURIComponent(match[1]!), pinned: record.pinned };
  }

  private parseSessionActivationRequest(method: string, path: string, body: unknown) {
    if (method !== 'POST') return null;
    const url = new URL(path, 'http://localhost');
    const prefix = `${VARRO_API_ENDPOINTS.session}/`;
    if (!url.pathname.startsWith(prefix)) return null;
    const match = url.pathname.slice(prefix.length).match(/^([^/]+)\/activate$/);
    if (!match?.[1]) return null;
    const directory = asRecord(body)?.directory;
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new Error('Session directory is required');
    }
    return { sessionID: decodeURIComponent(match[1]), directory };
  }

  private parsePermissionModeRequest(
    method: string,
    path: string,
    body: unknown
  ): {
    sessionID: string;
    mode: PermissionMode;
    preconfigured: boolean;
    defaultPermission?: PermissionRule[];
  } | null {
    if (method !== 'POST') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/varro\/session\/([^/]+)\/permission-mode$/);
    if (!match) return null;
    const record = asRecord(body);
    const mode = record?.mode;
    if (mode !== 'default' && mode !== 'auto' && mode !== 'full') {
      throw new Error('Invalid permission mode request');
    }
    const preconfigured = record?.preconfigured;
    if (preconfigured !== undefined && typeof preconfigured !== 'boolean') {
      throw new Error('Invalid permission mode request');
    }
    const defaultPermission = record?.defaultPermission;
    if (
      defaultPermission !== undefined &&
      (mode !== 'default' ||
        !Array.isArray(defaultPermission) ||
        defaultPermission.some(
          (rule) =>
            typeof asRecord(rule)?.permission !== 'string' ||
            typeof asRecord(rule)?.pattern !== 'string' ||
            !['allow', 'ask', 'deny'].includes(String(asRecord(rule)?.action))
        ))
    ) {
      throw new Error('Invalid permission mode request');
    }
    const request: {
      sessionID: string;
      mode: PermissionMode;
      preconfigured: boolean;
      defaultPermission?: PermissionRule[];
    } = {
      sessionID: decodeURIComponent(match[1]!),
      mode,
      preconfigured: preconfigured === true,
    };
    if (defaultPermission) request.defaultPermission = defaultPermission as PermissionRule[];
    return request;
  }

  private parsePermissionAllowRequest(
    endpoint: string,
    method: string,
    path: string,
    body: unknown
  ): { sessionId: string; permissionId: string } | null {
    if (method !== 'POST') return null;
    const url = new URL(path, 'http://localhost');
    if (url.pathname !== endpoint) return null;
    const record = asRecord(body);
    const sessionId = typeof record?.sessionId === 'string' ? record.sessionId.trim() : '';
    const permissionId = typeof record?.permissionId === 'string' ? record.permissionId.trim() : '';
    if (!sessionId || !permissionId) throw new Error('Invalid permission scope request');
    return { sessionId, permissionId };
  }

  private async persistProjectPermissionAllow(
    request: { sessionId: string; permissionId: string },
    directory: string | undefined,
    signal?: AbortSignal
  ) {
    const { permission, patterns } = await this.getPendingPermissionAllowScope(
      request,
      directory,
      signal
    );
    await this.updateOpenCodeProjectPermission(permission, patterns);
    return { permission, patterns };
  }

  private async getPendingPermissionAllowScope(
    request: { sessionId: string; permissionId: string },
    directory: string | undefined,
    signal?: AbortSignal
  ) {
    const options = { directory, signal };
    const pending = await this.requestServer('GET', '/permission', undefined, options);
    if (!Array.isArray(pending)) throw new Error('Cannot verify the pending permission request');
    const match = pending
      .map((value) => asRecord(asRecord(value)?.info) ?? asRecord(value))
      .find((value) => {
        const id = value?.id ?? value?.permissionID ?? value?.requestID;
        return id === request.permissionId && value?.sessionID === request.sessionId;
      });
    if (!match) throw new Error('404 permission request not found');

    const permission =
      typeof match.permission === 'string'
        ? match.permission.trim()
        : typeof match.type === 'string'
          ? match.type.trim()
          : '';
    const patterns = Array.isArray(match.always)
      ? [...new Set(match.always.filter((value): value is string => typeof value === 'string'))]
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    if (!permission || patterns.length === 0) {
      throw new Error('Standing approval scope is unavailable for this request');
    }

    return { permission, patterns };
  }

  private async readSessionDiffSummary(sessionID: string): Promise<SessionDiffSummary> {
    let local: LocalSessionSummaryData | null | undefined;
    try {
      local = await this.callbacks.readLocalSessionSummary?.(sessionID);
    } catch {
      local = null;
    }
    if (local) return summarizeLocalSession(local);

    const encodedSessionID = encodeURIComponent(sessionID);
    const [diffs, messages, sessions] = await Promise.all([
      this.requestServer('GET', `/session/${encodedSessionID}/diff`),
      this.requestSessionMessagesForSummary(`/session/${encodedSessionID}/message`),
      this.readSessionListForSummary(),
    ]);
    const diffStats = summarizeSessionDiff(diffs);
    const historyStatsUnavailable = hasOmittedMessageHistory(messages);
    const messageEditStats = summarizeSessionMessageEdits(messages);
    const editStats = hasSessionEdits(diffStats) ? diffStats : messageEditStats;
    const summary = await this.summarizeSessionTreeTokens(sessionID, messages, sessions);
    const tokenBreakdown = summary.tokenBreakdown;
    const model = summarizeSessionModel(messages);
    const result: SessionDiffSummary = {
      ...editStats,
      tokens:
        getSessionTokensExcludingCacheReads(tokenBreakdown.session) +
        getSessionTokensExcludingCacheReads(tokenBreakdown.subagents),
      ...summarizeSessionDuration(messages),
    };
    if (historyStatsUnavailable) result.historyStatsUnavailable = true;
    if (model) result.model = model;
    if (!historyStatsUnavailable) result.tokenBreakdown = tokenBreakdown;
    if (!historyStatsUnavailable && summary.nestedContextBreakdown.length > 0) {
      result.nestedContextBreakdown = summary.nestedContextBreakdown;
    }
    return result;
  }

  private readCachedSessionDiffSummary(
    sessionID: string,
    revisionCacheKey: string | null
  ): Promise<SessionDiffSummary> {
    const cacheKey = revisionCacheKey ?? sessionID;
    const now = Date.now();
    const cached = this.sessionSummaryRequests.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      this.sessionSummaryRequests.delete(cacheKey);
      this.sessionSummaryRequests.set(cacheKey, cached);
      return cached.request;
    }
    if (cached) this.sessionSummaryRequests.delete(cacheKey);

    const request = this.readSessionDiffSummary(sessionID);
    const entry = {
      expiresAt: now + SESSION_SUMMARY_CACHE_TTL_MS,
      request,
    };
    this.sessionSummaryRequests.set(cacheKey, entry);
    while (this.sessionSummaryRequests.size > SESSION_SUMMARY_CACHE_LIMIT) {
      const oldestSessionID = this.sessionSummaryRequests.keys().next().value;
      if (typeof oldestSessionID !== 'string') break;
      this.sessionSummaryRequests.delete(oldestSessionID);
    }
    void request.then(
      () => {
        if (!revisionCacheKey && this.sessionSummaryRequests.get(cacheKey) === entry) {
          this.sessionSummaryRequests.delete(cacheKey);
        }
      },
      () => {
        if (this.sessionSummaryRequests.get(cacheKey) === entry) {
          this.sessionSummaryRequests.delete(cacheKey);
        }
      }
    );
    return request;
  }

  private async requestSessionMessagesForSummary(path: string) {
    try {
      return projectMessageHistory(
        await this.requestServer('GET', path, undefined, {
          maxResponseBytes: SESSION_MESSAGE_FALLBACK_MAX_BYTES,
          maxProjectedResponseBytes: SESSION_MESSAGE_RESPONSE_MAX_BYTES,
          stripSummaryDiffs: true,
        })
      );
    } catch (err) {
      if (!(err instanceof OpenCodeResponseTooLargeError)) throw err;
      logger.warn(`Skipping oversized message history while summarizing ${path}`);
      return omittedMessageHistory();
    }
  }

  private async summarizeSessionTreeTokens(
    sessionID: string,
    rootMessages: unknown,
    sessionsValue: unknown
  ) {
    const descendants = collectDescendantSessions(sessionsValue, sessionID);
    const session = summarizeSessionTokenUsage(rootMessages);
    const subagents = emptySessionTokenUsage();
    const messageLists = await mapWithConcurrency(
      descendants,
      SESSION_SUMMARY_DESCENDANT_CONCURRENCY,
      (descendant) =>
        this.withSessionSummaryDescendantSlot(() =>
          this.requestServer('GET', `/session/${encodeURIComponent(descendant.id)}/message`)
        )
    );
    for (let index = 0; index < descendants.length; index += 1) {
      const snapshot = summarizeTokenUsageRecord(asRecord(descendants[index]?.tokens));
      addSessionTokenUsage(
        subagents,
        snapshot.total > 0 ? snapshot : summarizeSessionTokenUsage(messageLists[index])
      );
    }
    return {
      tokenBreakdown: {
        session,
        subagents,
        subagentCount: descendants.length,
      } satisfies SessionTokenBreakdown,
      nestedContextBreakdown: estimateNestedContextBreakdown([
        normalizeContextMessages(rootMessages),
        ...messageLists.map(normalizeContextMessages),
      ]),
    };
  }

  private readSessionListForSummary(): Promise<unknown> {
    const now = Date.now();
    const directory = this.requestWorkspaceDirectory.getStore();
    const cacheKey = directory ? (normalizeWorkspaceIdentity(directory) ?? directory) : '';
    const cached = this.sessionSummaryListRequests.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      this.sessionSummaryListRequests.delete(cacheKey);
      this.sessionSummaryListRequests.set(cacheKey, cached);
      return cached.request;
    }
    if (cached) this.sessionSummaryListRequests.delete(cacheKey);
    const request = this.requestServer('GET', FULL_SESSION_LIST_PATH).then((sessions) => {
      if (!Array.isArray(sessions)) return sessions;
      const projectedSessions = sessions.map(projectSummaryDiffs);
      this.observeInternalHelperSessions(projectedSessions);
      return this.callbacks.hiddenSessions.filterVisibleSessions(
        projectedSessions.filter(
          (session): session is { id: string } => typeof asRecord(session)?.id === 'string'
        )
      );
    });
    const entry = {
      expiresAt: now + SESSION_SUMMARY_CACHE_TTL_MS,
      request,
    };
    this.sessionSummaryListRequests.set(cacheKey, entry);
    while (this.sessionSummaryListRequests.size > SESSION_SUMMARY_CACHE_LIMIT) {
      const oldestKey = this.sessionSummaryListRequests.keys().next().value;
      if (typeof oldestKey !== 'string') break;
      this.sessionSummaryListRequests.delete(oldestKey);
    }
    void request.catch(() => {
      if (this.sessionSummaryListRequests.get(cacheKey) === entry) {
        this.sessionSummaryListRequests.delete(cacheKey);
      }
    });
    return request;
  }

  private async withSessionSummaryDescendantSlot<T>(request: () => Promise<T>): Promise<T> {
    if (this.activeSessionSummaryDescendantRequests < SESSION_SUMMARY_DESCENDANT_CONCURRENCY) {
      this.activeSessionSummaryDescendantRequests += 1;
    } else {
      await new Promise<void>((resolve) => {
        this.sessionSummaryDescendantWaiters.push(resolve);
      });
    }

    try {
      return await request();
    } finally {
      const next = this.sessionSummaryDescendantWaiters.shift();
      if (next) next();
      else this.activeSessionSummaryDescendantRequests -= 1;
    }
  }

  private getHiddenSessionIdFromPath(path: string) {
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/session\/([^/]+)/);
    if (!match) return null;
    const sessionID = decodeURIComponent(match[1]!);
    return this.isHiddenSession(sessionID) ? sessionID : null;
  }

  private async filterApiResponse(
    method: string,
    path: string,
    data: unknown,
    pendingAttentionReconciliation?: PendingAttentionReconciliation
  ) {
    const url = new URL(path, 'http://localhost');
    if (method === 'GET' && url.pathname === '/session' && Array.isArray(data)) {
      const sessions = data.map(projectSummaryDiffs);
      this.rememberSessionList(sessions);
      return this.filterVisibleSessions(sessions);
    }
    if (method === 'GET' && /^\/session\/[^/]+\/diff$/.test(url.pathname)) {
      return projectFileDiffs(data);
    }
    if (
      method === 'GET' &&
      /^\/session\/[^/]+\/message$/.test(url.pathname) &&
      Array.isArray(data)
    ) {
      return this.sanitizeSessionMessages(url.pathname, data);
    }
    if (
      method === 'GET' &&
      url.pathname === '/session/status' &&
      data &&
      typeof data === 'object'
    ) {
      return this.callbacks.sessionTrash.filterVisibleSessionStatuses(
        this.callbacks.hiddenSessions.filterVisibleSessionStatuses(
          await this.filterSessionStatusesForCurrentWorkspace(data as Record<string, unknown>)
        )
      );
    }
    if (method === 'GET' && url.pathname === '/question' && Array.isArray(data)) {
      const requests = this.callbacks.sessionTrash.filterVisibleSessionRequests(
        this.callbacks.hiddenSessions.filterVisibleSessionRequests(
          await this.filterSessionRequestsForCurrentWorkspace(
            data as Array<{ sessionID: string }>,
            pendingAttentionReconciliation?.workspacePath
          )
        )
      );
      this.callbacks.sessionState.reconcilePendingAttention(
        'question',
        requests,
        pendingAttentionReconciliation
      );
      return requests;
    }
    if (method === 'GET' && url.pathname === '/permission' && Array.isArray(data)) {
      const requests = this.callbacks.sessionTrash.filterVisibleSessionRequests(
        this.callbacks.hiddenSessions.filterVisibleSessionRequests(
          await this.filterSessionRequestsForCurrentWorkspace(
            data as Array<{ sessionID: string }>,
            pendingAttentionReconciliation?.workspacePath
          )
        )
      );
      this.callbacks.sessionState.reconcilePendingAttention(
        'permission',
        requests,
        pendingAttentionReconciliation
      );
      return requests;
    }
    const session = asRecord(data);
    if (
      isSafePersistedSessionId(session?.id) &&
      typeof session.directory === 'string' &&
      /^\/session\/[^/]+(?:\/(?:fork|share))?$/.test(url.pathname)
    ) {
      return this.withSessionWorkspaceScope(
        session,
        this.readAndRememberSessionWorkspaceScope(session)
      );
    }
    return data;
  }

  private rememberSessionList(sessions: unknown[]) {
    this.rememberSessionPage(sessions, true);
  }

  private rememberSessionPage(
    sessions: unknown[],
    complete: boolean,
    preserveCompleteSnapshot = false,
    hiddenSessionSnapshots: unknown[] = sessions
  ) {
    this.recordSessionDirectories(sessions, complete, preserveCompleteSnapshot);
    this.observeInternalHelperSessions(hiddenSessionSnapshots);
    for (const session of sessions) {
      const info = asRecord(session);
      if (!info) continue;
      this.callbacks.sessionState.handleServerEvent({
        type: 'session.updated',
        properties: { info },
      });
    }
  }

  private observeInternalHelperSessions(sessions: unknown[]) {
    this.cleanupStaleInternalHelperSessions(
      this.callbacks.hiddenSessions.observeSessionList(
        sessions.filter(
          (session): session is { id: string } => typeof asRecord(session)?.id === 'string'
        )
      )
    );
  }

  private cleanupStaleInternalHelperSessions(sessionIDs: string[]) {
    if (sessionIDs.length === 0) return;
    const start = this.internalHelperCleanupCursor % sessionIDs.length;
    this.internalHelperCleanupCursor =
      (start + INTERNAL_HELPER_CLEANUP_QUEUE_LIMIT) % sessionIDs.length;
    const orderedSessionIDs = Array.from(
      { length: sessionIDs.length },
      (_, offset) => sessionIDs[(start + offset) % sessionIDs.length]
    ).filter((sessionID): sessionID is string => !!sessionID);
    this.internalHelperCleanupCoordinator.enqueue(
      orderedSessionIDs,
      async (sessionID) => {
        try {
          const deleted = await this.callbacks.server.request(
            'DELETE',
            `/session/${encodeURIComponent(sessionID)}`,
            undefined,
            { directory: this.sessionDirectories.get(sessionID) }
          );
          if (deleted === true) {
            this.callbacks.hiddenSessions.retainUntilDeleted(sessionID);
            return 'settled';
          }
          logger.warn(
            `Failed to delete stale internal helper session ${sessionID}: OpenCode did not confirm deletion`
          );
          return 'deferred';
        } catch (err: unknown) {
          if (isNotFoundError(err)) {
            this.callbacks.hiddenSessions.retainUntilDeleted(sessionID);
            return 'settled';
          }
          logger.warn(
            `Failed to delete stale internal helper session ${sessionID}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          return 'deferred';
        }
      },
      (sessionID) => this.callbacks.hiddenSessions.retainUntilDeleted(sessionID)
    );
  }

  private filterVisibleSessions(sessions: unknown[]) {
    return this.callbacks.sessionTrash.filterVisibleSessions(
      this.callbacks.hiddenSessions.filterVisibleSessions(
        this.filterSessionsForCurrentWorkspace(
          sessions as Array<{ id: string; directory?: unknown }>
        )
      )
    );
  }

  private filterSessionsForCurrentWorkspace<T extends { directory?: unknown }>(sessions: T[]) {
    const workspacePath = this.getCurrentWorkspacePath();
    if (!normalizeWorkspaceIdentity(workspacePath)) return sessions;
    return sessions.filter((session) => isDirectoryInWorkspace(session.directory, workspacePath));
  }

  private async filterSessionStatusesForCurrentWorkspace<T>(statuses: Record<string, T>) {
    const workspacePath = this.getCurrentWorkspacePath();
    const normalizedWorkspacePath = normalizeWorkspaceIdentity(workspacePath);
    if (!normalizedWorkspacePath) return statuses;
    const visibleSessionIDs = await this.getVisibleWorkspaceSessionIDs(
      Object.keys(statuses),
      normalizedWorkspacePath
    );
    return Object.fromEntries(
      Object.entries(statuses).filter(([sessionID]) => visibleSessionIDs.has(sessionID))
    );
  }

  private async filterSessionRequestsForCurrentWorkspace<T extends { sessionID: string }>(
    requests: T[],
    workspacePath = this.getCurrentWorkspacePath()
  ) {
    const normalizedWorkspacePath = normalizeWorkspaceIdentity(workspacePath);
    if (!normalizedWorkspacePath) return requests;
    const visibleSessionIDs = await this.getVisibleWorkspaceSessionIDs(
      requests.map((request) => request.sessionID),
      normalizedWorkspacePath,
      true
    );
    return requests.filter((request) => visibleSessionIDs.has(request.sessionID));
  }

  private async getVisibleWorkspaceSessionIDs(
    sessionIDs: string[],
    workspacePath: string,
    requireCompleteResolution = false
  ): Promise<Set<string>> {
    const visible = new Set<string>();
    const unknown: string[] = [];
    for (const sessionID of new Set(sessionIDs)) {
      const workspaceMatch = this.callbacks.sessionState.getSessionWorkspaceMatch(
        sessionID,
        workspacePath
      );
      const workspaceDirectory = this.callbacks.contextProvider.context.workspaceDirectory;
      const workspaceDirectoryMatch = workspaceDirectory
        ? this.callbacks.sessionState.getSessionWorkspaceMatch(sessionID, workspaceDirectory)
        : false;
      if (workspaceMatch === true) {
        visible.add(sessionID);
      } else if (
        workspaceDirectory &&
        workspaceDirectoryMatch === true &&
        (this.isDedicatedWorkspaceDirectory(workspaceDirectory) ||
          this.getSessionWorkspaceScope(sessionID) === 'workspace')
      ) {
        visible.add(sessionID);
      } else if (
        workspaceMatch === undefined ||
        workspaceDirectoryMatch === undefined ||
        (workspaceDirectoryMatch === true && !this.sessionWorkspaceScopes.has(sessionID))
      ) {
        unknown.push(sessionID);
      }
    }
    if (unknown.length === 0) return visible;

    const directories = await this.loadSessionDirectorySnapshot();
    await mapWithConcurrency(unknown, SESSION_VISIBILITY_LOOKUP_CONCURRENCY, async (sessionID) => {
      const knownDirectory = directories.get(sessionID);
      if (knownDirectory) {
        if (this.isSessionVisibleInWorkspace(sessionID, knownDirectory, workspacePath)) {
          visible.add(sessionID);
        }
        return;
      }
      try {
        const workspaceDirectory = this.callbacks.contextProvider.context.workspaceDirectory;
        const directory = await this.lookupSessionDirectory(
          sessionID,
          this.getSessionWorkspaceScope(sessionID) === 'workspace'
            ? (workspaceDirectory ?? workspacePath)
            : workspacePath
        );
        if (!directory && requireCompleteResolution) {
          throw new Error(`Session ${sessionID} did not include a directory`);
        }
        if (this.isSessionVisibleInWorkspace(sessionID, directory, workspacePath)) {
          visible.add(sessionID);
        }
      } catch (err) {
        if (requireCompleteResolution) {
          throw new Error(`Could not resolve pending request session ${sessionID}`, { cause: err });
        }
        // An unresolved session cannot be assigned to this workspace safely.
      }
    });
    return visible;
  }

  private isSessionVisibleInWorkspace(
    sessionID: string,
    directory: string | undefined,
    workspacePath: string
  ): boolean {
    if (isSameWorkspacePath(directory, workspacePath)) return true;
    const workspaceDirectory = this.callbacks.contextProvider.context.workspaceDirectory;
    if (!workspaceDirectory || !isSameWorkspacePath(directory, workspaceDirectory)) return false;
    return (
      this.isDedicatedWorkspaceDirectory(workspaceDirectory) ||
      this.getSessionWorkspaceScope(sessionID) === 'workspace'
    );
  }

  private loadSessionDirectorySnapshot(): Promise<ReadonlyMap<string, string>> {
    if (this.sessionDirectoryBootstrapPromise) return this.sessionDirectoryBootstrapPromise;
    if (this.hasSessionDirectorySnapshot) {
      return Promise.resolve(new Map(this.sessionDirectories));
    }
    return this.trackSessionDirectoryBootstrap(
      this.requestServer('GET', FULL_SESSION_LIST_PATH),
      true
    );
  }

  private trackSessionDirectoryBootstrap(
    request: Promise<unknown>,
    rememberSessions: boolean
  ): Promise<ReadonlyMap<string, string>> {
    const bootstrap = request.then(
      (sessions) => {
        if (Array.isArray(sessions)) {
          if (rememberSessions) this.rememberSessionList(sessions);
          else this.recordSessionDirectories(sessions);
        }
        return new Map(this.sessionDirectories);
      },
      () => new Map(this.sessionDirectories)
    );
    this.sessionDirectoryBootstrapPromise = bootstrap;
    void bootstrap
      .finally(() => {
        if (this.sessionDirectoryBootstrapPromise === bootstrap) {
          this.sessionDirectoryBootstrapPromise = null;
        }
      })
      .catch(() => undefined);
    return bootstrap;
  }

  private recordSessionDirectories(
    sessions: unknown[],
    complete = true,
    preserveCompleteSnapshot = false
  ) {
    const hadCompleteSnapshot = this.hasSessionDirectorySnapshot;
    const directories = complete ? new Map<string, string>() : new Map(this.sessionDirectories);
    for (const session of sessions) {
      const info = asRecord(session);
      if (typeof info?.id !== 'string' || typeof info.directory !== 'string') continue;
      if (!normalizeWorkspaceIdentity(info.directory)) continue;
      directories.set(info.id, info.directory);
      this.readAndRememberSessionWorkspaceScope(info);
    }
    this.sessionDirectories = directories;
    this.hasSessionDirectorySnapshot =
      complete || (preserveCompleteSnapshot && hadCompleteSnapshot);
  }

  private isSessionListRequest(method: string, path: string) {
    return method === 'GET' && new URL(path, 'http://localhost').pathname === '/session';
  }

  private isConstrainedSessionListRequest(method: string, path: string) {
    if (!this.isSessionListRequest(method, path)) return false;
    const params = new URL(path, 'http://localhost').searchParams;
    return params.has('search') || params.has('roots') || params.has('directory');
  }

  private getCurrentWorkspacePath() {
    return (
      this.requestWorkspaceDirectory.getStore() ||
      this.callbacks.getWorkspacePath?.() ||
      this.callbacks.contextProvider.context.workspacePath ||
      this.callbacks.server.getWorkspaceCwd()
    );
  }

  private getCurrentWorkspaceResolutionRoot(): string | undefined {
    const workspacePath = this.getCurrentWorkspacePath();
    if (!workspacePath) return undefined;
    return this.callbacks.contextProvider.getOpenWorkspaceRoot(workspacePath) ?? workspacePath;
  }

  private async assertSessionInWorkspace(
    sessionID: string,
    workspacePath: string | null | undefined,
    lookupDirectory?: string
  ) {
    if (!normalizeWorkspaceIdentity(workspacePath)) return;
    if (this.isAuthorizedSessionDirectory(sessionID, workspacePath ?? undefined)) return;
    if (this.callbacks.sessionState.isSessionInWorkspace(sessionID, workspacePath)) return;

    if (this.callbacks.getStatus().state !== 'running') {
      await this.callbacks.ensureServerStarted();
    }
    const directory = await this.lookupSessionDirectory(sessionID, lookupDirectory);
    if (!isSameWorkspacePath(directory, workspacePath)) {
      throw new Error('404 Session not found');
    }
  }

  private requireOpenWorkspaceRoot(workspaceDirectory: string): string {
    const matchedWorkspacePath =
      this.callbacks.contextProvider.getOpenWorkspaceRoot(workspaceDirectory);
    if (matchedWorkspacePath) return matchedWorkspacePath;
    const workspaceRoot = this.callbacks.contextProvider.context.workspaceDirectory;
    if (workspaceRoot && isSameWorkspacePath(workspaceDirectory, workspaceRoot))
      return workspaceRoot;
    throw new Error('Workspace directory is not an open workspace folder');
  }

  private requireAuthorizedSessionDirectory(sessionID: string, directory: string): string {
    try {
      return this.requireOpenWorkspaceRoot(directory);
    } catch (error) {
      if (this.isAuthorizedSessionDirectory(sessionID, directory)) return directory;
      throw error;
    }
  }

  private resolvePendingAttentionReplyDirectory(requestID: string): string | null {
    const request = this.callbacks.resolvePendingAttentionRequest?.(requestID);
    if (!request) return null;
    const authorized = this.authorizedSessionDirectories.get(request.sessionID);
    if (
      authorized &&
      (!request.directory || isSameWorkspacePath(authorized.directory, request.directory))
    ) {
      return authorized.directory;
    }
    if (
      request.directory &&
      (isSameWorkspacePath(request.directory, this.callbacks.getWorkspacePath?.()) ||
        (this.callbacks.sessionState.workspaceScopeFor(request.sessionID) === 'workspace' &&
          Boolean(this.callbacks.contextProvider.getOpenWorkspaceRoot(request.directory))))
    ) {
      return request.directory;
    }
    throw new Error('404 Attention request not found');
  }

  private requireAuthorizedSessionActivation(
    sessionID: string,
    directory: string
  ): AuthorizedSessionDirectory {
    const authorized = this.authorizedSessionDirectories.get(sessionID);
    if (authorized && isSameWorkspacePath(authorized.directory, directory)) return authorized;
    const root = this.requireOpenWorkspaceRoot(directory);
    return { directory: root, catalogRoot: root };
  }

  private isAuthorizedSessionDirectory(sessionID: string, directory?: string) {
    const authorizedDirectory = this.authorizedSessionDirectories.get(sessionID);
    return Boolean(
      authorizedDirectory &&
      (!directory || isSameWorkspacePath(authorizedDirectory.directory, directory))
    );
  }

  private withSessionWorkspaceScope<T extends Record<string, unknown>>(
    session: T,
    scope: SessionWorkspaceScope
  ): T {
    if (isSafePersistedSessionId(session.id)) this.sessionWorkspaceScopes.set(session.id, scope);
    if (scope === 'workspace') return { ...session, workspaceScope: scope } as T;
    const { workspaceScope: _workspaceScope, ...rest } = session;
    return rest as T;
  }

  private readAndRememberSessionWorkspaceScope(session: Record<string, unknown>) {
    const scope = isSessionWorkspaceScope(session.workspaceScope)
      ? session.workspaceScope
      : (getSessionWorkspaceScopeFromMetadata(session.metadata) ?? 'folder');
    if (isSafePersistedSessionId(session.id)) this.sessionWorkspaceScopes.set(session.id, scope);
    return scope;
  }

  private getSessionWorkspaceScope(sessionID: string): SessionWorkspaceScope {
    const rememberedScope = this.sessionWorkspaceScopes.get(sessionID);
    const inheritedScope = this.callbacks.sessionState.workspaceScopeFor(sessionID);
    return rememberedScope === 'workspace' || inheritedScope === 'workspace'
      ? 'workspace'
      : 'folder';
  }

  private parseSessionCreationScope(
    method: string,
    path: string,
    body: unknown
  ): SessionWorkspaceScope | null {
    if (method !== 'POST' || new URL(path, 'http://localhost').pathname !== '/session') return null;
    return getSessionWorkspaceScopeFromMetadata(asRecord(body)?.metadata) ?? 'folder';
  }

  private parseForkParentSessionID(method: string, path: string): string | null {
    if (method !== 'POST') return null;
    const match = new URL(path, 'http://localhost').pathname.match(/^\/session\/([^/]+)\/fork$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  private async persistForkWorkspaceScope(
    session: Record<string, unknown>,
    scope: SessionWorkspaceScope
  ) {
    if (getSessionWorkspaceScopeFromMetadata(session.metadata) === scope) {
      return this.withSessionWorkspaceScope(session, scope);
    }
    if (!isSafePersistedSessionId(session.id) || typeof session.directory !== 'string') {
      throw new Error('Malformed session fork response');
    }
    const metadata = asRecord(session.metadata) ?? {};
    const existingVarro = asRecord(metadata.varro) ?? {};
    const scopeMetadata = createSessionWorkspaceMetadata(scope);
    const updated = await this.requestServer(
      'PATCH',
      this.buildScopedSessionPath(session.id, session.directory),
      {
        metadata: {
          ...metadata,
          varro: { ...existingVarro, ...scopeMetadata.varro },
        },
      }
    );
    const updatedSession = asRecord(updated);
    return this.withSessionWorkspaceScope(
      updatedSession ?? {
        ...session,
        metadata: {
          ...metadata,
          varro: { ...existingVarro, ...scopeMetadata.varro },
        },
      },
      scope
    );
  }

  private withWorkspaceScopeSystemPrompt(
    body: unknown,
    scope: SessionWorkspaceScope,
    workingDirectory: string
  ): unknown {
    const record = asRecord(body);
    if (!record) return body;
    const scopePrompt =
      scope === 'workspace'
        ? [
            'You are working in a VS Code multi-root workspace.',
            `Treat these folders as one logical workspace: ${JSON.stringify(
              this.callbacks.contextProvider.context.workspaceFolders ?? []
            )}.`,
            `The OpenCode working directory is ${JSON.stringify(workingDirectory)}. It is the base for commands and relative paths, not the boundary of the logical workspace.`,
          ].join(' ')
        : [
            'You are working in a VS Code multi-root workspace.',
            `The folder selected for this session and the OpenCode working directory is ${JSON.stringify(workingDirectory)}.`,
            `The workspace contains these folders: ${JSON.stringify(
              this.callbacks.contextProvider.context.workspaceFolders ?? []
            )}.`,
            'Treat the selected folder as the primary working scope. The other listed folders are sibling workspace context; accessing them may require external_directory approval.',
          ].join(' ');
    const existing = typeof record.system === 'string' ? record.system.trim() : '';
    return {
      ...record,
      system: existing ? `${existing}\n\nVS Code workspace context:\n${scopePrompt}` : scopePrompt,
    };
  }

  private isHiddenSession(sessionID: string | null | undefined) {
    return (
      this.callbacks.sessionTrash.isHidden(sessionID) ||
      this.callbacks.hiddenSessions.isHidden(sessionID)
    );
  }

  private sanitizeSessionMessages(pathname: string, data: unknown[]) {
    const sessionMatch = pathname.match(/^\/session\/([^/]+)\/message$/);
    const requestedSessionID = sessionMatch ? decodeURIComponent(sessionMatch[1]!) : null;
    const seenMessageIDs = new Set<string>();
    const seenPartIDs = new Set<string>();
    let droppedEntries = 0;
    let droppedParts = 0;
    const normalized: Array<{ info: Record<string, unknown>; parts: Record<string, unknown>[] }> =
      [];

    for (const entry of data) {
      const record = asRecord(entry);
      const info = asRecord(record?.info);
      const time = asRecord(info?.time);
      if (
        !info ||
        typeof info.id !== 'string' ||
        !info.id ||
        typeof info.sessionID !== 'string' ||
        !info.sessionID ||
        info.sessionID !== requestedSessionID ||
        seenMessageIDs.has(info.id) ||
        (info.role !== 'user' && info.role !== 'assistant') ||
        typeof time?.created !== 'number'
      ) {
        droppedEntries += 1;
        continue;
      }
      seenMessageIDs.add(info.id);

      const parts: Record<string, unknown>[] = [];
      if (Array.isArray(record?.parts)) {
        for (const part of record.parts) {
          const partRecord = asRecord(part);
          if (
            !partRecord ||
            typeof partRecord.id !== 'string' ||
            !partRecord.id ||
            typeof partRecord.messageID !== 'string' ||
            !partRecord.messageID ||
            partRecord.messageID !== info.id ||
            typeof partRecord.sessionID !== 'string' ||
            !partRecord.sessionID ||
            partRecord.sessionID !== info.sessionID ||
            seenPartIDs.has(partRecord.id) ||
            typeof partRecord.type !== 'string' ||
            !partRecord.type
          ) {
            droppedParts += 1;
            continue;
          }
          seenPartIDs.add(partRecord.id);
          parts.push(projectPartFileLists(partRecord));
        }
      } else if (record?.parts !== undefined) {
        droppedParts += 1;
      }

      normalized.push({ info: projectSummaryDiffs(info), parts });
    }

    if (droppedEntries > 0 || droppedParts > 0) {
      logger.warn(
        `Filtered malformed session message payload for ${pathname} (${droppedEntries} entries, ${droppedParts} parts)`
      );
    }

    return normalized;
  }

  private async handleRecycleBinRequest(request: RecycleBinRequest) {
    const scopes = await Promise.all(
      this.getOpenWorkspaceRoots().map((root) => this.resolveSessionCatalogScope(root))
    );
    const entries = this.callbacks.sessionTrash
      .list()
      .filter((entry) => scopes.some((scope) => this.isSessionInCatalogScope(entry.root, scope)));
    switch (request.kind) {
      case 'list':
        return entries;
      case 'restore': {
        const entry = entries.find((candidate) => candidate.rootID === request.rootID);
        if (!entry) return false;
        const restored = await this.callbacks.sessionTrash.restore(
          request.rootID,
          entry.root.directory
        );
        return Boolean(restored);
      }
      case 'delete': {
        const entry = entries.find((candidate) => candidate.rootID === request.rootID);
        if (!entry) return false;
        const removed = await this.callbacks.sessionTrash.deletePermanently(
          request.rootID,
          (session) => this.deleteSessionForDirectory(session),
          entry.root.directory
        );
        if (removed) {
          this.callbacks.sessionState.removeSessions(removed.sessions.map((session) => session.id));
        }
        return Boolean(removed);
      }
      case 'empty': {
        const roots = [...new Set(entries.map((entry) => entry.root.directory))];
        const removed = (
          await Promise.all(
            roots.map((root) =>
              this.callbacks.sessionTrash.empty(
                (session) => this.deleteSessionForDirectory(session),
                root
              )
            )
          )
        ).flat();
        if (removed.length > 0) {
          this.callbacks.sessionState.removeSessions(
            removed.flatMap((entry) => entry.sessions.map((session) => session.id))
          );
        }
        return true;
      }
    }
  }

  private async moveSessionToRecycleBin(sessionID: string) {
    const directory =
      this.authorizedSessionDirectories.get(sessionID)?.directory ??
      this.requestWorkspaceDirectory.getStore();
    const sessions = (
      (await this.requestServer(
        'GET',
        FULL_SESSION_LIST_PATH,
        undefined,
        directory ? { directory } : undefined
      )) as Array<Record<string, unknown>>
    ).map((session) => {
      return this.withSessionWorkspaceScope(
        session,
        this.readAndRememberSessionWorkspaceScope(session)
      );
    });
    const statuses = asRecord(
      await this.requestServer(
        'GET',
        '/session/status',
        undefined,
        directory ? { directory } : undefined
      )
    );
    if (!statuses) throw new Error('Malformed session status response');
    const sessionIDs = [
      sessionID,
      ...collectDescendantSessions(sessions, sessionID).map((session) => session.id),
    ];
    for (const candidateID of sessionIDs) {
      const status = asRecord(statuses[candidateID]);
      if (
        status?.type !== 'busy' &&
        status?.type !== 'retry' &&
        !this.callbacks.shouldAbortSessionBeforeRecycle?.(candidateID)
      ) {
        continue;
      }
      await this.requestServer(
        'POST',
        `/session/${encodeURIComponent(candidateID)}/abort`,
        undefined,
        directory ? { directory } : undefined
      );
    }
    const entry = await this.callbacks.sessionTrash.moveToTrash(sessionID, sessions);
    if (!entry) {
      throw new Error('404 Session not found');
    }
    const sessionIds = entry.sessions.map((session) => session.id);
    await this.callbacks.removeSessionImages(sessionIds);
    this.callbacks.sessionState.removeSessions(sessionIds);
    return true;
  }

  private async deleteSessionPermanently(sessionID: string, requestedDirectory?: string) {
    if (this.permanentlyDeletedSessionIds.has(sessionID)) return true;
    const foundDirectory = await this.lookupSessionDirectory(sessionID, requestedDirectory);
    if (!foundDirectory) throw new Error('404 Session not found');
    const sessionDirectory = this.requireAuthorizedSessionDirectory(sessionID, foundDirectory);
    if (requestedDirectory && !isSameWorkspacePath(sessionDirectory, requestedDirectory)) {
      throw new Error('404 Session not found');
    }
    await this.deleteSessionForDirectory({ id: sessionID, directory: sessionDirectory });
    this.callbacks.sessionState.removeSessions([sessionID]);
    while (this.permanentlyDeletedSessionIds.size >= PERMANENT_DELETION_TOMBSTONE_LIMIT) {
      const oldest = this.permanentlyDeletedSessionIds.values().next().value;
      if (!oldest) break;
      this.permanentlyDeletedSessionIds.delete(oldest);
    }
    this.permanentlyDeletedSessionIds.add(sessionID);
    return true;
  }

  private async deleteSessionForDirectory(session: SessionDeleteTarget) {
    const path = this.buildScopedSessionPath(session.id, session.directory);
    try {
      const result = await this.requestServer('DELETE', path);
      if (result !== true && (await this.sessionExistsOnServer(session.id, session.directory))) {
        throw new Error('OpenCode did not confirm session deletion');
      }
      await this.callbacks.removeSessionImages([session.id]);
      this.sessionWorkspaceScopes.delete(session.id);
      return result;
    } catch (err) {
      // Sessions can predate the server's current ID format (legacy ULIDs get
      // a 500, not a 404), which would leave their trash entries undeletable.
      // Only propagate the failure when the session still exists server-side.
      if (await this.sessionExistsOnServer(session.id, session.directory)) throw err;
      await this.callbacks.removeSessionImages([session.id]);
      this.sessionWorkspaceScopes.delete(session.id);
      return true;
    }
  }

  private async sessionExistsOnServer(sessionID: string, directory?: string) {
    try {
      await this.requestServer('GET', this.buildScopedSessionPath(sessionID, directory));
      return true;
    } catch (err) {
      return !isNotFoundError(err);
    }
  }

  private async lookupSessionDirectory(sessionID: string, workspaceDirectory?: string) {
    const path = this.buildScopedSessionPath(sessionID, workspaceDirectory);
    const session = await this.requestServer('GET', path);
    const record = asRecord(session);
    if (record) this.rememberSessionPage([record], false);
    return typeof record?.directory === 'string' ? record.directory : undefined;
  }

  private async resolveJudgeWorkspacePath(sessionID: string) {
    const currentWorkspace = this.getCurrentWorkspaceResolutionRoot();
    const cachedDirectory = this.sessionDirectories.get(sessionID);
    if (cachedDirectory) {
      if (
        currentWorkspace &&
        !isSameWorkspacePath(cachedDirectory, currentWorkspace) &&
        !this.isAuthorizedSessionDirectory(sessionID, cachedDirectory)
      ) {
        throw new Error('404 Session not found');
      }
      return cachedDirectory;
    }

    const directory = await this.lookupSessionDirectory(sessionID, currentWorkspace);
    if (
      currentWorkspace &&
      !isSameWorkspacePath(directory, currentWorkspace) &&
      !this.isAuthorizedSessionDirectory(sessionID, directory)
    ) {
      throw new Error('404 Session not found');
    }
    return directory;
  }

  private buildScopedSessionPath(sessionID: string, directory?: string) {
    const path = `/session/${encodeURIComponent(sessionID)}`;
    return directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;
  }

  private parseProviderLimitRequest(method: string, path: string) {
    if (method !== 'GET') return null;

    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.providerLimit) return null;

    const providerID = url.searchParams.get('providerID')?.trim();
    if (!providerID) return null;

    return {
      providerID,
      modelID: url.searchParams.get('modelID')?.trim() || null,
    };
  }

  private parseWorkspaceFileRequest(method: string, path: string) {
    if (method !== 'GET') return null;

    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.workspaceFile) return null;

    const filePath = url.searchParams.get('path')?.trim();
    if (!filePath) {
      throw new Error('Workspace file path is required');
    }

    return { path: filePath };
  }

  private isWorkspaceFilePickRequest(method: string, path: string) {
    return method === 'GET' && path === VARRO_API_ENDPOINTS.workspaceFilePick;
  }

  private parseWorkspaceResolveRequest(method: string, path: string) {
    if (method !== 'GET') return null;

    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.workspacePathResolve) return null;

    const filePath = url.searchParams.get('path')?.trim();
    if (!filePath) {
      throw new Error('Workspace path is required');
    }

    return { path: filePath };
  }

  private parseSessionHistoryScopeRequest(
    method: string,
    path: string,
    body: unknown
  ): SessionHistoryScopeRequest | null {
    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.sessionHistoryScope) return null;
    if (method !== 'GET' && method !== 'POST') return null;
    const directory = url.searchParams.get('directory')?.trim();
    if (!directory) throw new Error('Session history scope requires a workspace directory');
    if (method === 'GET') return { directory };
    const scope = asRecord(body)?.scope;
    if (!isSessionHistoryScope(scope)) throw new Error('Invalid session history scope');
    return { directory, scope };
  }

  private async pickWorkspaceFile(): Promise<WorkspaceFilePick | null> {
    const result = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      title: 'Select Ralph plan document',
    });
    const selected = result?.[0];
    if (!selected) return null;

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(selected);
    const workspaceDirectory = workspaceFolder
      ? this.callbacks.contextProvider.getOpenWorkspaceRoot(workspaceFolder.uri.fsPath)
      : null;
    if (!workspaceFolder || !workspaceDirectory) {
      throw new Error('Selected file is outside the open workspace folders');
    }
    return {
      path: getRelativePath(selected, workspaceFolder),
      workspaceDirectory,
    };
  }

  private parsePlanOpenRequest(method: string, path: string, body: unknown) {
    if (method !== 'POST' || path !== VARRO_API_ENDPOINTS.planOpen) return null;

    const payload = asRecord(body);
    const content = typeof payload?.content === 'string' ? payload.content : '';
    if (!content.trim()) {
      throw new Error('Plan content is empty');
    }
    if (content.length > 1_000_000) {
      throw new Error('Plan content is too large to save');
    }

    return { content };
  }

  private parseOpenCodeConfigRequest(
    method: string,
    path: string,
    body: unknown
  ): OpenCodeConfigRequest | null {
    if (method === 'GET' && path === VARRO_API_ENDPOINTS.openCodeConfig) {
      return { kind: 'get' };
    }

    if (method !== 'POST' || path !== VARRO_API_ENDPOINTS.openCodeConfigModelRouting) return null;

    const payload = asRecord(body);
    const target = typeof payload?.target === 'string' ? payload.target : null;
    const providerID = typeof payload?.providerID === 'string' ? payload.providerID.trim() : '';
    const modelID = typeof payload?.modelID === 'string' ? payload.modelID.trim() : '';
    const unset = payload?.unset === true;

    if (!target || !providerID || !modelID) {
      throw new Error('Invalid model routing update');
    }

    if (target === 'small_model') {
      return { kind: 'update', target, providerID, modelID, unset };
    }

    if (target === 'commit_message' || target === 'auto_approve') {
      return { kind: 'update', target, providerID, modelID, unset };
    }

    if (target === 'agent') {
      const agentName = typeof payload?.agentName === 'string' ? payload.agentName.trim() : '';
      if (!agentName) {
        throw new Error('Agent name is required');
      }
      return { kind: 'update', target, agentName, providerID, modelID, unset };
    }

    throw new Error('Unsupported model routing target');
  }

  private parseOpenCodePermissionConfigRequest(
    method: string,
    path: string,
    body: unknown
  ): OpenCodePermissionConfigRequest | null {
    if (path !== VARRO_API_ENDPOINTS.openCodeConfigPermissions) return null;
    if (method === 'GET') return { kind: 'get' };
    if (method !== 'POST') return null;

    return { kind: 'update', rules: this.parsePermissionRules(asRecord(body)?.rules) };
  }

  private parseSessionPermissionRulesRequest(
    method: string,
    path: string,
    body: unknown
  ): SessionPermissionRulesRequest | null {
    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.permissionSessionRules) return null;
    if (method === 'GET') {
      const sessionID = url.searchParams.get('sessionId')?.trim() ?? '';
      if (!sessionID) throw new Error('Session ID is required');
      return { kind: 'get', sessionID };
    }
    if (method !== 'POST') return null;
    const record = asRecord(body);
    const sessionID = typeof record?.sessionId === 'string' ? record.sessionId.trim() : '';
    if (!sessionID) throw new Error('Session ID is required');
    return { kind: 'update', sessionID, rules: this.parsePermissionRules(record?.rules, true) };
  }

  private parseServerMemoryPermissionRequest(
    method: string,
    path: string,
    body: unknown
  ): ServerMemoryPermissionRequest | null {
    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.permissionServerMemory) return null;
    if (method === 'GET') {
      const sessionID = url.searchParams.get('sessionId')?.trim() ?? '';
      return sessionID ? { kind: 'list', sessionID } : { kind: 'list' };
    }
    if (method !== 'DELETE') return null;
    const record = asRecord(body);
    const sessionID = typeof record?.sessionId === 'string' ? record.sessionId.trim() : '';
    const id = typeof record?.id === 'string' ? record.id.trim() : '';
    if (!id) throw new Error('Saved permission ID is required');
    return sessionID ? { kind: 'remove', sessionID, id } : { kind: 'remove', id };
  }

  private parsePermissionRules(values: unknown, allowOverrides = false): PermissionRule[] {
    if (!Array.isArray(values) || values.length > 500) {
      throw new Error('Invalid permission configuration');
    }
    const rules: PermissionRule[] = [];
    const keys = new Set<string>();
    for (const value of values) {
      const record = asRecord(value);
      const permission = typeof record?.permission === 'string' ? record.permission.trim() : '';
      const pattern = typeof record?.pattern === 'string' ? record.pattern.trim() : '';
      const action = record?.action;
      if (
        !permission ||
        permission.length > 200 ||
        !pattern ||
        pattern.length > 2_000 ||
        (action !== 'allow' && action !== 'ask' && action !== 'deny')
      ) {
        throw new Error('Invalid permission rule');
      }
      const key = `${permission}\0${pattern}`;
      if (!allowOverrides && keys.has(key)) {
        throw new Error(`Duplicate permission rule: ${permission} / ${pattern}`);
      }
      keys.add(key);
      rules.push({ permission, pattern, action });
    }
    return rules;
  }

  private parseJudgePermissionRequest(
    method: string,
    path: string,
    body: unknown
  ): AutoApproveJudgeRequest | null {
    if (method !== 'POST' || path !== VARRO_API_ENDPOINTS.permissionJudge) return null;
    const payload = asRecord(body);
    const permission = asRecord(payload?.permission);
    if (!permission) throw new Error('Permission context is required');

    const rawModel = asRecord(payload?.model);
    const providerID = typeof rawModel?.providerID === 'string' ? rawModel.providerID.trim() : '';
    const modelID = typeof rawModel?.modelID === 'string' ? rawModel.modelID.trim() : '';
    const variant = typeof rawModel?.variant === 'string' ? rawModel.variant.trim() : '';
    const request: AutoApproveJudgeRequest = {
      permission,
      approvedReferences: parseApprovedPermissionReferences(payload?.approvedReferences),
    };
    if (providerID && modelID) {
      const model: AutoApproveJudgeRequest['model'] = { providerID, modelID };
      if (variant) model.variant = variant;
      request.model = model;
    }
    return request;
  }

  private parseJudgeModelRequest(method: string, path: string) {
    if (method !== 'GET') return null;
    const url = new URL(path, 'http://localhost');
    if (url.pathname !== VARRO_API_ENDPOINTS.permissionJudgeModel) return null;

    const providerID = url.searchParams.get('providerID')?.trim() || '';
    const modelID = url.searchParams.get('modelID')?.trim() || '';
    const variant = url.searchParams.get('variant')?.trim() || '';
    let model: AutoApproveJudgeRequest['model'];
    if (providerID && modelID) {
      model = { providerID, modelID };
      if (variant) model.variant = variant;
    }
    return { model };
  }

  private parseRenameIfUntitledRequest(method: string, path: string) {
    if (method !== 'POST') return null;
    const match = path.match(/^\/varro\/session\/([^/?#]+)\/rename-if-untitled$/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  private getOpenCodeWorkspacePath() {
    const workspacePath = this.getCurrentWorkspacePath();
    if (!workspacePath) {
      throw new Error('Open a workspace folder before editing project OpenCode config');
    }
    return getOpenCodePathApi(workspacePath).resolve(workspacePath);
  }

  private async readOpenCodeConfigObject(): Promise<OpenCodeConfigSnapshot> {
    const workspacePath = this.getOpenCodeWorkspacePath();
    const files: OpenCodeConfigFile[] = [];
    const pathApi = getOpenCodePathApi(workspacePath);
    const candidates = resolveOpenCodeProjectConfigPaths(workspacePath, (path) =>
      pathApi.basename(path) === '.git' ? existsSync(path) : true
    );
    for (const path of candidates) {
      const uri = vscode.Uri.file(path);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const raw = new TextDecoder().decode(bytes);
        files.push({ path, uri, raw, config: parseOpenCodeConfig(raw, path) });
      } catch (err) {
        if (
          err &&
          typeof err === 'object' &&
          'code' in err &&
          (err.code === 'FileNotFound' || err.code === 'ENOENT')
        ) {
          continue;
        }
        throw err;
      }
    }

    const config = files.reduce<Record<string, unknown>>(
      (merged, file) => mergeOpenCodeConfig(merged, file.config),
      {}
    );
    const localFiles = files.filter((file) => pathApi.dirname(file.path) === workspacePath);
    const target = localFiles.at(-1) || {
      path: pathApi.join(workspacePath, 'opencode.json'),
      uri: vscode.Uri.file(pathApi.join(workspacePath, 'opencode.json')),
      raw: '{}\n',
      config: {} as Record<string, unknown>,
    };
    return { workspacePath, files, config, target };
  }

  private normalizeOpenCodeModelRouting(config: Record<string, unknown>): OpenCodeModelRouting {
    const smallModel = parseModelRoute(config.small_model);
    const agentModels: Record<string, { providerID: string; modelID: string }> = {};
    const agents = asRecord(config.agent);

    if (agents) {
      for (const [name, value] of Object.entries(agents)) {
        const agentConfig = asRecord(value);
        const route = parseModelRoute(agentConfig?.model);
        if (route) {
          agentModels[name] = route;
        }
      }
    }

    const extensionConfig = vscode.workspace.getConfiguration('varro');
    return {
      smallModel,
      agentModels,
      commitMessageModel: parseModelRoute(extensionConfig.get('commitMessage.model')),
      autoApproveModel: parseModelRoute(extensionConfig.get('chat.autoApproveModel')),
    };
  }

  private async readOpenCodeModelRouting(): Promise<OpenCodeModelRouting> {
    const { config, files } = await this.readOpenCodeConfigObject();
    const routing = this.normalizeOpenCodeModelRouting(config);
    const providerConfigPaths = await this.readOpenCodeProviderConfigPaths(files);
    return Object.keys(providerConfigPaths).length > 0
      ? { ...routing, providerConfigPaths }
      : routing;
  }

  private async readOpenCodeProviderConfigPaths(
    projectFiles: Array<{ path: string; config: Record<string, unknown> }>
  ) {
    const configuredPath = process.env.OPENCODE_CONFIG?.trim();
    const candidatePaths = [
      ...getOpenCodeConfigPaths(),
      ...(configuredPath ? [configuredPath] : []),
      ...projectFiles.map((file) => file.path),
    ].filter((path, index, paths) => paths.indexOf(path) === index);
    const projectConfigByPath = new Map(projectFiles.map((file) => [file.path, file.config]));
    const providerConfigPaths: Record<string, string[]> = {};

    for (const path of candidatePaths) {
      let config = projectConfigByPath.get(path);
      if (!config) {
        try {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
          config = parseOpenCodeConfig(new TextDecoder().decode(bytes), path);
        } catch {
          continue;
        }
      }

      const providers = asRecord(config.provider);
      if (!providers) continue;
      for (const providerID of Object.keys(providers)) {
        (providerConfigPaths[providerID] ??= []).push(path);
      }
    }

    return providerConfigPaths;
  }

  private async updateModelRouting(
    request: Extract<OpenCodeConfigRequest, { kind: 'update' }>
  ): Promise<OpenCodeModelRouting> {
    if (request.target === 'commit_message' || request.target === 'auto_approve') {
      const key =
        request.target === 'commit_message' ? 'commitMessage.model' : 'chat.autoApproveModel';
      await vscode.workspace
        .getConfiguration('varro')
        .update(
          key,
          request.unset ? undefined : `${request.providerID}/${request.modelID}`,
          vscode.ConfigurationTarget.Global
        );
      return this.readOpenCodeModelRouting();
    }
    return this.updateOpenCodeModelRouting(request);
  }

  private async updateOpenCodeModelRouting(
    request: Extract<OpenCodeConfigRequest, { kind: 'update' }>
  ): Promise<OpenCodeModelRouting> {
    if (request.target !== 'small_model' && request.target !== 'agent') {
      throw new Error('Unsupported OpenCode model routing target');
    }
    let snapshot = await this.readOpenCodeConfigObject();
    while (true) {
      const candidate = this.selectOpenCodeModelRoutingTarget(request, snapshot);
      if (!candidate) return this.normalizeOpenCodeModelRouting(snapshot.config);
      const lockPath = getCanonicalOpenCodeConfigPath(candidate.path);
      const result = await withOpenCodeConfigUpdateLock(lockPath, async () => {
        const currentSnapshot = await this.readOpenCodeConfigObject();
        const target = this.selectOpenCodeModelRoutingTarget(request, currentSnapshot);
        if (!target) {
          return {
            kind: 'complete' as const,
            routing: this.normalizeOpenCodeModelRouting(currentSnapshot.config),
          };
        }
        if (getCanonicalOpenCodeConfigPath(target.path) !== lockPath) {
          return { kind: 'retry' as const, snapshot: currentSnapshot };
        }

        const { workspacePath, files, config } = currentSnapshot;
        const { uri } = target;
        const dirtyDocument = vscode.workspace.textDocuments.find(
          (document) =>
            document.isDirty &&
            (document.uri.toString() === uri.toString() ||
              isSameWorkspacePath(document.uri.fsPath, uri.fsPath))
        );
        if (dirtyDocument) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} has unsaved changes; save or revert the document before updating model routing`
          );
        }
        const initialStat = await this.readConfigStat(uri);
        let nextRaw = target.raw.trim() ? target.raw : '{}\n';
        if (
          !request.unset &&
          (typeof target.config.$schema !== 'string' || !target.config.$schema.trim())
        ) {
          nextRaw = applyJsoncChange(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
        }

        const modelRef = `${request.providerID}/${request.modelID}`;
        if (request.target === 'small_model') {
          nextRaw = applyJsoncChange(
            nextRaw,
            ['small_model'],
            request.unset ? undefined : modelRef
          );
        } else {
          const agentName = request.agentName;
          if (!agentName) {
            throw new Error('Agent name is required');
          }
          nextRaw = applyJsoncChange(
            nextRaw,
            ['agent', agentName, 'model'],
            request.unset ? undefined : modelRef
          );
          if (request.unset) {
            let nextConfig = parseOpenCodeConfig(nextRaw, target.path);
            const agentConfig = asRecord(asRecord(nextConfig.agent)?.[agentName]);
            if (agentConfig && Object.keys(agentConfig).length === 0) {
              nextRaw = applyJsoncChange(nextRaw, ['agent', agentName], undefined);
              nextConfig = parseOpenCodeConfig(nextRaw, target.path);
              const agents = asRecord(nextConfig.agent);
              if (agents && Object.keys(agents).length === 0) {
                nextRaw = applyJsoncChange(nextRaw, ['agent'], undefined);
              }
            }
          }
        }

        const nextTargetConfig = parseOpenCodeConfig(nextRaw, target.path);
        const encoded = new TextEncoder().encode(nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`);
        const latestStat = await this.readConfigStat(uri);
        if (!this.areConfigStatsEqual(initialStat, latestStat)) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} changed while updating model routing; please retry`
          );
        }
        const previousRouting = this.normalizeOpenCodeModelRouting(config);
        await vscode.workspace.fs.writeFile(uri, encoded);
        let effectiveConfig = files.reduce<Record<string, unknown>>(
          (merged, file) =>
            mergeOpenCodeConfig(merged, file.path === target.path ? nextTargetConfig : file.config),
          {}
        );
        if (!files.some((file) => file.path === target.path)) {
          effectiveConfig = mergeOpenCodeConfig(effectiveConfig, nextTargetConfig);
        }
        const currentRouting = this.normalizeOpenCodeModelRouting(effectiveConfig);
        await this.callbacks.refreshOpenCodeConfig?.(
          previousRouting,
          currentRouting,
          workspacePath
        );
        return { kind: 'complete' as const, routing: currentRouting };
      });
      if (result.kind === 'complete') return result.routing;
      snapshot = result.snapshot;
    }
  }

  private async updateOpenCodeProjectPermission(permission: string, patterns: string[]) {
    let snapshot = await this.readOpenCodeConfigObject();
    while (true) {
      const lockPath = getCanonicalOpenCodeConfigPath(snapshot.target.path);
      const result = await withOpenCodeConfigUpdateLock(lockPath, async () => {
        const currentSnapshot = await this.readOpenCodeConfigObject();
        const { target } = currentSnapshot;
        if (getCanonicalOpenCodeConfigPath(target.path) !== lockPath) {
          return { kind: 'retry' as const, snapshot: currentSnapshot };
        }

        const dirtyDocument = vscode.workspace.textDocuments.find(
          (document) =>
            document.isDirty &&
            (document.uri.toString() === target.uri.toString() ||
              isSameWorkspacePath(document.uri.fsPath, target.uri.fsPath))
        );
        if (dirtyDocument) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} has unsaved changes; save or revert the document before updating permissions`
          );
        }

        const initialStat = await this.readConfigStat(target.uri);
        let nextRaw = target.raw.trim() ? target.raw : '{}\n';
        if (typeof target.config.$schema !== 'string' || !target.config.$schema.trim()) {
          nextRaw = applyJsoncChange(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
        }

        const targetPermission = asRecord(target.config.permission)?.[permission];
        const effectivePermission = asRecord(currentSnapshot.config.permission)?.[permission];
        const rules: Record<string, unknown> =
          typeof targetPermission === 'string'
            ? { '*': targetPermission }
            : asRecord(targetPermission)
              ? { ...asRecord(targetPermission) }
              : typeof effectivePermission === 'string'
                ? { '*': effectivePermission }
                : {};
        for (const pattern of patterns) rules[pattern] = 'allow';
        nextRaw = applyJsoncChange(nextRaw, ['permission', permission], rules);

        const latestStat = await this.readConfigStat(target.uri);
        if (!this.areConfigStatsEqual(initialStat, latestStat)) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} changed while updating permissions; please retry`
          );
        }
        const encoded = new TextEncoder().encode(nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`);
        await vscode.workspace.fs.writeFile(target.uri, encoded);
        return { kind: 'complete' as const };
      });
      if (result.kind === 'complete') return;
      snapshot = result.snapshot;
    }
  }

  private normalizeOpenCodePermissionRules(value: unknown): PermissionRule[] {
    const permissions = asRecord(value);
    if (!permissions) return [];
    const rules: PermissionRule[] = [];
    for (const [permission, setting] of Object.entries(permissions)) {
      if (setting === 'allow' || setting === 'ask' || setting === 'deny') {
        rules.push({ permission, pattern: '*', action: setting });
        continue;
      }
      const patterns = asRecord(setting);
      if (!patterns) continue;
      for (const [pattern, action] of Object.entries(patterns)) {
        if (action === 'allow' || action === 'ask' || action === 'deny') {
          rules.push({ permission, pattern, action });
        }
      }
    }
    return rules;
  }

  private normalizeSessionPermissionRules(value: unknown): PermissionRule[] {
    if (!Array.isArray(value)) return [];
    const rules: PermissionRule[] = [];
    for (const item of value) {
      const rule = asRecord(item);
      if (
        typeof rule?.permission !== 'string' ||
        typeof rule.pattern !== 'string' ||
        (rule.action !== 'allow' && rule.action !== 'ask' && rule.action !== 'deny')
      ) {
        continue;
      }
      rules.push({
        permission: rule.permission,
        pattern: rule.pattern,
        action: rule.action,
      });
    }
    return rules;
  }

  private async readServerMemoryPermissions(
    sessionID?: string,
    directory?: string,
    removeID?: string
  ): Promise<OpenCodeServerMemoryPermissions> {
    const project = asRecord(
      await this.requestServer(
        'GET',
        sessionID ? `/session/${encodeURIComponent(sessionID)}` : '/project/current',
        undefined,
        { directory }
      )
    );
    const projectID =
      typeof (sessionID ? project?.projectID : project?.id) === 'string'
        ? sessionID
          ? project?.projectID
          : project?.id
        : '';
    if (typeof projectID !== 'string' || !projectID) throw new Error('Project is unavailable');
    const list = async (): Promise<OpenCodeServerMemoryPermissions> => {
      const legacyRules = [...this.callbacks.getServerMemoryPermissions(projectID)];
      try {
        const response = await this.requestServer(
          'GET',
          `/api/permission/saved?projectID=${encodeURIComponent(projectID)}`,
          undefined,
          { directory }
        );
        const record = asRecord(response);
        const values = Array.isArray(response) ? response : record?.data;
        if (!Array.isArray(values)) {
          return {
            supported: false,
            rules: [],
            reason: 'The OpenCode server returned an unsupported saved-permission response.',
          };
        }
        const savedRules = values.flatMap((value) => {
          const saved = asRecord(value);
          if (
            typeof saved?.id !== 'string' ||
            typeof saved.projectID !== 'string' ||
            typeof saved.action !== 'string' ||
            typeof saved.resource !== 'string'
          ) {
            return [];
          }
          return [
            {
              id: saved.id,
              projectID: saved.projectID,
              permission: saved.action,
              pattern: saved.resource,
            },
          ];
        });
        const observedScopes = new Set(
          legacyRules.map((rule) => `${rule.permission}\0${rule.pattern}`)
        );
        const observedSavedRules = savedRules.filter((rule) =>
          observedScopes.has(`${rule.permission}\0${rule.pattern}`)
        );
        const savedScopes = new Set(
          observedSavedRules.map((rule) => `${rule.permission}\0${rule.pattern}`)
        );
        return {
          supported: true,
          rules: [
            ...observedSavedRules,
            ...legacyRules.filter(
              (rule) => !savedScopes.has(`${rule.permission}\0${rule.pattern}`)
            ),
          ],
        };
      } catch (cause) {
        if (legacyRules.length > 0) return { supported: true, rules: legacyRules };
        return {
          supported: false,
          rules: [],
          reason:
            cause instanceof Error
              ? `Saved permissions are unavailable: ${cause.message}`
              : 'Saved permissions are unavailable on this OpenCode server.',
        };
      }
    };

    const current = await list();
    if (!removeID || !current.supported) return current;
    if (removeID.startsWith('legacy:')) {
      throw new Error('Restart OpenCode to clear this server-memory allowance');
    }
    const removedRule = current.rules.find(
      (rule) => rule.id === removeID && rule.projectID === projectID
    );
    if (!removedRule) {
      throw new Error('Saved permission not found for this project');
    }
    await this.requestServer(
      'DELETE',
      `/api/permission/saved/${encodeURIComponent(removeID)}`,
      undefined,
      { directory }
    );
    this.callbacks.forgetServerMemoryPermission(removedRule);
    return list();
  }

  private async prepareLegacyServerMemoryRules(
    method: string,
    path: string,
    body: unknown,
    directory: string | null | undefined
  ): Promise<OpenCodeServerMemoryPermission[]> {
    if (method !== 'POST' || asRecord(body)?.reply !== 'always') return [];
    const match = new URL(path, 'http://localhost').pathname.match(
      /^\/permission\/([^/]+)\/reply$/
    );
    if (!match?.[1]) return [];

    try {
      const permissionID = decodeURIComponent(match[1]);
      const pending = await this.requestServer('GET', '/permission', undefined, {
        directory: directory ?? undefined,
      });
      if (!Array.isArray(pending)) return [];
      const request = pending
        .map((value) => asRecord(asRecord(value)?.info) ?? asRecord(value))
        .find((value) => {
          const id = value?.id ?? value?.permissionID ?? value?.requestID;
          return id === permissionID;
        });
      const sessionID = typeof request?.sessionID === 'string' ? request.sessionID : '';
      const permission =
        typeof request?.permission === 'string'
          ? request.permission.trim()
          : typeof request?.type === 'string'
            ? request.type.trim()
            : '';
      const patterns = Array.isArray(request?.always)
        ? request.always
            .filter((value): value is string => typeof value === 'string')
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
      if (!sessionID || !permission || patterns.length === 0) return [];
      const session = asRecord(
        await this.requestServer('GET', `/session/${encodeURIComponent(sessionID)}`, undefined, {
          directory: directory ?? undefined,
        })
      );
      const projectID = typeof session?.projectID === 'string' ? session.projectID : '';
      if (!projectID) return [];
      return [...new Set(patterns)].map((pattern, index) => ({
        id: `legacy:${permissionID}:${index}`,
        projectID,
        permission,
        pattern,
        retractable: false,
      }));
    } catch (cause) {
      logger.warn(
        `Could not mirror server-memory permission: ${cause instanceof Error ? cause.message : String(cause)}`
      );
      return [];
    }
  }

  private async readOpenCodePermissionConfig(): Promise<OpenCodePermissionConfig> {
    const snapshot = await this.readOpenCodeConfigObject();
    const targetPath = getCanonicalOpenCodeConfigPath(snapshot.target.path);
    const globalConfig = await this.readGlobalOpenCodePermissionConfig();
    const effectiveConfig = mergeOpenCodeConfig(globalConfig.config, snapshot.config);
    return {
      targetPath: snapshot.target.path,
      projectRules: this.normalizeOpenCodePermissionRules(snapshot.target.config.permission),
      inheritedSources: [
        ...globalConfig.sources,
        ...snapshot.files
          .filter((file) => getCanonicalOpenCodeConfigPath(file.path) !== targetPath)
          .map<OpenCodePermissionConfigSource>((file) => ({
            path: file.path,
            rules: this.normalizeOpenCodePermissionRules(file.config.permission),
            scope: isSameWorkspacePath(
              getOpenCodePathApi(file.path).dirname(file.path),
              snapshot.workspacePath
            )
              ? 'project'
              : 'parent',
          })),
      ]
        .filter((source) => source.rules.length > 0)
        .toReversed(),
      effectiveRules: this.normalizeOpenCodePermissionRules(effectiveConfig.permission),
    };
  }

  private async readGlobalOpenCodePermissionConfig(): Promise<{
    config: Record<string, unknown>;
    sources: OpenCodePermissionConfigSource[];
  }> {
    const configuredPath = process.env.OPENCODE_CONFIG?.trim();
    const paths = [...getOpenCodeConfigPaths(), ...(configuredPath ? [configuredPath] : [])].filter(
      (path, index, values) => values.indexOf(path) === index
    );
    let effectiveConfig: Record<string, unknown> = {};
    const sources: OpenCodePermissionConfigSource[] = [];
    for (const path of paths) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path));
        const config = parseOpenCodeConfig(new TextDecoder().decode(bytes), path);
        effectiveConfig = mergeOpenCodeConfig(effectiveConfig, config);
        sources.push({
          path,
          rules: this.normalizeOpenCodePermissionRules(config.permission),
          scope: 'global',
        });
      } catch {
        // Missing or unreadable optional global config files do not block project settings.
      }
    }
    return { config: effectiveConfig, sources };
  }

  private async updateOpenCodePermissionConfig(
    rules: PermissionRule[]
  ): Promise<OpenCodePermissionConfig> {
    let snapshot = await this.readOpenCodeConfigObject();
    while (true) {
      const lockPath = getCanonicalOpenCodeConfigPath(snapshot.target.path);
      const result = await withOpenCodeConfigUpdateLock(lockPath, async () => {
        const currentSnapshot = await this.readOpenCodeConfigObject();
        const { target } = currentSnapshot;
        if (getCanonicalOpenCodeConfigPath(target.path) !== lockPath) {
          return { kind: 'retry' as const, snapshot: currentSnapshot };
        }
        const dirtyDocument = vscode.workspace.textDocuments.find(
          (document) =>
            document.isDirty &&
            (document.uri.toString() === target.uri.toString() ||
              isSameWorkspacePath(document.uri.fsPath, target.uri.fsPath))
        );
        if (dirtyDocument) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} has unsaved changes; save or revert the document before updating permissions`
          );
        }

        const initialStat = await this.readConfigStat(target.uri);
        let nextRaw = target.raw.trim() ? target.raw : '{}\n';
        if (typeof target.config.$schema !== 'string' || !target.config.$schema.trim()) {
          nextRaw = applyJsoncChange(nextRaw, ['$schema'], 'https://opencode.ai/config.json');
        }
        const permissionConfig: Record<string, Record<string, PermissionRule['action']>> = {};
        for (const rule of rules) {
          (permissionConfig[rule.permission] ??= {})[rule.pattern] = rule.action;
        }
        nextRaw = applyJsoncChange(
          nextRaw,
          ['permission'],
          rules.length > 0 ? permissionConfig : undefined
        );

        const latestStat = await this.readConfigStat(target.uri);
        if (!this.areConfigStatsEqual(initialStat, latestStat)) {
          throw new Error(
            `Project ${target.path.endsWith('.jsonc') ? 'opencode.jsonc' : 'opencode.json'} changed while updating permissions; please retry`
          );
        }
        const encoded = new TextEncoder().encode(nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`);
        await vscode.workspace.fs.writeFile(target.uri, encoded);
        return { kind: 'complete' as const };
      });
      if (result.kind === 'complete') return this.readOpenCodePermissionConfig();
      snapshot = result.snapshot;
    }
  }

  private selectOpenCodeModelRoutingTarget(
    request: Extract<OpenCodeConfigRequest, { kind: 'update' }>,
    snapshot: OpenCodeConfigSnapshot
  ): OpenCodeConfigFile | null {
    if (!request.unset) return snapshot.target;
    return (
      snapshot.files.toReversed().find((file) => {
        const route =
          request.target === 'small_model'
            ? parseModelRoute(file.config.small_model)
            : parseModelRoute(
                asRecord(asRecord(file.config.agent)?.[request.agentName || ''])?.model
              );
        return route?.providerID === request.providerID && route.modelID === request.modelID;
      }) ?? null
    );
  }

  private async readConfigStat(uri: vscode.Uri) {
    try {
      return await vscode.workspace.fs.stat(uri);
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err.code === 'FileNotFound' || err.code === 'ENOENT')
      ) {
        return null;
      }
      throw err;
    }
  }

  private areConfigStatsEqual(left: vscode.FileStat | null, right: vscode.FileStat | null) {
    if (left === null || right === null) {
      return left === right;
    }
    return left.mtime === right.mtime && left.size === right.size;
  }

  private async openPlanDocument(content: string) {
    const normalized = normalizePlanMarkdown(content);
    if (!normalized) {
      throw new Error('Plan content is empty');
    }

    const plansDir = getOpenCodePlansDirectory();
    const filename = getPlanFileName(normalized);
    const directoryUri = vscode.Uri.file(plansDir);
    const fileUri = vscode.Uri.file(`${plansDir}/${filename}`);

    await vscode.workspace.fs.createDirectory(directoryUri);

    try {
      await vscode.workspace.fs.stat(fileUri);
    } catch {
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(`${normalized}\n`));
    }

    await vscode.commands.executeCommand(
      'vscode.openWith',
      fileUri,
      'vscode.markdown.preview.editor'
    );
    return { path: fileUri.fsPath };
  }
}

export function resolveOpenCodeProjectConfigPaths(
  directory: string,
  pathExists: (path: string) => boolean = existsSync
) {
  const files: string[] = [];
  const pathApi = getOpenCodePathApi(directory);
  let current = pathApi.resolve(directory);
  while (true) {
    for (const name of ['opencode.jsonc', 'opencode.json']) {
      const candidate = pathApi.join(current, name);
      if (pathExists(candidate)) files.push(candidate);
    }
    if (pathExists(pathApi.join(current, '.git'))) break;
    const parent = pathApi.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files.toReversed();
}

function getOpenCodePathApi(path: string) {
  // VS Code can expose POSIX paths from remote workspaces even on Windows.
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') ? win32 : posix;
}

function getCanonicalOpenCodeConfigPath(path: string) {
  const pathApi = getOpenCodePathApi(path);
  let resolved = pathApi.resolve(path);
  try {
    resolved = realpathSync.native(resolved);
  } catch {
    try {
      resolved = pathApi.join(
        realpathSync.native(pathApi.dirname(resolved)),
        pathApi.basename(resolved)
      );
    } catch {
      // The target and its parent can both be absent before the first config write.
    }
  }
  return normalizeWorkspaceIdentity(resolved) ?? resolved;
}

async function withOpenCodeConfigUpdateLock<T>(
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = openCodeConfigUpdateLocks.get(path);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  openCodeConfigUpdateLocks.set(path, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (openCodeConfigUpdateLocks.get(path) === current) openCodeConfigUpdateLocks.delete(path);
  }
}

function parseOpenCodeConfig(raw: string, path: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new Error(`Invalid OpenCode config at ${path}: ${printParseErrorCode(errors[0]!.error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`OpenCode config at ${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function mergeOpenCodeConfig(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const current = asRecord(merged[key]);
    const incoming = asRecord(value);
    merged[key] = current && incoming ? mergeOpenCodeConfig(current, incoming) : value;
  }
  return merged;
}

function applyJsoncChange(raw: string, path: (string | number)[], value: unknown) {
  return applyEdits(
    raw,
    modify(raw, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
  );
}

function summarizeSessionDiff(
  value: unknown
): Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'> {
  const record = asRecord(value);
  const candidates = Array.isArray(value)
    ? value
    : record && isDiffRecord(record)
      ? [record]
      : Object.values(record ?? {});
  const relativeFiles = new Set<string>();
  const absoluteFiles = new Set<string>();
  const absoluteFileSuffixes = new Set<string>();
  let fileCount = 0;
  let validDiffs = 0;
  let additions = 0;
  let deletions = 0;

  for (const candidate of candidates) {
    const diff = asRecord(candidate);
    if (!diff || !isDiffRecord(diff)) continue;
    if (typeof diff.file === 'string' && isGeneratedDependencyPath(diff.file)) continue;
    validDiffs += 1;
    if (typeof diff.file === 'string' && diff.file) {
      const file = normalizeSummaryFile(diff.file);
      const absolute = isAbsoluteSummaryFile(file);
      const duplicate = absolute
        ? absoluteFiles.has(file) ||
          getSummaryFileSuffixes(file).some((suffix) => relativeFiles.has(suffix))
        : relativeFiles.has(file) || absoluteFileSuffixes.has(file);
      if (!duplicate) {
        fileCount += 1;
        if (absolute) {
          absoluteFiles.add(file);
          for (const suffix of getSummaryFileSuffixes(file)) absoluteFileSuffixes.add(suffix);
        } else {
          relativeFiles.add(file);
        }
      }
    }
    additions += readDiffLineCount(diff.additions, diff.added);
    deletions += readDiffLineCount(diff.deletions, diff.removed);
  }

  return {
    files: fileCount || validDiffs,
    additions,
    deletions,
  };
}

function normalizeSummaryFile(path: string) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isAbsoluteSummaryFile(path: string) {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

function getSummaryFileSuffixes(path: string): string[] {
  const suffixes: string[] = [];
  for (
    let separator = path.indexOf('/');
    separator !== -1;
    separator = path.indexOf('/', separator + 1)
  ) {
    const suffix = path.slice(separator + 1);
    if (suffix) suffixes.push(suffix);
  }
  return suffixes;
}

function summarizeSessionMessageEdits(
  value: unknown
): Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'> {
  if (!Array.isArray(value)) return { files: 0, additions: 0, deletions: 0 };

  const diffs: Record<string, unknown>[] = [];
  let filesTruncated = false;
  for (const entry of value) {
    const message = asRecord(entry);
    const info = asRecord(message?.info);
    const summary = asRecord(info?.summary);
    if (summary?.diffsOmitted === true || summary?.diffsTruncated === true) filesTruncated = true;
    if (Array.isArray(summary?.diffs)) diffs.push(...summary.diffs.flatMap(asDiffRecord));

    if (!Array.isArray(message?.parts)) continue;
    for (const partValue of message.parts) {
      const part = asRecord(partValue);
      if (part?.type === 'patch' && Array.isArray(part.files)) {
        for (const file of part.files) {
          if (typeof file === 'string' && file && !isGeneratedDependencyPath(file)) {
            diffs.push({ file });
          }
        }
        continue;
      }
      if (part?.type !== 'tool' || typeof part.tool !== 'string') continue;

      const state = asRecord(part.state);
      const metadata = asRecord(state?.metadata);
      if (Array.isArray(metadata?.files)) {
        for (const item of metadata.files) {
          const diff = asRecord(item);
          const file = diff && readFirstString(diff, ['relativePath', 'file', 'path', 'filePath']);
          if (!diff || !file || isGeneratedDependencyPath(file)) continue;
          diffs.push({ ...diff, file });
        }
        continue;
      }

      const tool = part.tool.trim().toLowerCase().split('.').pop() || '';
      if (!SESSION_FILE_CHANGE_TOOLS.has(tool)) continue;
      const input = asRecord(state?.input);
      const source = { ...metadata, ...input };
      const file = readFirstString(source, [
        'relativePath',
        'file',
        'path',
        'filePath',
        'filepath',
        'filename',
      ]);
      if (!file || isGeneratedDependencyPath(file)) continue;
      diffs.push({
        file,
        additions: source.additions ?? source.linesAdded,
        deletions: source.deletions ?? source.linesRemoved,
      });
    }
  }
  const summary = summarizeSessionDiff(diffs);
  if (filesTruncated && summary.files === 0) summary.filesTruncated = true;
  return summary;
}

function hasOmittedMessageHistory(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    const info = asRecord(asRecord(entry)?.info);
    return asRecord(info?.summary)?.diffsOmitted === true;
  });
}

function projectMessageHistory(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    const message = asRecord(entry);
    if (!message) return entry;
    const info = projectSummaryDiffs(message.info);
    const parts = Array.isArray(message.parts)
      ? message.parts.map(projectPartFileLists)
      : message.parts;
    return info === message.info && parts === message.parts ? entry : { ...message, info, parts };
  });
}

function omittedMessageHistory() {
  return [
    {
      info: {
        role: 'user',
        time: { created: 0 },
        summary: { diffs: [], diffsOmitted: true, diffsTruncated: true },
      },
      parts: [],
    },
  ];
}

function asDiffRecord(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  return record ? [record] : [];
}

function readFirstString(source: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function hasSessionEdits(
  stats: Omit<SessionDiffSummary, 'tokens' | 'durationMs' | 'activeStartedAt'>
) {
  return (
    stats.filesTruncated === true || stats.files > 0 || stats.additions > 0 || stats.deletions > 0
  );
}

const SESSION_FILE_CHANGE_TOOLS = new Set([
  'apply_patch',
  'edit',
  'write',
  'create',
  'file_edit',
  'file_write',
  'file_create',
  'update_file',
  'replace',
  'insert',
  'apply_edit',
  'apply_diff',
  'delete',
  'remove',
  'unlink',
  'rm',
  'file_delete',
  'file_remove',
  'move',
  'mv',
  'rename',
  'file_move',
  'file_rename',
]);

function summarizeSessionTokenUsage(value: unknown): SessionTokenUsage {
  const usage = emptySessionTokenUsage();
  if (!Array.isArray(value)) return usage;

  for (const entry of value) {
    const info = asRecord(asRecord(entry)?.info);
    if (info?.role !== 'assistant') continue;
    const tokens = asRecord(info.tokens);
    if (!tokens) continue;

    addSessionTokenUsage(usage, summarizeTokenUsageRecord(tokens));
  }
  return usage;
}

function summarizeLocalSession(data: LocalSessionSummaryData): SessionDiffSummary {
  const messages = projectMessageHistory(data.messages);
  const editStats = summarizeSessionMessageEdits(messages);
  const session = summarizeSessionTokenUsage(messages);
  const subagents = emptySessionTokenUsage();
  const contextSessions = [
    {
      messages,
      characters: data.contextCharacters,
      inputTokens: data.contextInputTokens,
    },
  ];

  for (const descendant of data.descendants) {
    const descendantMessages = projectMessageHistory(descendant.messages);
    const snapshot = summarizeTokenUsageRecord(asRecord(descendant.tokens));
    addSessionTokenUsage(
      subagents,
      snapshot.total > 0 ? snapshot : summarizeSessionTokenUsage(descendantMessages)
    );
    contextSessions.push({
      messages: descendantMessages,
      characters: descendant.contextCharacters,
      inputTokens: descendant.contextInputTokens,
    });
  }

  const tokenBreakdown = {
    session,
    subagents,
    subagentCount: data.descendants.length,
  } satisfies SessionTokenBreakdown;
  const result: SessionDiffSummary = {
    ...editStats,
    tokens:
      getSessionTokensExcludingCacheReads(session) + getSessionTokensExcludingCacheReads(subagents),
    tokenBreakdown,
    ...summarizeSessionDuration(messages),
  };
  const model = summarizeSessionModel(messages);
  const nestedContextBreakdown = estimateLocalContextBreakdown(contextSessions);
  if (model) result.model = model;
  if (nestedContextBreakdown.length > 0) result.nestedContextBreakdown = nestedContextBreakdown;
  return result;
}

function estimateLocalContextBreakdown(
  sessions: Array<{
    messages: unknown;
    characters?: ContextCharacterCounts;
    inputTokens?: number;
  }>
) {
  const totals = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
    other: 0,
  } satisfies Record<ContextBreakdownKey, number>;

  for (const session of sessions) {
    const messages = normalizeContextMessages(session.messages);
    let inputTokens = session.inputTokens ?? 0;
    if (session.inputTokens === undefined) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const info = messages[index]?.info;
        const input = info?.role === 'assistant' ? info.tokens?.input : 0;
        if (!input || input <= 0) continue;
        inputTokens = input;
        break;
      }
    }
    const breakdown = session.characters
      ? estimateContextBreakdownFromCharacters(session.characters, inputTokens)
      : estimateNestedContextBreakdown([messages]);
    for (const segment of breakdown) totals[segment.key] += segment.tokens;
  }

  const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return [];
  const keys: ContextBreakdownKey[] = ['system', 'user', 'assistant', 'tool', 'other'];
  return keys
    .filter((key) => totals[key] > 0)
    .map((key) => ({
      key,
      tokens: totals[key],
      percent: Math.round((totals[key] / total) * 1_000) / 10,
    }));
}

function normalizeContextMessages(value: unknown): ContextMessageEntry[] {
  if (!Array.isArray(value)) return [];
  const messages: ContextMessageEntry[] = [];
  for (const valueEntry of value) {
    const entry = asRecord(valueEntry);
    const info = asRecord(entry?.info);
    if (info?.role !== 'user' && info?.role !== 'assistant') continue;
    messages.push({
      info: info as Message,
      parts: Array.isArray(entry?.parts) ? (entry.parts as Part[]) : [],
    });
  }
  return messages;
}

function summarizeTokenUsageRecord(tokens: Record<string, unknown> | undefined): SessionTokenUsage {
  if (!tokens) return emptySessionTokenUsage();
  const cache = asRecord(tokens.cache);
  const usage = {
    total: 0,
    input: readTokenCount(tokens.input),
    output: readTokenCount(tokens.output),
    reasoning: readTokenCount(tokens.reasoning),
    cacheRead: readTokenCount(cache?.read),
    cacheWrite: readTokenCount(cache?.write),
  };
  usage.total =
    isTokenCount(tokens.total) && tokens.total > 0
      ? tokens.total
      : usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
  return usage;
}

function emptySessionTokenUsage(): SessionTokenUsage {
  return { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
}

function getSessionTokensExcludingCacheReads(usage: SessionTokenUsage): number {
  return Math.max(0, usage.total - usage.cacheRead);
}

function addSessionTokenUsage(target: SessionTokenUsage, source: SessionTokenUsage) {
  target.total += source.total;
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
}

function collectDescendantSessions(value: unknown, rootSessionID: string) {
  if (!Array.isArray(value)) return [];
  const childrenByParent = new Map<string, Array<{ id: string; tokens?: unknown }>>();
  for (const item of value) {
    const session = asRecord(item);
    const id = typeof session?.id === 'string' ? session.id : undefined;
    const parentID = typeof session?.parentID === 'string' ? session.parentID : undefined;
    if (!id || !parentID) continue;
    const children = childrenByParent.get(parentID);
    const child = { id, tokens: session?.tokens };
    if (children) children.push(child);
    else childrenByParent.set(parentID, [child]);
  }

  const result: Array<{ id: string; tokens?: unknown }> = [];
  const visited = new Set<string>([rootSessionID]);
  const pending = [...(childrenByParent.get(rootSessionID) || [])];
  while (pending.length > 0) {
    const session = pending.shift();
    if (!session || visited.has(session.id)) continue;
    visited.add(session.id);
    result.push(session);
    pending.push(...(childrenByParent.get(session.id) || []));
  }
  return result;
}

function summarizeSessionModel(value: unknown): SessionDiffSummary['model'] {
  if (!Array.isArray(value)) return undefined;

  let model: SessionDiffSummary['model'];
  for (const entry of value) {
    const info = asRecord(asRecord(entry)?.info);
    if (info?.role !== 'assistant' || info.mode === 'subagent') continue;
    if (typeof info.providerID !== 'string' || typeof info.modelID !== 'string') continue;
    model = {
      providerID: info.providerID,
      modelID: info.modelID,
    };
    if (typeof info.variant === 'string' && info.variant) model.variant = info.variant;
  }
  return model;
}

function summarizeSessionDuration(
  value: unknown
): Pick<SessionDiffSummary, 'durationMs' | 'activeStartedAt'> {
  if (!Array.isArray(value)) return { durationMs: 0, activeStartedAt: null };

  let total = 0;
  let promptStartedAt: number | null = null;
  let firstAssistantCreatedAt: number | null = null;
  let latestCompletedAt: number | null = null;
  let lastAssistantCompleted = false;

  const flush = () => {
    if (lastAssistantCompleted && latestCompletedAt !== null) {
      const startedAt = promptStartedAt ?? firstAssistantCreatedAt;
      if (startedAt !== null) total += Math.max(0, latestCompletedAt - startedAt);
    }
    promptStartedAt = null;
    firstAssistantCreatedAt = null;
    latestCompletedAt = null;
    lastAssistantCompleted = false;
  };

  for (const entry of value) {
    const info = asRecord(asRecord(entry)?.info);
    if (info?.role !== 'assistant') {
      flush();
      if (info?.role === 'user') promptStartedAt = readTimestamp(asRecord(info.time)?.created);
      continue;
    }
    if (info.mode === 'subagent') continue;

    const time = asRecord(info.time);
    firstAssistantCreatedAt ??= readTimestamp(time?.created);
    const completedAt = readTimestamp(time?.completed);
    lastAssistantCompleted = completedAt !== null;
    if (completedAt !== null) {
      latestCompletedAt = Math.max(latestCompletedAt ?? completedAt, completedAt);
    }
  }

  const activeStartedAt = lastAssistantCompleted
    ? null
    : (promptStartedAt ?? firstAssistantCreatedAt);
  flush();
  return { durationMs: total, activeStartedAt };
}

function readTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTokenCount(value: unknown): number {
  return isTokenCount(value) ? value : 0;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isDiffRecord(value: Record<string, unknown>) {
  return (
    typeof value.file === 'string' ||
    isDiffLineCount(value.additions) ||
    isDiffLineCount(value.deletions) ||
    isDiffLineCount(value.added) ||
    isDiffLineCount(value.removed)
  );
}

function readDiffLineCount(primary: unknown, fallback: unknown) {
  if (isDiffLineCount(primary)) return primary;
  return isDiffLineCount(fallback) ? fallback : 0;
}

function isDiffLineCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseDirectSessionID(path: string): string | null {
  const pathname = new URL(path, 'http://localhost').pathname;
  if (pathname === '/session/status') return null;
  const match = pathname.match(/^\/(?:varro\/)?session\/([^/]+)(?:\/|$)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function projectWorkspaceCatalogSession<T extends Record<string, unknown>>(session: T): T {
  const {
    permission: _permission,
    revert: _revert,
    metadata: _metadata,
    path: _path,
    ...catalogSession
  } = session;
  const projectedSession = catalogSession as Record<string, unknown>;
  const summary = asRecord(projectedSession.summary);
  if (summary) {
    const { diffs: _diffs, ...summaryWithoutDiffs } = summary;
    projectedSession.summary = summaryWithoutDiffs;
  }
  return catalogSession as T;
}

function projectWorkspaceCatalogStatus(value: unknown) {
  const status = asRecord(value);
  if (status?.type === 'idle' || status?.type === 'busy') return { type: status.type };
  if (status?.type !== 'retry') return value;
  return {
    type: 'retry',
    attempt: status.attempt,
    next: status.next,
    message: 'Session is retrying',
  };
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && /^404\b/.test(error.message);
}

function raceAgainstAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('API call aborted'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function getExplicitWorkspaceDirectory(path: string): string | null {
  const url = new URL(path, 'http://localhost');
  if (!url.searchParams.has('directory')) return null;
  return url.searchParams.get('directory')?.trim() || null;
}

function setExplicitWorkspaceDirectory(path: string, workspaceDirectory: string): string {
  const url = new URL(path, 'http://localhost');
  url.searchParams.set('directory', workspaceDirectory);
  return `${url.pathname}${url.search}`;
}

function parseApprovedPermissionReferences(value: unknown): AutoApproveJudgeReference[] {
  if (!Array.isArray(value)) return [];
  const references: AutoApproveJudgeReference[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const type = typeof record.type === 'string' ? record.type.trim() : '';
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const response =
      record.response === 'always'
        ? 'always'
        : record.response === 'once'
          ? 'once'
          : record.response === 'reject'
            ? 'reject'
            : null;
    if (!type || !title || !response) continue;
    const patternValue = record.pattern;
    const pattern = Array.isArray(patternValue)
      ? patternValue.filter((entry): entry is string => typeof entry === 'string')
      : typeof patternValue === 'string'
        ? patternValue
        : undefined;
    const metadata = asRecord(record.metadata);
    const reference: AutoApproveJudgeReference = {
      type,
      title,
      response,
    };
    if (pattern !== undefined) reference.pattern = pattern;
    if (metadata) reference.metadata = metadata;
    references.push(reference);
  }
  return references.slice(-20);
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(items.length, Math.max(1, concurrency)) },
    async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await map(items[index]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function isDirectoryInWorkspace(
  directory: unknown,
  workspacePath: string | null | undefined
): boolean {
  if (!normalizeWorkspaceIdentity(workspacePath)) return true;
  return isSameWorkspacePath(typeof directory === 'string' ? directory : undefined, workspacePath);
}

function getSessionActivityTime(session: Record<string, unknown>): number {
  const time = asRecord(session.time);
  return typeof time?.updated === 'number'
    ? time.updated
    : typeof time?.created === 'number'
      ? time.created
      : 0;
}

function isKnownPreAdmissionPromptFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /^4\d{2}(?:\s|$)/.test(message) ||
    message.includes('OpenCode server is not accepting requests while stopping')
  );
}

function isPermissionAutomationRequest(method: string, path: string): boolean {
  if (method !== 'POST') return false;
  const pathname = new URL(path, 'http://localhost').pathname;
  return (
    pathname === VARRO_API_ENDPOINTS.permissionJudge ||
    /^\/permission\/[^/]+\/reply$/.test(pathname)
  );
}

function parseAttentionReplyRequestID(method: string, path: string): string | null {
  if (method !== 'POST') return null;
  const match = new URL(path, 'http://localhost').pathname.match(
    /^\/(?:permission\/([^/]+)\/reply|question\/([^/]+)\/(?:reply|reject))$/
  );
  const requestID = match?.[1] ?? match?.[2];
  return requestID ? decodeURIComponent(requestID) : null;
}
