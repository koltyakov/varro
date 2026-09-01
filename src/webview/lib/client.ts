import { apiCall, onMessage, postMessage } from './bridge';
import { validateFileDiffs } from './validate-diffs';
import type {
  Session,
  MessageEntry,
  SessionStatus,
  Agent,
  Command,
  OpenCodeModelRouting,
  Provider,
  FileDiff,
  RepoFileStatus,
  QuestionRequest,
  PermissionRule,
  Permission,
  Todo,
} from '../types';
import type {
  AutoApproveJudgeRequest,
  AutoApproveJudgeResponse,
  ChatModelSelection,
  LspStatus,
  McpStatus,
  PermissionMode,
  ProviderLimitStatus,
  RecycleBinEntry,
  ServerEvent,
  ServerEventName,
  SessionDiffSummary,
  SessionHistoryScope,
  SessionTitleFallbackResponse,
  WorkspaceStatusEventSummary,
  WorkspaceFilePick,
  OpenCodePermissionConfig,
  OpenCodeServerMemoryPermissions,
} from '../../shared/protocol';
import {
  buildVarroSessionEndpoint,
  isSessionHistoryScope,
  VARRO_API_ENDPOINTS,
} from '../../shared/protocol';
import { parseHealthResponse, type HealthResponse } from '../../shared/health';
import { normalizeRecycleBinEntries } from '../../shared/recycle-bin';
import { asRecord, type UnknownRecord } from '../../shared/type-utils';
import { applySessionShareOverride } from './session-share-overrides';
import type {
  ProviderAuthAuthorization,
  ProviderAuthMethodsByProvider,
  WorkspaceStatusEntry,
} from '../../shared/opencode-types';
import { CURRENT_OPENCODE_ENDPOINTS } from '../../shared/opencode-endpoints';
import { isBoolean, isNumber, isString, isObject } from './runtime-values';

export type SessionMessagePage = MessageEntry[] & { nextCursor?: string };
export type SessionListPage = {
  items: Session[];
  hasMore: boolean;
  incomplete?: boolean;
  unavailableDirectories?: string[];
};
export type McpAuthStart = { authorizationUrl: string; oauthState: string };

export const client = {
  async health(): Promise<HealthResponse> {
    const response = parseHealthResponse(await apiCall('GET', CURRENT_OPENCODE_ENDPOINTS.health));
    if (!response) throw malformedResponse(CURRENT_OPENCODE_ENDPOINTS.health, 'a health response');
    return response;
  },

  session: {
    async list(options?: {
      limit?: number;
      search?: string;
      roots?: boolean;
      directory?: string;
      signal?: AbortSignal;
    }): Promise<Session[] | SessionListPage> {
      const params = new URLSearchParams();
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.search) params.set('search', options.search);
      if (options?.roots) params.set('roots', 'true');
      if (options?.directory) params.set('directory', options.directory);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      const path = `/session${query}`;
      const response = options?.signal
        ? await apiCall('GET', path, undefined, { signal: options.signal })
        : await apiCall('GET', path);
      if (!options?.limit) {
        return requireArray<Session>(response, path).map(applySessionShareOverride);
      }
      const page = requireRecord(response, path);
      if (!isBoolean(page.hasMore)) {
        throw malformedResponse(path, 'a session page with a boolean hasMore value');
      }
      if (page.incomplete !== undefined && !isBoolean(page.incomplete)) {
        throw malformedResponse(path, 'a session page with a boolean incomplete value');
      }
      if (
        page.unavailableDirectories !== undefined &&
        (!Array.isArray(page.unavailableDirectories) ||
          !page.unavailableDirectories.every(isString))
      ) {
        throw malformedResponse(path, 'a session page with string unavailableDirectories');
      }
      const result: SessionListPage = {
        items: requireArray<Session>(page.items, path).map(applySessionShareOverride),
        hasMore: page.hasMore,
      };
      if (page.incomplete === true) result.incomplete = true;
      if (Array.isArray(page.unavailableDirectories)) {
        result.unavailableDirectories = page.unavailableDirectories;
      }
      return result;
    },
    async get(id: string, options?: { directory?: string }): Promise<Session> {
      return apiCall<Session>(
        'GET',
        withDirectory(`/session/${encodeURIComponent(id)}`, options?.directory)
      ).then(applySessionShareOverride);
    },
    async activate(
      id: string,
      directory: string,
      options?: { signal?: AbortSignal }
    ): Promise<Session> {
      return apiCall<Session>(
        'POST',
        buildVarroSessionEndpoint(id, 'activate'),
        { directory },
        { signal: options?.signal }
      ).then(applySessionShareOverride);
    },
    async create(
      body?: {
        title?: string;
        permission?: PermissionRule[];
        parentID?: string;
        metadata?: UnknownRecord;
      },
      options?: { directory?: string }
    ): Promise<Session> {
      return apiCall<Session>('POST', withDirectory('/session', options?.directory), body || {});
    },
    async update(
      id: string,
      body: { title?: string; permission?: PermissionRule[] },
      options?: { directory?: string }
    ): Promise<Session> {
      return apiCall(
        'PATCH',
        withDirectory(`/session/${encodeURIComponent(id)}`, options?.directory),
        body
      );
    },
    async fork(id: string, messageID?: string, options?: { directory?: string }): Promise<Session> {
      return apiCall(
        'POST',
        withDirectory(`/session/${encodeURIComponent(id)}/fork`, options?.directory),
        messageID ? { messageID } : undefined
      );
    },
    async delete(id: string, options?: { directory?: string }): Promise<boolean> {
      return apiCall(
        'DELETE',
        withDirectory(`/session/${encodeURIComponent(id)}`, options?.directory)
      );
    },
    async abort(id: string, options?: { directory?: string }): Promise<boolean> {
      return apiCall(
        'POST',
        withDirectory(`/session/${encodeURIComponent(id)}/abort`, options?.directory)
      );
    },
    async share(id: string, options?: { directory?: string }): Promise<Session> {
      return apiCall(
        'POST',
        withDirectory(`/session/${encodeURIComponent(id)}/share`, options?.directory)
      );
    },
    async unshare(id: string, options?: { directory?: string }): Promise<Session> {
      return apiCall(
        'DELETE',
        withDirectory(`/session/${encodeURIComponent(id)}/share`, options?.directory)
      );
    },
    async init(
      id: string,
      body: { messageID: string; providerID: string; modelID: string },
      options?: { directory?: string }
    ): Promise<boolean> {
      return apiCall(
        'POST',
        withDirectory(`/session/${encodeURIComponent(id)}/init`, options?.directory),
        body
      );
    },
    async diff(
      id: string,
      messageID?: string,
      options?: { directory?: string }
    ): Promise<FileDiff[]> {
      const params = new URLSearchParams();
      if (messageID) params.set('messageID', messageID);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return apiCall(
        'GET',
        withDirectory(`/session/${encodeURIComponent(id)}/diff${query}`, options?.directory)
      ).then(validateFileDiffs);
    },
    async status(): Promise<Record<string, SessionStatus>> {
      return getSharedSessionStatus();
    },
    async messages(
      id: string,
      options?: { limit?: number; before?: string; directory?: string }
    ): Promise<SessionMessagePage> {
      const params = new URLSearchParams();
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.before) params.set('before', options.before);
      if (options?.directory) params.set('directory', options.directory);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      const path = `/session/${encodeURIComponent(id)}/message${query}`;
      const response = await apiCall('GET', path);
      if (Array.isArray(response)) {
        // SAFETY: The message endpoint's array form is the legacy SessionMessagePage wire format.
        return response as SessionMessagePage;
      }
      const page = requireRecord(response, path);
      // SAFETY: The surrounding shape or discriminator check establishes the SessionMessagePage contract used below.
      const items = requireArray<MessageEntry>(page.items, path) as SessionMessagePage;
      if (page.nextCursor !== undefined && !isString(page.nextCursor)) {
        throw malformedResponse(path, 'a message page with a string cursor');
      }
      if (page.nextCursor) items.nextCursor = page.nextCursor;
      return items;
    },
    async deleteMessage(
      id: string,
      messageID: string,
      options?: { directory?: string }
    ): Promise<boolean> {
      return apiCall(
        'DELETE',
        withDirectory(
          `/session/${encodeURIComponent(id)}/message/${encodeURIComponent(messageID)}`,
          options?.directory
        )
      );
    },
    async todos(id: string, options?: { directory?: string }): Promise<Todo[]> {
      return apiCall(
        'GET',
        withDirectory(`/session/${encodeURIComponent(id)}/todo`, options?.directory)
      );
    },
    async sendAsync(
      id: string,
      body: {
        messageID?: string;
        parts: Array<{
          type: string;
          text?: string;
          mime?: string;
          filename?: string;
          url?: string;
        }>;
        model?: { providerID: string; modelID: string };
        agent?: string;
        noReply?: boolean;
        delivery?: 'steer' | 'queue';
        variant?: string;
        queuedMessageDispatch?: { itemId: string; lease: number };
      },
      options?: { directory?: string; interruptedRecovery?: true }
    ): Promise<void> {
      // `delivery` is a client-side timing concern, not a server one. "Steer" means
      // inject this prompt into the turn that is already running: opencode's active
      // loop re-reads session history on every step, so a prompt_async sent mid-turn
      // is picked up on the next step. The v2 /api/session/:id/prompt endpoint admits
      // into a separate SessionInput store that the active (v1) loop never consumes,
      // so routing steer there dropped the message instead of steering. Always send
      // through prompt_async; the queue/steer distinction lives entirely in the UI
      // (queue holds the message until idle, steer sends it immediately).
      const { delivery: _delivery, queuedMessageDispatch, ...rest } = body;
      const path = withDirectory(
        CURRENT_OPENCODE_ENDPOINTS.sessionPromptAsync(id),
        options?.directory
      );
      if (queuedMessageDispatch) {
        await apiCall('POST', path, rest, { queuedMessageDispatch });
      } else if (options?.interruptedRecovery) {
        await apiCall('POST', path, rest, { interruptedRecovery: true });
      } else {
        await apiCall('POST', path, rest);
      }
    },
    async respondPermission(
      sessionId: string,
      permissionId: string,
      response: 'once' | 'always' | 'reject',
      options?: { permissionAutomationLease?: number }
    ): Promise<boolean> {
      const path = `/permission/${encodeURIComponent(permissionId)}/reply`;
      const body = { reply: response };
      return options?.permissionAutomationLease === undefined
        ? apiCall('POST', path, body)
        : apiCall('POST', path, body, {
            permissionAutomationLease: options.permissionAutomationLease,
            permissionAutomationSessionID: sessionId,
          });
    },
    async persistProjectPermissionAllow(
      sessionId: string,
      permissionId: string,
      options?: { directory?: string }
    ): Promise<void> {
      await apiCall(
        'POST',
        withDirectory(VARRO_API_ENDPOINTS.permissionProjectAllow, options?.directory),
        { sessionId, permissionId }
      );
    },
    async allowPermissionForSession(
      sessionId: string,
      permissionId: string,
      options?: { directory?: string }
    ): Promise<void> {
      await apiCall(
        'POST',
        withDirectory(VARRO_API_ENDPOINTS.permissionSessionAllow, options?.directory),
        { sessionId, permissionId }
      );
    },
    async getPermissionRulesForSession(
      sessionId: string,
      options?: { directory?: string }
    ): Promise<PermissionRule[]> {
      const params = new URLSearchParams({ sessionId });
      return apiCall(
        'GET',
        withDirectory(
          `${VARRO_API_ENDPOINTS.permissionSessionRules}?${params.toString()}`,
          options?.directory
        )
      );
    },
    async savePermissionRulesForSession(
      sessionId: string,
      rules: PermissionRule[],
      options?: { directory?: string }
    ): Promise<PermissionRule[]> {
      return apiCall(
        'POST',
        withDirectory(VARRO_API_ENDPOINTS.permissionSessionRules, options?.directory),
        { sessionId, rules }
      );
    },
    async revert(
      id: string,
      messageID: string,
      options?: { directory?: string }
    ): Promise<Session> {
      return apiCall(
        'POST',
        withDirectory(`/session/${encodeURIComponent(id)}/revert`, options?.directory),
        { messageID }
      );
    },
    async unrevert(id: string, options?: { directory?: string }): Promise<Session> {
      return apiCall(
        'POST',
        withDirectory(`/session/${encodeURIComponent(id)}/unrevert`, options?.directory)
      );
    },
    async compact(
      id: string,
      model: { providerID: string; modelID: string },
      options?: { directory?: string }
    ): Promise<boolean> {
      return apiCall(
        'POST',
        withDirectory(`/session/${encodeURIComponent(id)}/summarize`, options?.directory),
        model
      );
    },
    async command(
      id: string,
      body: {
        command: string;
        arguments: string;
        messageID?: string;
        agent?: string;
        model?: string;
      },
      options?: { directory?: string }
    ): Promise<MessageEntry> {
      return apiCall(
        'POST',
        withDirectory(`/session/${encodeURIComponent(id)}/command`, options?.directory),
        body
      );
    },
  },

  config: {
    async providers(): Promise<{
      providers: Provider[];
      default: Record<string, string>;
      defaultModel: ChatModelSelection | null | undefined;
    }> {
      const path = '/config/providers';
      const [providerResponse, defaultModel] = await Promise.all([
        apiCall('GET', path),
        // This endpoint is optional and unsupported servers may return their HTML shell.
        apiCall('GET', '/model/default')
          .then(parseDefaultModel)
          .catch(() => undefined),
      ]);
      const response = requireRecord(providerResponse, path);
      return {
        providers: requireArray<Provider>(response.providers, path),
        // SAFETY: The surrounding shape or discriminator check establishes the Record<string, string> contract used below.
        default: requireRecord(response.default, path) as Record<string, string>,
        defaultModel,
      };
    },
    async providerLimit(providerID: string, modelID?: string | null): Promise<ProviderLimitStatus> {
      const params = new URLSearchParams({ providerID });
      if (modelID) params.set('modelID', modelID);
      return apiCall('GET', `${VARRO_API_ENDPOINTS.providerLimit}?${params.toString()}`);
    },
    async providerAuth(): Promise<ProviderAuthMethodsByProvider> {
      const path = '/provider/auth';
      // SAFETY: The surrounding shape or discriminator check establishes the ProviderAuthMethodsByProvider contract used below.
      return requireRecord(await apiCall('GET', path), path) as ProviderAuthMethodsByProvider;
    },
    async providerCatalog(): Promise<{
      all: Provider[];
      default: Record<string, string>;
      connected: string[];
    }> {
      const path = '/provider';
      const response = requireRecord(await apiCall('GET', path), path);
      return {
        all: requireArray<Provider>(response.all, path),
        // SAFETY: The surrounding shape or discriminator check establishes the Record<string, string> contract used below.
        default: requireRecord(response.default, path) as Record<string, string>,
        connected: requireArray<string>(response.connected, path),
      };
    },
    async authorizeProvider(
      body: {
        providerID: string;
        method: number;
        inputs?: Record<string, string>;
      },
      options?: { signal?: AbortSignal }
    ): Promise<ProviderAuthAuthorization> {
      const path = `/provider/${encodeURIComponent(body.providerID)}/oauth/authorize`;
      const requestBody = {
        method: body.method,
        inputs: body.inputs ? body.inputs : undefined,
      };
      return options?.signal
        ? apiCall('POST', path, requestBody, { signal: options.signal })
        : apiCall('POST', path, requestBody);
    },
    async completeProviderAuth(
      body: {
        providerID: string;
        method: number;
        code?: string;
      },
      options?: { signal?: AbortSignal }
    ): Promise<boolean> {
      return apiCall(
        'POST',
        `/provider/${encodeURIComponent(body.providerID)}/oauth/callback`,
        {
          method: body.method,
          code: body.code ? body.code : undefined,
        },
        {
          timeoutMs: 315_000,
          retries: 0,
          signal: options?.signal,
        }
      );
    },
    async connectApiProvider(
      body: {
        providerID: string;
        key: string;
        metadata?: Record<string, string>;
      },
      options?: { signal?: AbortSignal }
    ): Promise<boolean> {
      const path = `/auth/${encodeURIComponent(body.providerID)}`;
      const requestBody = {
        type: 'api',
        key: body.key,
        metadata:
          body.metadata && Object.keys(body.metadata).length > 0 ? body.metadata : undefined,
      };
      return options?.signal
        ? apiCall('PUT', path, requestBody, { signal: options.signal })
        : apiCall('PUT', path, requestBody);
    },
    async disconnectProvider(providerID: string): Promise<boolean> {
      return apiCall('DELETE', `/auth/${encodeURIComponent(providerID)}`);
    },
    async workspaceStatus(): Promise<WorkspaceStatusEntry[]> {
      const path = '/experimental/workspace/status';
      return requireArray<WorkspaceStatusEntry>(await apiCall('GET', path), path);
    },
  },

  varro: {
    sessionHistoryScope: {
      async get(directory: string): Promise<{ scope: SessionHistoryScope; git: boolean }> {
        const params = new URLSearchParams({ directory });
        const path = `${VARRO_API_ENDPOINTS.sessionHistoryScope}?${params.toString()}`;
        const value = asRecord(await apiCall('GET', path));
        if (!isSessionHistoryScope(value?.scope) || !isBoolean(value.git)) {
          throw new Error(`Malformed response from ${path}`);
        }
        return { scope: value.scope, git: value.git };
      },
      async set(
        directory: string,
        scope: SessionHistoryScope
      ): Promise<{ scope: SessionHistoryScope; git: boolean }> {
        const params = new URLSearchParams({ directory });
        const path = `${VARRO_API_ENDPOINTS.sessionHistoryScope}?${params.toString()}`;
        const value = asRecord(await apiCall('POST', path, { scope }));
        if (!isSessionHistoryScope(value?.scope) || !isBoolean(value.git)) {
          throw new Error(`Malformed response from ${path}`);
        }
        return { scope: value.scope, git: value.git };
      },
    },
    session: {
      async deleteImmediately(
        sessionID: string,
        options?: { directory?: string }
      ): Promise<boolean> {
        return apiCall(
          'DELETE',
          withDirectory(buildVarroSessionEndpoint(sessionID, 'delete'), options?.directory)
        );
      },
      async diffSummary(
        sessionID: string,
        revision?: number,
        options?: { directory?: string }
      ): Promise<SessionDiffSummary> {
        const path = buildVarroSessionEndpoint(sessionID, 'diff-summary');
        const revisionPath = revision === undefined ? path : `${path}?revision=${revision}`;
        return apiCall('GET', withDirectory(revisionPath, options?.directory));
      },
      async setPinned(
        sessionID: string,
        pinned: boolean,
        options?: { directory?: string }
      ): Promise<string[]> {
        return apiCall(
          'POST',
          withDirectory(buildVarroSessionEndpoint(sessionID, 'pin'), options?.directory),
          { pinned }
        );
      },
      async renameIfUntitled(
        sessionID: string,
        options?: { directory?: string }
      ): Promise<SessionTitleFallbackResponse> {
        return apiCall(
          'POST',
          withDirectory(
            buildVarroSessionEndpoint(sessionID, 'rename-if-untitled'),
            options?.directory
          )
        );
      },
      async updatePermissionMode(
        sessionID: string,
        mode: PermissionMode,
        options?: { directory?: string; preconfigured?: boolean }
      ): Promise<Session> {
        return apiCall(
          'POST',
          withDirectory(
            buildVarroSessionEndpoint(sessionID, 'permission-mode'),
            options?.directory
          ),
          options?.preconfigured ? { mode, preconfigured: true } : { mode }
        );
      },
    },
    async openPlan(content: string): Promise<{ path: string }> {
      return apiCall('POST', VARRO_API_ENDPOINTS.planOpen, { content });
    },
    async pickWorkspaceFile(): Promise<WorkspaceFilePick | null> {
      return apiCall('GET', VARRO_API_ENDPOINTS.workspaceFilePick);
    },
    async readWorkspaceFile(path: string): Promise<string | null> {
      const params = new URLSearchParams({ path });
      return apiCall('GET', `${VARRO_API_ENDPOINTS.workspaceFile}?${params.toString()}`);
    },
    async resolveWorkspacePath(path: string): Promise<{
      path: string;
      relativePath: string;
      type: 'file' | 'directory';
    } | null> {
      const params = new URLSearchParams({ path });
      return apiCall('GET', `${VARRO_API_ENDPOINTS.workspacePathResolve}?${params.toString()}`);
    },
    async openCodeConfig(): Promise<OpenCodeModelRouting> {
      return apiCall('GET', VARRO_API_ENDPOINTS.openCodeConfig);
    },
    async openCodePermissionConfig(): Promise<OpenCodePermissionConfig> {
      return apiCall('GET', VARRO_API_ENDPOINTS.openCodeConfigPermissions);
    },
    async saveOpenCodePermissionConfig(rules: PermissionRule[]): Promise<OpenCodePermissionConfig> {
      return apiCall('POST', VARRO_API_ENDPOINTS.openCodeConfigPermissions, { rules });
    },
    async serverMemoryPermissions(
      sessionId: string,
      options?: { directory?: string }
    ): Promise<OpenCodeServerMemoryPermissions> {
      const params = new URLSearchParams({ sessionId });
      return apiCall(
        'GET',
        withDirectory(
          `${VARRO_API_ENDPOINTS.permissionServerMemory}?${params.toString()}`,
          options?.directory
        )
      );
    },
    async removeServerMemoryPermission(
      sessionId: string,
      id: string,
      options?: { directory?: string }
    ): Promise<OpenCodeServerMemoryPermissions> {
      return apiCall(
        'DELETE',
        withDirectory(VARRO_API_ENDPOINTS.permissionServerMemory, options?.directory),
        { sessionId, id }
      );
    },
    async saveModelRouting(body: {
      target: 'small_model' | 'agent' | 'commit_message' | 'auto_approve';
      providerID: string;
      modelID: string;
      agentName?: string;
      unset?: boolean;
    }): Promise<OpenCodeModelRouting> {
      return apiCall('POST', VARRO_API_ENDPOINTS.openCodeConfigModelRouting, body);
    },
    async judgePermission(
      body: AutoApproveJudgeRequest,
      options?: { permissionAutomationLease?: number }
    ): Promise<AutoApproveJudgeResponse> {
      return options?.permissionAutomationLease === undefined
        ? apiCall('POST', VARRO_API_ENDPOINTS.permissionJudge, body)
        : apiCall('POST', VARRO_API_ENDPOINTS.permissionJudge, body, {
            permissionAutomationLease: options.permissionAutomationLease,
          });
    },
    async resolveJudgeModel(model?: ChatModelSelection): Promise<ChatModelSelection | null> {
      const params = new URLSearchParams();
      if (model) {
        params.set('providerID', model.providerID);
        params.set('modelID', model.modelID);
        if (model.variant) params.set('variant', model.variant);
      }
      const query = params.size > 0 ? `?${params.toString()}` : '';
      return apiCall('GET', `${VARRO_API_ENDPOINTS.permissionJudgeModel}${query}`);
    },
    recycleBin: {
      async list(): Promise<RecycleBinEntry[]> {
        return normalizeRecycleBinEntries(await apiCall('GET', VARRO_API_ENDPOINTS.sessionTrash));
      },
      async restore(rootID: string): Promise<boolean> {
        return apiCall(
          'POST',
          `${VARRO_API_ENDPOINTS.sessionTrash}/${encodeURIComponent(rootID)}/restore`
        );
      },
      async delete(rootID: string): Promise<boolean> {
        return apiCall(
          'DELETE',
          `${VARRO_API_ENDPOINTS.sessionTrash}/${encodeURIComponent(rootID)}/delete`
        );
      },
      async empty(): Promise<boolean> {
        return apiCall('DELETE', VARRO_API_ENDPOINTS.sessionTrash);
      },
    },
  },

  mcp: {
    async status(): Promise<Record<string, McpStatus>> {
      // SAFETY: The surrounding shape or discriminator check establishes the Record<string, McpStatus> contract used below.
      return requireRecord(await apiCall('GET', '/mcp'), '/mcp') as Record<string, McpStatus>;
    },
    async connect(name: string): Promise<boolean> {
      return apiCall('POST', `/mcp/${encodeURIComponent(name)}/connect`);
    },
    async disconnect(name: string): Promise<boolean> {
      return apiCall('POST', `/mcp/${encodeURIComponent(name)}/disconnect`);
    },
    async authenticate(name: string): Promise<void> {
      return apiCall('POST', `/mcp/${encodeURIComponent(name)}/auth/authenticate`);
    },
    async startAuth(name: string): Promise<McpAuthStart> {
      const path = `/mcp/${encodeURIComponent(name)}/auth`;
      const response = requireRecord(await apiCall('POST', path), path);
      if (!isString(response.authorizationUrl) || !isString(response.oauthState)) {
        throw malformedResponse(path, 'an MCP OAuth authorization response');
      }
      return {
        authorizationUrl: response.authorizationUrl,
        oauthState: response.oauthState,
      };
    },
    async completeAuth(name: string, code: string): Promise<McpStatus> {
      return apiCall('POST', `/mcp/${encodeURIComponent(name)}/auth/callback`, { code });
    },
    async removeAuth(name: string): Promise<{ success: true }> {
      return apiCall('DELETE', `/mcp/${encodeURIComponent(name)}/auth`);
    },
  },

  lsp: {
    async status(): Promise<LspStatus[]> {
      return requireArray<LspStatus>(await apiCall('GET', '/lsp'), '/lsp');
    },
  },

  file: {
    async status(): Promise<RepoFileStatus[]> {
      return getCachedFileStatus();
    },
  },

  agent: {
    async list(): Promise<Agent[]> {
      return requireArray<Agent>(await apiCall('GET', '/agent'), '/agent');
    },
  },

  command: {
    async list(): Promise<Command[]> {
      return requireArray<Command>(await apiCall('GET', '/command'), '/command');
    },
  },

  question: {
    async list(): Promise<QuestionRequest[]> {
      return getSharedQuestionList();
    },
    async reply(requestID: string, answers: Array<Array<string>>): Promise<boolean> {
      return apiCall('POST', `/question/${encodeURIComponent(requestID)}/reply`, { answers });
    },
    async reject(requestID: string): Promise<boolean> {
      return apiCall('POST', `/question/${encodeURIComponent(requestID)}/reject`);
    },
  },

  permission: {
    async list(): Promise<unknown[]> {
      return getSharedPermissionList();
    },
  },
};

function withDirectory(path: string, directory: string | undefined): string {
  if (!directory) return path;
  const url = new URL(path, 'http://varro.local');
  url.searchParams.set('directory', directory);
  return `${url.pathname}${url.search}`;
}

function requireArray<T, V = unknown>(value: V, path: string): T[] {
  if (!Array.isArray(value)) throw malformedResponse(path, 'an array');
  // SAFETY: The surrounding shape or discriminator check establishes the T contract used below.
  return value as T[];
}

function requireRecord<T>(value: T, path: string): UnknownRecord {
  if (!value || !isObject(value) || Array.isArray(value)) {
    throw malformedResponse(path, 'an object');
  }
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  return value as UnknownRecord;
}

function malformedResponse(path: string, expected: string): Error {
  return new Error(`Malformed response from ${path}: expected ${expected}`);
}

function parseDefaultModel<T>(value: T): ChatModelSelection | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const model = requireRecord(value, '/model/default');
  const modelID = isString(model.modelID) ? model.modelID : model.id;
  if (!isString(model.providerID) || !isString(modelID)) {
    throw malformedResponse('/model/default', 'a model selection or null');
  }
  return { providerID: model.providerID, modelID };
}

let fileStatusCache: {
  expiresAt: number;
  promise: Promise<RepoFileStatus[]>;
} | null = null;
type SharedRequestSlot<T> = { current: Promise<T> | null };

const sessionStatusSlot: SharedRequestSlot<Record<string, SessionStatus>> = {
  current: null,
};
const questionListSlot: SharedRequestSlot<QuestionRequest[]> = { current: null };
const permissionListSlot: SharedRequestSlot<Permission[]> = { current: null };

function sharedRequest<T>(
  slot: { current: Promise<T> | null },
  factory: () => Promise<T>
): Promise<T> {
  if (slot.current) return slot.current;
  const promise = factory().finally(() => {
    if (slot.current === promise) slot.current = null;
  });
  slot.current = promise;
  return promise;
}

function getCachedFileStatus(): Promise<RepoFileStatus[]> {
  const now = Date.now();
  if (fileStatusCache && fileStatusCache.expiresAt > now) return fileStatusCache.promise;
  const path = '/vcs/status';
  const promise = apiCall('GET', path)
    .then((response) =>
      requireArray<unknown>(response, path).map((value) => {
        const status = requireRecord(value, path);
        if (
          !isString(status.file) ||
          !isNumber(status.additions) ||
          !isNumber(status.deletions) ||
          (status.status !== 'added' && status.status !== 'deleted' && status.status !== 'modified')
        ) {
          throw malformedResponse(path, 'valid VCS file status entries');
        }
        const fileStatus: RepoFileStatus = {
          path: status.file,
          added: status.additions,
          removed: status.deletions,
          status: status.status,
        };
        return fileStatus;
      })
    )
    .catch((err) => {
      if (fileStatusCache?.promise === promise) fileStatusCache = null;
      throw err;
    });
  fileStatusCache = { expiresAt: now + 2_000, promise };
  return promise;
}

function getSharedSessionStatus(): Promise<Record<string, SessionStatus>> {
  return sharedRequest(sessionStatusSlot, () =>
    apiCall('GET', '/session/status').then(
      // SAFETY: The surrounding shape or discriminator check establishes the Record<string, SessionStatus> contract used below.
      (response) => requireRecord(response, '/session/status') as Record<string, SessionStatus>
    )
  );
}

function getSharedQuestionList(): Promise<QuestionRequest[]> {
  return sharedRequest(questionListSlot, () =>
    apiCall('GET', '/question').then((response) =>
      requireArray<QuestionRequest>(response, '/question')
    )
  );
}

function getSharedPermissionList(): Promise<Permission[]> {
  return sharedRequest(permissionListSlot, () =>
    apiCall('GET', '/permission').then((response) =>
      requireArray<Permission>(response, '/permission')
    )
  );
}

type EventHandler<TEvent extends ServerEvent = ServerEvent> = (data: TEvent) => void;

type ServerEventsApi = {
  on<TEventName extends ServerEventName>(
    type: TEventName,
    handler: EventHandler<Extract<ServerEvent, { type: TEventName }>>
  ): () => void;
  on(type: '*', handler: EventHandler<ServerEvent>): () => void;
};

const eventListeners = new Map<string, Set<EventHandler>>();
const observedEventMetadata = new Map<string, { hasSequence: boolean }>();
const MAX_OBSERVED_EVENT_IDS = 1_024;
let workspaceStatusSummary: WorkspaceStatusEventSummary = { entries: [] };

export function invalidateClientWorkspaceCaches(): void {
  fileStatusCache = null;
  sessionStatusSlot.current = null;
  questionListSlot.current = null;
  permissionListSlot.current = null;
  observedEventMetadata.clear();
  workspaceStatusSummary = { entries: [] };
}

onMessage((msg) => {
  if (msg.type !== 'server/event') return;
  const evt = msg.payload;
  const observed = evt.id ? observedEventMetadata.get(evt.id) : undefined;
  const applyEvent = !evt.id || !observed;
  let dispatchWildcard = applyEvent;
  if (evt.id && !observed) {
    observedEventMetadata.set(evt.id, { hasSequence: evt.seq !== undefined });
    while (observedEventMetadata.size > MAX_OBSERVED_EVENT_IDS) {
      const oldestId = observedEventMetadata.keys().next().value;
      if (oldestId === undefined) break;
      observedEventMetadata.delete(oldestId);
    }
  } else if (observed && !observed.hasSequence && evt.seq !== undefined) {
    observed.hasSequence = true;
    dispatchWildcard = true;
  }
  if (applyEvent && evt.type === 'workspace.status') {
    const entry = normalizeWorkspaceStatusEntry(evt.properties);
    if (entry) {
      const existing = workspaceStatusSummary.entries.find(
        (item) => item.workspaceID === entry.workspaceID
      );
      if (!existing || existing.status !== entry.status) {
        workspaceStatusSummary = {
          ...workspaceStatusSummary,
          entries: [
            ...workspaceStatusSummary.entries.filter(
              (item) => item.workspaceID !== entry.workspaceID
            ),
            entry,
          ],
        };
      }
    }
  }
  if (applyEvent && evt.type === 'workspace.ready') {
    const message = isString(evt.properties?.name) ? evt.properties.name : 'Workspace connected';
    if (
      workspaceStatusSummary.latest?.type !== 'workspace.ready' ||
      workspaceStatusSummary.latest.message !== message
    ) {
      workspaceStatusSummary = {
        ...workspaceStatusSummary,
        latest: { type: 'workspace.ready', message },
      };
    }
  }
  if (applyEvent && evt.type === 'workspace.failed') {
    const message = isString(evt.properties?.message)
      ? evt.properties.message
      : 'Workspace connection failed';
    if (
      workspaceStatusSummary.latest?.type !== 'workspace.failed' ||
      workspaceStatusSummary.latest.message !== message
    ) {
      workspaceStatusSummary = {
        ...workspaceStatusSummary,
        latest: { type: 'workspace.failed', message },
      };
    }
  }
  // SAFETY: The surrounding shape or discriminator check establishes the Set<EventHandler> contract used below.
  const wildcard = eventListeners.get('*') as Set<EventHandler> | undefined;
  if (dispatchWildcard && wildcard) {
    for (const h of wildcard) {
      try {
        h(evt);
      } catch (err) {
        postMessage({
          type: 'log',
          payload: { msg: 'wildcard handler error', error: String(err), level: 'error' },
        });
      }
    }
  }
  // SAFETY: The surrounding shape or discriminator check establishes the Set<EventHandler> contract used below.
  const handlers = eventListeners.get(evt.type) as Set<EventHandler> | undefined;
  if (applyEvent && handlers) {
    for (const h of handlers) {
      try {
        h(evt);
      } catch (err) {
        postMessage({
          type: 'log',
          payload: { msg: 'event handler error', error: String(err), level: 'error' },
        });
      }
    }
  }
});

export const serverEvents: ServerEventsApi = {
  on(type: ServerEventName | '*', handler: EventHandler): () => void {
    if (!eventListeners.has(type)) eventListeners.set(type, new Set());
    eventListeners.get(type)!.add(handler);
    return () => eventListeners.get(type)?.delete(handler);
  },
};

export function getWorkspaceStatusEventSummary() {
  return workspaceStatusSummary;
}

function normalizeWorkspaceStatusEntry<T>(value: T): WorkspaceStatusEntry | null {
  const record = asRecord(value);
  if (!record || !isString(record.workspaceID)) return null;
  if (
    record.status !== 'connected' &&
    record.status !== 'connecting' &&
    record.status !== 'disconnected' &&
    record.status !== 'error'
  ) {
    return null;
  }
  return { workspaceID: record.workspaceID, status: record.status };
}
