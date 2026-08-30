/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- REST payloads are untrusted and validated against endpoint contracts before use. */
/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Endpoint assertions follow route-specific runtime validation. */
import * as vscode from 'vscode';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, realpathSync } from 'fs';
import { posix, win32 } from 'path';
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import {
  estimateNestedContextBreakdown,
  type ContextMessageEntry,
} from '../shared/context-breakdown';
import type { Message, Part } from '../shared/opencode-types';
import { parseSessionPromptEndpoint } from '../shared/opencode-endpoints';
import {
  createSessionWorkspaceMetadata,
  getSessionWorkspaceScopeFromMetadata,
  isSessionHistoryScope,
  isSafePersistedSessionId,
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
const SESSION_SUMMARY_CACHE_TTL_MS = 2_000;
const SESSION_SUMMARY_CACHE_LIMIT = 200;
const STATUS_SESSION_CATALOG_REFRESH_MS = 5_000;
const SESSION_MESSAGE_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const SESSION_MESSAGE_FALLBACK_MAX_BYTES = 256 * 1024 * 1024;
const SESSION_MESSAGE_RECOVERY_PAGE_SIZE = 20;
const PERMANENT_DELETION_TOMBSTONE_LIMIT = 256;
const openCodeConfigUpdateLocks = new Map<string, Promise<void>>();

type RecycleBinRequest =
  | { kind: 'list' }
  | { kind: 'empty' }
  | { kind: 'restore'; rootID: string }
  | { kind: 'delete'; rootID: string };

type PermanentDeleteRequest = { sessionID: string };

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

type ResolvedSessionCatalogScope = {
  mode: SessionHistoryScope;
  root: string;
  projectID?: string;
};

type SessionCatalogProject = {
  id: string;
  worktree: string;
  vcs?: string;
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
  simulateNoProviders: boolean;
  getRequestGeneration(): number;
  getStatus(): ServerStatus;
  getSessionHistoryScope?(root: string): SessionHistoryScope;
  getSessionHistoryScopeByKey?(key: string): SessionHistoryScope;
  associateSessionHistoryScope?(root: string, key: string): Promise<void>;
  updateSessionHistoryScope?(key: string, scope: SessionHistoryScope): Promise<void>;
  getWorkspacePath?(): string | null | undefined;
  ensureServerStarted(): Promise<string | undefined>;
  workspaceSessionStatusCoordinator?: WorkspaceSessionStatusCoordinator;
  confirmPromptAdmission(workspacePath: string): Promise<boolean>;
  refreshOpenCodeConfig?(
    previousRouting: OpenCodeModelRouting,
    currentRouting: OpenCodeModelRouting,
    workspacePath: string
  ): Promise<void>;
  cleanupExpiredRecycleBin(): Promise<void>;
  removeSessionImages(sessionIds: Iterable<string>): Promise<void>;
  postApiResponse(requestGeneration: number, payload: ApiResponsePayload): void;
  isPermissionAutomationLeaseCurrent(
    lease: number,
    request: { sessionID?: string; permissionID?: string }
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
    directory?: string
  ): Promise<unknown>;
  activateSession(sessionID: string, directory: string, signal?: AbortSignal): Promise<unknown>;
}

export class RestProxy {
  private readonly requestWorkspaceDirectory = new AsyncLocalStorage<string | undefined>();
  private sessionDirectories = new Map<string, string>();
  private authorizedSessionDirectories = new Map<string, string>();
  private sessionWorkspaceScopes = new Map<string, SessionWorkspaceScope>();
  private workspaceStatusSessionCatalogs = new Map<
    string,
    { loadedAt: number; sessions: WorkspaceSession[] }
  >();
  private readonly workspaceSessionStatusCoordinator: WorkspaceSessionStatusCoordinator;
  private hasSessionDirectorySnapshot = false;
  private sessionDirectoryBootstrapPromise: Promise<ReadonlyMap<string, string>> | null = null;
  private readonly permissionJudgeCleanupRequests = new Set<string>();
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
    this.workspaceStatusSessionCatalogs.clear();
    this.authorizedSessionDirectories.clear();
    this.hasSessionDirectorySnapshot = false;
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

      const queuedHistoryWorkspaceDirectory = queuedHistorySessionID
        ? asRecord(payload.body)?.workspaceDirectory
        : undefined;
      const requestedWorkspaceDirectory =
        getExplicitWorkspaceDirectory(payload.path) ??
        (typeof queuedHistoryWorkspaceDirectory === 'string'
          ? queuedHistoryWorkspaceDirectory.trim() || null
          : null);
      const directSessionID = parseDirectSessionID(payload.path);
      const explicitWorkspaceDirectory = requestedWorkspaceDirectory
        ? directSessionID
          ? this.requireAuthorizedSessionDirectory(directSessionID, requestedWorkspaceDirectory)
          : this.requireOpenWorkspaceRoot(requestedWorkspaceDirectory)
        : null;
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
        Boolean(activationRequest || directSessionID) ||
        requestPathname === '/session' ||
        requestPathname === VARRO_API_ENDPOINTS.sessionHistoryScope ||
        (method === 'GET' && requestPathname === '/session/status');
      if (
        explicitWorkspaceDirectory &&
        endpointWorkspaceDirectory &&
        !isSameWorkspacePath(explicitWorkspaceDirectory, endpointWorkspaceDirectory) &&
        !allowsCrossRootDirectory
      ) {
        throw new Error('Activate the session workspace before accessing directory-scoped data');
      }
      const requestDirectories =
        !explicitWorkspaceDirectory &&
        method === 'GET' &&
        (requestPathname === '/session' || requestPathname === '/session/status')
          ? this.getOpenWorkspaceRoots()
          : [
              explicitWorkspaceDirectory ??
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
      if (explicitWorkspaceDirectory) {
        this.requestWorkspaceDirectory.enterWith(explicitWorkspaceDirectory);
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
        const directory = this.requireAuthorizedSessionDirectory(
          activationRequest.sessionID,
          activationRequest.directory
        );
        const value = await this.callbacks.activateSession(
          activationRequest.sessionID,
          directory,
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
        const data = await this.callbacks.updatePermissionMode(
          permissionModeRequest.sessionID,
          permissionModeRequest.mode,
          directory ?? undefined
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
      const pendingAttentionReconciliation = pendingAttentionKind
        ? this.callbacks.sessionState.beginPendingAttentionReconciliation(
            pendingAttentionKind,
            this.getCurrentWorkspacePath()
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
    if (lease === undefined || !isPermissionAutomationRequest(method, payload.path)) return;
    const pathname = new URL(payload.path, 'http://localhost').pathname;
    const permission = asRecord(asRecord(payload.body)?.permission);
    const replyMatch = pathname.match(/^\/permission\/([^/]+)\/reply$/);
    const request: { sessionID?: string; permissionID?: string } = {};
    if (typeof permission?.sessionID === 'string') request.sessionID = permission.sessionID;
    if (replyMatch?.[1]) request.permissionID = decodeURIComponent(replyMatch[1]);
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
      const url = new URL(path, 'http://localhost');
      const requestedLimit = Number(url.searchParams.get('limit'));
      if (
        Number.isSafeInteger(requestedLimit) &&
        requestedLimit > SESSION_MESSAGE_RECOVERY_PAGE_SIZE
      ) {
        url.searchParams.set('limit', String(SESSION_MESSAGE_RECOVERY_PAGE_SIZE));
        const recoveryPath = `${url.pathname}${url.search}`;
        logger.warn(`Retrying oversized message page with a smaller window: ${recoveryPath}`);
        return this.requestServer(method, recoveryPath, body, options);
      }
      throw err;
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
          rootUrl.searchParams.set(
            'limit',
            String(Math.min(perRootLimit + 1, FULL_SESSION_LIST_LIMIT))
          );
          const response = await this.requestSessionCatalog(
            `${rootUrl.pathname}${rootUrl.search}`,
            scope,
            root,
            signal
          );
          if (!Array.isArray(response)) throw new Error('Malformed session list response');
          const hasMore = response.length > perRootLimit;
          return {
            hasMore,
            sessions: response
              .slice(0, perRootLimit)
              .map((session) => this.validateWorkspaceSession(session, scope))
              .filter((session) => this.isSessionInCatalogScope(session, scope))
              .filter(
                (session) =>
                  !this.isDedicatedWorkspaceDirectory(root) ||
                  this.getSessionWorkspaceScope(session.id) === 'workspace'
              ),
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
      const hasUnavailableRoot = unavailableDirectories.length > 0;
      this.rememberAuthorizedSessions(
        sessions,
        !hasUnavailableRoot &&
          !rootResults.some((result) => result.hasMore) &&
          !this.isConstrainedSessionListRequest('GET', path)
      );
      const catalogSessions = sessions.map((session) =>
        this.projectWorkspaceCatalogSession(session)
      );
      const hasUnfetchedSessions =
        hasUnavailableRoot || rootResults.some((result) => result.hasMore);
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
      if (hasUnavailableRoot) {
        return {
          items: visible.slice(0, requestedLimit),
          hasMore: visible.length > requestedLimit || rootResults.some((result) => result.hasMore),
          incomplete: true,
          unavailableDirectories,
        };
      }
      if (
        visible.length > requestedLimit ||
        !hasUnfetchedSessions ||
        perRootLimit >= FULL_SESSION_LIST_LIMIT
      ) {
        return {
          items: visible.slice(0, requestedLimit),
          hasMore: visible.length > requestedLimit,
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

    const openRootIdentities = new Set(
      roots
        .map((root) => this.getSessionCatalogIdentity(root))
        .filter((identity): identity is string => identity !== null)
    );
    this.workspaceSessionStatusCoordinator.clearCatalogsOutside(openRootIdentities);
    for (const identity of this.workspaceStatusSessionCatalogs.keys()) {
      if (!openRootIdentities.has(identity)) this.workspaceStatusSessionCatalogs.delete(identity);
    }

    const settledResults = await Promise.allSettled(
      roots.map(async (root) => {
        const requestOptions = signal ? { signal, directory: root } : { directory: root };
        const identity = this.getSessionCatalogIdentity(root);
        const cachedCatalog = identity
          ? this.workspaceStatusSessionCatalogs.get(identity)
          : undefined;
        const statusRequest = identity
          ? this.workspaceSessionStatusCoordinator.requestStatus(
              identity,
              () => this.requestServer('GET', '/session/status', undefined, { directory: root }),
              signal
            )
          : this.requestServer('GET', '/session/status', undefined, requestOptions);
        const [statusValue, initialCatalog] = cachedCatalog
          ? [await statusRequest, cachedCatalog]
          : await Promise.all([
              statusRequest,
              this.loadWorkspaceStatusSessionCatalog(root, signal),
            ]);
        if (!statusValue || Array.isArray(statusValue) || typeof statusValue !== 'object') {
          throw new Error('Malformed session status response');
        }
        const knownSessionIDs = new Set(initialCatalog.sessions.map((session) => session.id));
        const hasUnknownStatus = Object.keys(statusValue).some(
          (sessionID) => !knownSessionIDs.has(sessionID)
        );
        const catalog =
          hasUnknownStatus &&
          Date.now() - initialCatalog.loadedAt >= STATUS_SESSION_CATALOG_REFRESH_MS
            ? await this.loadWorkspaceStatusSessionCatalog(root, signal, true)
            : initialCatalog;
        const sessions = catalog.sessions;
        const catalogSessionIDs = new Set(sessions.map((session) => session.id));
        const visibleIDs = new Set(
          this.filterWorkspaceVisibleSessions(sessions).map((session) => session.id)
        );
        const endpointWorkspaceDirectory =
          this.callbacks.getWorkspacePath?.() ??
          this.callbacks.contextProvider.context.workspacePath ??
          this.callbacks.server.getWorkspaceCwd();
        const exposeFullStatus =
          !endpointWorkspaceDirectory || isSameWorkspacePath(root, endpointWorkspaceDirectory);
        return {
          catalogComplete: Object.keys(statusValue).every((sessionID) =>
            catalogSessionIDs.has(sessionID)
          ),
          sessions,
          statuses: Object.fromEntries(
            Object.entries(statusValue)
              .filter(([sessionID]) => visibleIDs.has(sessionID))
              .map(([sessionID, status]) => [
                sessionID,
                exposeFullStatus ? status : projectWorkspaceCatalogStatus(status),
              ])
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
    this.rememberAuthorizedSessions(
      this.mergeWorkspaceSessions(results.flatMap((result) => result.sessions)),
      results.every((result) => result.catalogComplete)
    );
    return Object.assign({}, ...results.map((result) => result.statuses));
  }

  private async loadWorkspaceStatusSessionCatalog(
    root: string,
    signal?: AbortSignal,
    force = false
  ) {
    const scope = await this.resolveSessionCatalogScope(root, signal);
    const identity = this.getSessionCatalogIdentity(root);
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
    const sessions = sharedCatalog.sessions
      .map((session) => this.validateWorkspaceSession(session, scope))
      .filter((session) => this.isSessionInCatalogScope(session, scope))
      .filter(
        (session) =>
          !this.isDedicatedWorkspaceDirectory(root) ||
          this.getSessionWorkspaceScope(session.id) === 'workspace'
      );
    const catalog = { loadedAt: sharedCatalog.loadedAt, sessions };
    this.rememberAuthorizedSessions(sessions, false);
    if (identity) this.workspaceStatusSessionCatalogs.set(identity, catalog);
    return catalog;
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

  private validateWorkspaceSession(
    value: unknown,
    scope: ResolvedSessionCatalogScope
  ): WorkspaceSession {
    const session = asRecord(value);
    const directoryAllowed =
      scope.mode === 'directory'
        ? isSameWorkspacePath(session?.directory as string | undefined, scope.root)
        : true;
    if (
      !session ||
      typeof session.id !== 'string' ||
      !session.id ||
      typeof session.directory !== 'string' ||
      !directoryAllowed ||
      (scope.projectID !== undefined && session.projectID !== scope.projectID)
    ) {
      throw new Error(
        scope.mode === 'directory'
          ? `OpenCode returned a session outside workspace root ${scope.root}`
          : `OpenCode returned a session outside the configured scope for ${scope.root}`
      );
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
    session: WorkspaceSession,
    scope: ResolvedSessionCatalogScope
  ): boolean {
    return (
      scope.mode !== 'descendants' ||
      getRelativePathWithinWorkspace(session.directory, scope.root) !== null
    );
  }

  private async resolveSessionCatalogScope(
    root: string,
    signal?: AbortSignal
  ): Promise<ResolvedSessionCatalogScope> {
    const mode = this.callbacks.getSessionHistoryScope?.(root) ?? 'directory';
    if (mode === 'directory') return { mode, root };
    if (mode === 'descendants') return { mode, root };
    const project = await this.loadSessionCatalogProject(root, signal);
    if (mode === 'project' && project.vcs === 'git') {
      return { mode, root, projectID: project.id };
    }
    return { mode: 'descendants', root };
  }

  private async loadSessionCatalogProject(
    root: string,
    signal?: AbortSignal
  ): Promise<SessionCatalogProject> {
    const options: OpenCodeRequestOptions = { directory: root };
    if (signal) options.signal = signal;
    const value = asRecord(await this.requestServer('GET', '/project/current', undefined, options));
    if (typeof value?.id !== 'string' || typeof value.worktree !== 'string') {
      throw new Error('Malformed current project response');
    }
    const project: SessionCatalogProject = {
      id: value.id,
      worktree: value.worktree,
    };
    if (typeof value.vcs === 'string') project.vcs = value.vcs;
    return project;
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
    if (scope.mode === 'descendants') {
      url.pathname = '/experimental/session';
      url.searchParams.delete('scope');
      url.searchParams.delete('path');
      return;
    }
    if (scope.mode === 'project') {
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
    if (scope.mode === 'descendants') {
      options.unscoped = true;
      return this.callbacks.server.request('GET', path, undefined, options);
    }
    options.directory = root;
    return this.requestServer('GET', path, undefined, options);
  }

  private getSessionCatalogIdentity(root: string) {
    const identity = normalizeWorkspaceIdentity(root);
    return identity
      ? `${identity}\0${this.callbacks.getSessionHistoryScope?.(root) ?? 'directory'}`
      : null;
  }

  private rememberAuthorizedSessions(sessions: WorkspaceSession[], complete: boolean) {
    const directories = complete
      ? new Map<string, string>()
      : new Map(this.authorizedSessionDirectories);
    for (const session of sessions) directories.set(session.id, session.directory);
    this.authorizedSessionDirectories = directories;
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
  ): { sessionID: string; mode: PermissionMode } | null {
    if (method !== 'POST') return null;
    const url = new URL(path, 'http://localhost');
    const match = url.pathname.match(/^\/varro\/session\/([^/]+)\/permission-mode$/);
    if (!match) return null;
    const record = asRecord(body);
    const mode = record?.mode;
    if (mode !== 'default' && mode !== 'edits' && mode !== 'auto' && mode !== 'full') {
      throw new Error('Invalid permission mode request');
    }
    return { sessionID: decodeURIComponent(match[1]!), mode };
  }

  private async readSessionDiffSummary(sessionID: string): Promise<SessionDiffSummary> {
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
      return cached.request;
    }
    const request = this.requestServer('GET', FULL_SESSION_LIST_PATH).then((sessions) => {
      if (!Array.isArray(sessions)) return sessions;
      const projectedSessions = sessions.map(projectSummaryDiffs);
      this.observePermissionJudgeSessions(projectedSessions);
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
    this.observePermissionJudgeSessions(hiddenSessionSnapshots);
    for (const session of sessions) {
      const info = asRecord(session);
      if (!info) continue;
      this.callbacks.sessionState.handleServerEvent({
        type: 'session.updated',
        properties: { info },
      });
    }
  }

  private observePermissionJudgeSessions(sessions: unknown[]) {
    this.cleanupStalePermissionJudgeSessions(
      this.callbacks.hiddenSessions.observeSessionList(
        sessions.filter(
          (session): session is { id: string } => typeof asRecord(session)?.id === 'string'
        )
      )
    );
  }

  private cleanupStalePermissionJudgeSessions(sessionIDs: string[]) {
    for (const sessionID of sessionIDs) {
      if (this.permissionJudgeCleanupRequests.has(sessionID)) continue;
      this.permissionJudgeCleanupRequests.add(sessionID);
      void this.callbacks.server
        .request('DELETE', `/session/${encodeURIComponent(sessionID)}`, undefined, {
          directory: this.sessionDirectories.get(sessionID),
        })
        .then(
          (deleted) => {
            if (deleted === true) {
              this.callbacks.hiddenSessions.retainUntilDeleted(sessionID);
            } else {
              logger.warn(
                `Failed to delete stale permission judge session ${sessionID}: OpenCode did not confirm deletion`
              );
            }
          },
          (err) => {
            logger.warn(
              `Failed to delete stale permission judge session ${sessionID}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        )
        .finally(() => this.permissionJudgeCleanupRequests.delete(sessionID));
    }
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
      normalizedWorkspacePath
    );
    return requests.filter((request) => visibleSessionIDs.has(request.sessionID));
  }

  private async getVisibleWorkspaceSessionIDs(
    sessionIDs: string[],
    workspacePath: string
  ): Promise<Set<string>> {
    const visible = new Set<string>();
    const unknown: string[] = [];
    for (const sessionID of new Set(sessionIDs)) {
      const match = this.callbacks.sessionState.getSessionWorkspaceMatch(sessionID, workspacePath);
      if (match === true) visible.add(sessionID);
      if (match === undefined) unknown.push(sessionID);
    }
    if (unknown.length === 0) return visible;

    const directories = await this.loadSessionDirectorySnapshot();
    await Promise.all(
      unknown.map(async (sessionID) => {
        const knownDirectory = directories.get(sessionID);
        if (knownDirectory) {
          if (isSameWorkspacePath(knownDirectory, workspacePath)) visible.add(sessionID);
          return;
        }
        try {
          const directory = await this.lookupSessionDirectory(sessionID, workspacePath);
          if (isSameWorkspacePath(directory, workspacePath)) visible.add(sessionID);
        } catch {
          // An unresolved session cannot be assigned to this workspace safely.
        }
      })
    );
    return visible;
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
    if (this.isAuthorizedSessionDirectory(sessionID)) return;
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

  private isDirectoryInSessionCatalogScope(directory: string) {
    try {
      this.requireOpenWorkspaceRoot(directory);
      return true;
    } catch {}
    return this.getOpenWorkspaceRoots().some((root) => {
      return (
        this.callbacks.getSessionHistoryScope?.(root) === 'descendants' &&
        getRelativePathWithinWorkspace(directory, root) !== null
      );
    });
  }

  private isAuthorizedSessionDirectory(sessionID: string, directory?: string) {
    const authorizedDirectory = this.authorizedSessionDirectories.get(sessionID);
    return Boolean(
      authorizedDirectory && (!directory || isSameWorkspacePath(authorizedDirectory, directory))
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
    const scope = getSessionWorkspaceScopeFromMetadata(session.metadata) ?? 'folder';
    if (isSafePersistedSessionId(session.id)) this.sessionWorkspaceScopes.set(session.id, scope);
    return scope;
  }

  private getSessionWorkspaceScope(sessionID: string): SessionWorkspaceScope {
    return this.sessionWorkspaceScopes.get(sessionID) ?? 'folder';
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
    const entries = this.callbacks.sessionTrash
      .list()
      .filter((entry) => this.isDirectoryInSessionCatalogScope(entry.root.directory));
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
    const directory = this.authorizedSessionDirectories.get(sessionID);
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

    const document = await vscode.workspace.openTextDocument(fileUri);
    await vscode.window.showTextDocument(document, { preview: false });
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
  const files: string[] = [];
  let validDiffs = 0;
  let additions = 0;
  let deletions = 0;

  for (const candidate of candidates) {
    const diff = asRecord(candidate);
    if (!diff || !isDiffRecord(diff)) continue;
    if (typeof diff.file === 'string' && isGeneratedDependencyPath(diff.file)) continue;
    validDiffs += 1;
    if (
      typeof diff.file === 'string' &&
      diff.file &&
      !files.some((file) => isSameSummaryFile(file, diff.file as string))
    ) {
      files.push(diff.file);
    }
    additions += readDiffLineCount(diff.additions, diff.added);
    deletions += readDiffLineCount(diff.deletions, diff.removed);
  }

  return {
    files: files.length || validDiffs,
    additions,
    deletions,
  };
}

function isSameSummaryFile(left: string, right: string) {
  const leftPath = normalizeSummaryFile(left);
  const rightPath = normalizeSummaryFile(right);
  if (leftPath === rightPath) return true;

  if (isAbsoluteSummaryFile(leftPath) === isAbsoluteSummaryFile(rightPath)) return false;
  const [absolute, relative] = isAbsoluteSummaryFile(leftPath)
    ? [leftPath, rightPath]
    : [rightPath, leftPath];
  return absolute.endsWith(`/${relative}`);
}

function normalizeSummaryFile(path: string) {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isAbsoluteSummaryFile(path: string) {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
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
