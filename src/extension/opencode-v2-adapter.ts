/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/require-safety-comment-for-type-assertion -- HTTP envelopes are validated here; endpoint payload assertions use the pinned released client contract. */
import type {
  AgentInfo,
  CommandInfo,
  FormInfo,
  FormFields,
  IntegrationInfo,
  ModelInfo,
  PermissionRequest,
  ProviderInfo,
  SessionInfo,
  SessionActive,
  SessionMessageInfo,
  SessionMessagesResponse,
  SessionInboxInfo,
  SessionsResponse,
  ModelRef,
  ShellInfo,
  JobInfo,
  SkillInfo,
} from '@opencode/client';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { asRecord, isBoolean, isNumber, isString, type UnknownRecord } from '../shared/type-utils';
import { parseFollowupTitle } from '../shared/followups';
import { compareVersions, extractVersion } from './server-utils';
import { withStartupDeadline } from '../shared/startup';
import { parseSkillAttachment } from '../shared/skill-reference';
import { isNativeFormAnswer, parseNativeForm } from '../shared/native-form';
import { isSameWorkspacePath } from '../shared/workspace-path';
import {
  getPdfDataUrlSize,
  getPdfInputSupport,
  getPdfInputError,
  MAX_NATIVE_PDF_TOTAL_BYTES,
  MAX_NATIVE_PDF_FILENAME_LENGTH,
  NATIVE_PDF_MIME,
} from '../shared/native-pdf';
import {
  MAX_SIDE_QUESTION_LENGTH,
  MAX_SIDE_QUESTION_ANSWER_LENGTH,
  MAX_SIDE_QUESTION_TURNS,
  MAX_SIDE_QUESTION_CONTEXT_LENGTH,
} from '../shared/side-question';
import type { SideQuestionTurn } from '../shared/side-question';
import { tracePrompt } from './prompt-trace';
import type {
  ProviderAuthMethod,
  ProviderAuthPromptCondition,
  ProviderAuthPromptText,
  SessionStatus,
} from '../shared/opencode-types';
import type { OpenCodeRequestOptions } from './open-code-transport';
import { OpenCodeResponseTooLargeError } from './opencode-response-error';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';
import { getOpenCodeApiCapabilities } from './opencode-api-capabilities';
import { OpenCodeV2BackgroundWork } from './opencode-v2-background-work';
import { BACKGROUND_OUTPUT_CHUNK_BYTES } from '../shared/background-process';
import type { BackgroundProcess, BackgroundProcessOutput } from '../shared/background-process';
import { OpenCodeV2GenerationTiming } from './opencode-v2-generation-timing';
import { logger } from './logger';
import {
  projectV2Agent,
  projectV2Form,
  projectV2Message,
  projectV2Model,
  projectV2ModelCost,
  projectV2Permission,
  projectV2Session,
  v1Action,
  v2ModelRef,
  v2Rules,
  isV2TranscriptMessage,
  normalizeV2Error,
  type V2MessageContext,
} from './opencode-v2-projection';

type WireRequest = (
  method: string,
  path: string,
  body?: unknown,
  options?: OpenCodeRequestOptions
) => Promise<unknown>;

function legacyModel(value: unknown): string | undefined {
  if (isString(value)) return value;
  const model = asRecord(value);
  if (!isString(model?.providerID) || !isString(model.model)) return undefined;
  return `${model.providerID}/${model.model}${isString(model.variant) ? `#${model.variant}` : ''}`;
}

function legacyRules(value: unknown): UnknownRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const rule = asRecord(item) ?? {};
    return {
      permission: v1Action(String(rule.action)),
      pattern: rule.resource,
      action: rule.effect,
    };
  });
}

function mergeConfiguration(target: UnknownRecord, patch: UnknownRecord): void {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const record = asRecord(value);
    if (record) {
      const merged = { ...asRecord(target[key]) };
      mergeConfiguration(merged, record);
      target[key] = merged;
    } else target[key] = value;
  }
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && /^404\b/.test(error.message);
}

type V1AuthPromptBase = {
  key: string;
  message: string;
  required?: boolean;
  default?: string;
  hidden?: boolean;
  when?: ProviderAuthPromptCondition[];
};

function connectionInfo(integration: IntegrationInfo | undefined) {
  const connections = integration?.connections ?? [];
  return {
    env: connections.flatMap((connection) => (connection.type === 'env' ? [connection.name] : [])),
    source: connections.some((connection) => connection.type === 'credential')
      ? 'api'
      : connections.some((connection) => connection.type === 'env')
        ? 'env'
        : 'custom',
  };
}

function v1AuthMethods(integration: IntegrationInfo | undefined): ProviderAuthMethod[] {
  return (
    integration?.methods
      .filter((item) => item.type === 'oauth' || item.type === 'key' || item.type === 'external')
      .map((item) => ({
        id: item.type === 'key' ? undefined : item.id,
        type: item.type === 'key' ? 'api' : item.type,
        label: item.label ?? 'API key',
        prompts: item.form?.flatMap<NonNullable<ProviderAuthMethod['prompts']>[number]>((field) => {
          if (field.type === 'external') return [];
          const base: V1AuthPromptBase = {
            key: field.key,
            message: field.title ?? field.description ?? field.key,
            required: field.required === true,
          };
          if (field.hidden) base.hidden = true;
          if (field.default !== undefined && !Array.isArray(field.default))
            base.default = String(field.default);
          if (field.when?.length)
            base.when = field.when.map((condition) => ({
              key: condition.key,
              op: condition.op,
              value: String(condition.value),
            }));
          if (field.type === 'boolean')
            return [
              {
                ...base,
                type: 'select',
                options: [
                  { value: 'true', label: 'Yes' },
                  { value: 'false', label: 'No' },
                ],
              },
            ];
          if (field.type === 'string' && field.options && !field.custom)
            return [
              {
                ...base,
                type: 'select' as const,
                options: field.options.map((option) => ({
                  label: option.label,
                  value: option.value,
                  hint: option.description,
                })),
              },
            ];
          const prompt: ProviderAuthPromptText = { ...base, type: 'text' };
          if (field.type === 'string' && field.placeholder !== undefined)
            prompt.placeholder = field.placeholder;
          return [prompt];
        }),
      })) ?? []
  );
}

function v2AuthAnswers(form: FormFields | undefined, value: unknown) {
  const answer = { ...asRecord(value) };
  // The legacy dialog transports strings. Convert before evaluating typed conditions.
  for (const field of form ?? []) {
    const input = answer[field.key];
    if (!isString(input)) continue;
    if (field.type === 'boolean') {
      if (input !== 'true' && input !== 'false')
        throw new Error(`Invalid boolean answer for ${field.title ?? field.key}`);
      answer[field.key] = input === 'true';
    }
    if (field.type === 'number' || field.type === 'integer') {
      const number = Number(input);
      if (
        !input.trim() ||
        !Number.isFinite(number) ||
        (field.type === 'integer' && !Number.isInteger(number))
      )
        throw new Error(`Invalid ${field.type} answer for ${field.title ?? field.key}`);
      answer[field.key] = number;
    }
  }
  for (const field of form ?? []) {
    if (field.type === 'external' || !field.hidden || answer[field.key] !== undefined) continue;
    if (
      field.when?.some((condition) =>
        condition.op === 'eq'
          ? answer[condition.key] !== condition.value
          : answer[condition.key] === condition.value
      )
    )
      continue;
    if (field.default !== undefined) answer[field.key] = field.default;
  }
  return Object.keys(answer).length > 0 ? answer : value;
}

function nextBackgroundReviewAt(startedAt: number, now: number): number {
  const minutesRunning = Math.max(0, (now - startedAt) / 60_000);
  const nextMinute =
    [5, 10, 20, 30].find((minute) => minute > minutesRunning) ??
    (Math.floor(minutesRunning / 30) + 1) * 30;
  return startedAt + nextMinute * 60_000;
}

function parseBackgroundJobs(value: unknown): JobInfo[] {
  if (!Array.isArray(value)) throw new Error('Invalid OpenCode v2 background-job list');
  for (const item of value) {
    const job = asRecord(item);
    const time = asRecord(job?.time);
    if (
      !job ||
      !isString(job.id) ||
      !isString(job.sessionID) ||
      !isString(job.status) ||
      !['running', 'completed', 'error', 'cancelled'].includes(String(job.status)) ||
      !isNumber(time?.started) ||
      !Number.isFinite(time.started) ||
      (job.title !== undefined && !isString(job.title)) ||
      !(job.kind === 'shell'
        ? isString(job.shellID) && isString(job.command)
        : job.kind === 'subagent'
          ? isString(job.childSessionID) && isString(job.agent) && isString(job.description)
          : job.kind === 'image' && isString(job.path) && isString(job.model))
    )
      throw new Error('Invalid OpenCode v2 background job');
  }
  return value as JobInfo[];
}

export class OpenCodeV2Adapter {
  private readonly backgroundWork = new OpenCodeV2BackgroundWork();
  private readonly backgroundServices: OpenCodeV2SessionState;
  private readonly backgroundJudgments = new Map<string, AbortController>();
  private readonly backgroundReviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly manualServiceChoices = new Set<string>();
  private readonly permissions = new Map<string, string>();
  private readonly forms = new Map<string, FormInfo>();
  private readonly formResponses = new Set<string>();
  private readonly messageParents = new Map<string, string>();
  private readonly contexts = new Map<string, V2MessageContext>();
  private readonly inputTypes = new Map<string, string>();
  private readonly failures = new Map<string, V2MessageContext>();
  private readonly submissions = new Map<string, Promise<unknown>>();
  private readonly foregroundChildProgress = new Map<string, string>();
  private taskControlsGeneration = 0;
  private apiCapabilities: Promise<ReturnType<typeof getOpenCodeApiCapabilities>> | undefined;
  private serverVersion: string | undefined;
  private backgroundJobsAvailable: boolean | undefined;
  private readonly oauth = new Map<
    string,
    {
      integrationID: string;
      attemptID: string;
      providerID: string;
      directory?: string;
      paste: boolean;
    }
  >();

  constructor(
    private readonly wire: WireRequest,
    private readonly annotations = new OpenCodeV2SessionState(),
    private readonly openExternal: (url: string) => Promise<boolean> = async () => false,
    private readonly generationTiming = new OpenCodeV2GenerationTiming(),
    private readonly classifyBackgroundProcess?: (
      shell: ShellInfo,
      directory: string | undefined,
      signal: AbortSignal
    ) => Promise<boolean | null>,
    private readonly backgroundChanged?: (sessionID: string, directory?: string) => Promise<void>
  ) {
    this.backgroundServices = new OpenCodeV2SessionState(
      join(annotations.directory, 'background-services')
    );
  }

  observe(
    type: string,
    data: UnknownRecord,
    eventID?: string,
    eventDirectory?: string,
    created?: unknown,
    sequence?: unknown
  ): void {
    if (type === 'server.connected') {
      this.apiCapabilities = undefined;
      this.backgroundJobsAvailable = undefined;
    }
    this.generationTiming.observe(type, data, created, sequence);
    if ((type === 'shell.exited' || type === 'shell.deleted') && isString(data.id))
      this.cancelBackgroundReview(data.id);
    this.backgroundWork.observe(type, data, eventDirectory);
    if (isString(data.sessionID) && isString(data.assistantMessageID) && isString(data.id)) {
      const key = `${data.sessionID}:${data.assistantMessageID}:${data.id}`;
      if (type === 'session.tool.progress') {
        const metadata = asRecord(data.metadata);
        if (isString(metadata?.sessionID) && metadata.status === 'running') {
          this.foregroundChildProgress.set(key, metadata.sessionID);
          while (this.foregroundChildProgress.size > 4096)
            this.foregroundChildProgress.delete(this.foregroundChildProgress.keys().next().value!);
        }
      }
      if (
        type === 'session.tool.success' ||
        type === 'session.tool.failed' ||
        type === 'session.tool.called'
      )
        this.foregroundChildProgress.delete(key);
    }
    if (isString(data.sessionID)) {
      const context = { ...this.contexts.get(data.sessionID) };
      const directory = asRecord(data.location)?.directory;
      if (isString(directory)) context.directory = directory;
      if (type === 'session.agent.selected' && isString(data.agent)) context.agent = data.agent;
      const model = asRecord(data.model);
      if (type === 'session.model.selected' && isString(model?.id) && isString(model.providerID))
        context.model = model as ModelRef;
      if (type === 'session.inbox.enqueued' && isString(data.inboxID))
        this.inputTypes.set(data.inboxID, String(asRecord(data.item)?.type));
      if (type === 'session.inbox.delivered' && isString(data.inboxID)) {
        if (this.inputTypes.get(data.inboxID) === 'user') {
          context.parentID = data.inboxID;
          context.hasAssistant = false;
        }
        this.inputTypes.delete(data.inboxID);
      }
      if (type === 'session.step.started') context.hasAssistant = true;
      if (type === 'session.execution.failed' && eventID) {
        const error = normalizeV2Error(data.error);
        if (error) this.failures.set(eventID.replace(/^evt_/, 'msg_'), { ...context, error });
      }
      this.contexts.set(data.sessionID, context);
      for (const map of [this.contexts, this.inputTypes, this.failures])
        while (map.size > 4096) map.delete(map.keys().next().value!);
    }
    if (type === 'permission.asked' && isString(data.id) && isString(data.sessionID))
      this.permissions.set(data.id, data.sessionID);
    if (type === 'permission.replied' && isString(data.requestID))
      this.permissions.delete(data.requestID);
    if (type === 'form.created') {
      const form = asRecord(data.form);
      if (
        form &&
        isString(form.id) &&
        isString(form.sessionID) &&
        form.sessionID !== 'global' &&
        Array.isArray(form.fields)
      )
        this.forms.set(form.id, form as FormInfo);
    }
    if ((type === 'form.replied' || type === 'form.cancelled') && isString(data.id))
      this.forms.delete(data.id);
  }

  setServerVersion(version: string | undefined): void {
    const next = version ? (extractVersion(version) ?? undefined) : undefined;
    if (next !== this.serverVersion) this.backgroundJobsAvailable = undefined;
    this.serverVersion = next;
  }

  reset(): void {
    this.serverVersion = undefined;
    this.backgroundJobsAvailable = undefined;
    this.apiCapabilities = undefined;
    for (const controller of this.backgroundJudgments.values()) controller.abort();
    this.backgroundJudgments.clear();
    for (const timer of this.backgroundReviewTimers.values()) clearTimeout(timer);
    this.backgroundReviewTimers.clear();
    this.manualServiceChoices.clear();
    this.generationTiming.reset();
    this.backgroundWork.reset();
    this.permissions.clear();
    this.forms.clear();
    this.messageParents.clear();
    this.contexts.clear();
    this.inputTypes.clear();
    this.failures.clear();
    this.oauth.clear();
    this.foregroundChildProgress.clear();
    this.taskControlsGeneration += 1;
  }

  eventContext(sessionID: string): V2MessageContext | undefined {
    return {
      ...this.contexts.get(sessionID),
      backgroundPending: this.backgroundWork.isWaiting(sessionID),
      backgroundStartedAt: this.backgroundWork.startedAt(sessionID),
      backgroundCommand: this.backgroundWork.command(sessionID),
      backgroundServices: this.backgroundWork.serviceCount(sessionID),
      generationTiming: this.generationTiming,
    };
  }

  async request(
    method: string,
    path: string,
    body: unknown,
    options: OpenCodeRequestOptions = {}
  ): Promise<unknown> {
    options.signal?.throwIfAborted();
    const url = new URL(path, 'http://localhost');
    const route = url.pathname;
    // VS Code lowercases drive letters. OpenCode 2.0.6 can overflow its instruction
    // discovery stack when that differs from the filesystem's uppercase drive.
    const directory = (url.searchParams.get('directory') ?? options.directory)?.replace(
      /^[a-z]:[\\/]/,
      (drive) => drive.toUpperCase()
    );
    const query = (targetPath: string, location = false) => {
      const target = new URL(targetPath, 'http://localhost');
      if (location && directory) target.searchParams.set('location[directory]', directory);
      return target.pathname + target.search;
    };
    const raw = (verb: string, targetPath: string, payload?: unknown) => {
      options.signal?.throwIfAborted();
      return this.wire(verb, targetPath, payload, {
        ...options,
        unscoped: true,
        captureNextCursor: false,
        stripMessageParts: false,
        stripSummaryDiffs: false,
        // Native v2 content is projected below; enforce its wire budget here.
        maxProjectedResponseBytes: options.maxResponseBytes,
        stripToolAttachments: false,
      });
    };
    const data = async <T>(verb: string, targetPath: string, payload?: unknown): Promise<T> => {
      const response = asRecord(await raw(verb, targetPath, payload));
      if (!response || !('data' in response))
        throw new Error(`Invalid OpenCode v2 response for ${targetPath.split('?')[0]}`);
      return response.data as T;
    };
    const input = asRecord(body) ?? {};
    if (method === 'GET' && route === '/openapi.json') return raw('GET', '/openapi.json');

    // Internal callers already use a few native permission endpoints.
    if (route.startsWith('/api/')) return raw(method, query(path, true), body);
    if (method === 'POST' && route === '/global/dispose') {
      await raw('POST', '/api/location/reload');
      return true;
    }
    if (method === 'POST' && route === '/instance/dispose') {
      await raw('DELETE', query('/api/debug/location', true));
      return true;
    }
    if (route === '/agent' && method === 'GET') {
      const agents = (await data<AgentInfo[]>('GET', query('/api/agent', true))).map(
        projectV2Agent
      );
      const config = asRecord(await this.request('GET', '/config', undefined, options));
      for (const [name, value] of Object.entries(asRecord(config?.agent) ?? {})) {
        const agent = asRecord(value);
        if (!agent) continue;
        const existing = agents.findIndex((item) => item.name === name);
        if (agent.disabled === true) {
          if (existing >= 0) agents.splice(existing, 1);
          continue;
        }
        const model = v2ModelRef(agent.model);
        const normalized = {
          mode: 'primary',
          hidden: false,
          ...agents[existing],
          ...agent,
          name,
          options: {
            ...asRecord(agents[existing]?.options),
            ...asRecord(asRecord(agent.request)?.body),
          },
          model: model
            ? {
                providerID: model.providerID,
                modelID: model.id,
                variant: model.variant,
              }
            : agents[existing]?.model,
        };
        if (existing >= 0) agents[existing] = normalized;
        else agents.push(normalized);
      }
      return agents;
    }
    if (route === '/provider' || route === '/config/providers')
      return this.providers(route, directory, options);
    if (route === '/provider/auth') {
      const providers = await data<ProviderInfo[]>('GET', query('/api/provider', true));
      const integrations = await data<IntegrationInfo[]>('GET', query('/api/integration', true));
      return {
        ...Object.fromEntries(
          integrations.map((integration) => [integration.id, v1AuthMethods(integration)])
        ),
        ...Object.fromEntries(
          providers.map((provider) => [
            provider.id,
            v1AuthMethods(
              integrations.find((item) => item.id === (provider.integrationID ?? provider.id))
            ),
          ])
        ),
      };
    }
    if (route === '/model/default') {
      const config = asRecord(await this.request('GET', '/config', undefined, options));
      if (isString(config?.model)) {
        const match = config.model.match(/^([^/]+)\/(.+?)(?:#(.+))?$/);
        if (match) return { providerID: match[1], modelID: match[2], variant: match[3] };
      }
      const model = await data<ModelInfo | null>('GET', query('/api/model/default', true));
      return model ? { providerID: model.providerID, modelID: model.id } : null;
    }
    if (route === '/config' || route === '/global/config') {
      if (method !== 'GET')
        throw new Error('OpenCode v2 configuration updates must target a configuration file');
      const entries = await raw('GET', query('/api/config', true));
      const documents = Array.isArray(entries) ? entries : asRecord(entries)?.data;
      if (!Array.isArray(documents)) throw new Error('Invalid OpenCode v2 configuration response');
      const config: UnknownRecord = {};
      for (const document of documents) {
        const entry = asRecord(document);
        const info = asRecord(entry?.info);
        if (info) mergeConfiguration(config, info);
      }
      const agents = Object.fromEntries(
        Object.entries(asRecord(config.agents) ?? {}).map(([name, value]) => {
          const agent = asRecord(value) ?? {};
          return [
            name,
            {
              ...agent,
              model: legacyModel(agent.model),
              prompt: agent.system,
              permission: legacyRules(agent.permissions),
            },
          ];
        })
      );
      return {
        ...config,
        model: legacyModel(config.model),
        small_model: asRecord(agents.title)?.model,
        agent: agents,
        provider: config.providers,
        command: config.commands,
        permission: legacyRules(config.permissions),
        compaction: {
          ...asRecord(config.compaction),
          reserved: asRecord(config.compaction)?.buffer,
        },
      };
    }
    if (route === '/session/status') {
      const version = this.backgroundWork.snapshotVersion();
      const generation = this.taskControlsGeneration;
      const [active, shells, jobs] = await Promise.all([
        data<Record<string, SessionActive>>('GET', '/api/session/active'),
        data<ShellInfo[]>('GET', query('/api/shell', true)),
        this.readBackgroundJobs((target) => data<unknown>('GET', target), directory),
      ]);
      const nativeShells = [...(jobs?.values() ?? [])].flat().filter((job) => job.kind === 'shell');
      const choices = await this.readBackgroundServiceChoices(
        shells,
        nativeShells.map((job) => job.sessionID)
      );
      options.signal?.throwIfAborted();
      if (generation !== this.taskControlsGeneration)
        throw new Error('OpenCode background status was reset');
      const serviceIDs = new Set([
        ...shells
          .filter(
            (shell) =>
              isString(shell.metadata.sessionID) &&
              choices.get(shell.metadata.sessionID)?.[shell.id] === true
          )
          .map((shell) => shell.id),
        ...nativeShells
          .filter((job) => choices.get(job.sessionID)?.[job.shellID] === true)
          .map((job) => job.shellID),
      ]);
      const waiting = this.backgroundWork.reconcile(
        shells,
        new Set(Object.keys(active)),
        directory,
        version,
        serviceIDs,
        jobs
      );
      for (const shell of shells) {
        const sessionID = shell.metadata.sessionID;
        if (shell.status !== 'running' || !isString(sessionID)) continue;
        const saved = choices.get(sessionID) ?? {};
        const review = asRecord(saved[`review:${shell.id}`]);
        if (saved[`manual:${shell.id}`] === true || (isBoolean(saved[shell.id]) && !review)) {
          this.cancelBackgroundReview(shell.id);
          continue;
        }
        this.scheduleBackgroundJudgment(
          shell,
          sessionID,
          directory,
          isNumber(review?.next) && Number.isFinite(review.next) ? review.next : undefined
        );
      }
      return Object.fromEntries([
        ...Object.entries(active).map(([id, status]) => {
          if (status.type !== 'running')
            throw new Error('Invalid OpenCode v2 active-session status');
          const backgroundServices = this.backgroundWork.serviceCount(id);
          const projected: SessionStatus = { type: 'busy' };
          if (backgroundServices > 0) projected.backgroundServices = backgroundServices;
          return [id, projected];
        }),
        ...waiting.map((id) => {
          const backgroundServices = this.backgroundWork.serviceCount(id);
          const projected: SessionStatus = {
            type: 'busy',
            background: true,
            backgroundStartedAt: this.backgroundWork.startedAt(id),
            backgroundCommand: this.backgroundWork.command(id),
          };
          if (backgroundServices > 0) projected.backgroundServices = backgroundServices;
          return [id, projected];
        }),
        ...this.backgroundWork
          .serviceSessionIDs()
          .filter((id) => !active[id] && !waiting.includes(id))
          .map((id) => [
            id,
            { type: 'idle', backgroundServices: this.backgroundWork.serviceCount(id) },
          ]),
      ]);
    }
    if ((route === '/session' || route === '/experimental/session') && method === 'GET') {
      const target = new URL('/api/session', 'http://localhost');
      for (const key of ['limit', 'search', 'parentID', 'cursor', 'order']) {
        const value = url.searchParams.get(key);
        if (value) target.searchParams.set(key, value);
      }
      // Legacy archived=true includes both states. Native true means archived-only,
      // so do not forward it: usage reports and global history need both states.
      if (route === '/session' && directory) target.searchParams.set('directory', directory);
      if (url.searchParams.get('roots') === 'true') target.searchParams.set('parentID', 'null');
      const result = (await raw('GET', target.pathname + target.search)) as SessionsResponse;
      if (!Array.isArray(result?.data)) throw new Error('Invalid OpenCode v2 session list');
      const sessions = await Promise.all(
        result.data.map((session) => this.session(session, options))
      );
      return options.captureNextCursor
        ? { data: sessions, nextCursor: result.cursor?.next ?? undefined }
        : sessions;
    }
    if (route === '/session' && method === 'POST') {
      const session = await data<SessionInfo>('POST', '/api/session', {
        title: input.title,
        id: input.id,
        metadata: input.metadata,
        permissions: input.permission !== undefined ? v2Rules(input.permission) : undefined,
        model: v2ModelRef(input.model),
        agent: input.agent,
        location: directory ? { directory } : undefined,
      });
      if (input.parentID) await this.annotations.update(session.id, { parentID: input.parentID });
      return this.session(session, options);
    }
    if (route === '/permission' && method === 'GET') {
      const requests = await data<PermissionRequest[]>(
        'GET',
        query('/api/permission/request', true)
      );
      for (const request of requests) this.permissions.set(request.id, request.sessionID);
      return requests.map(projectV2Permission);
    }
    if (route === '/question' && method === 'GET') {
      const forms = await data<FormInfo[]>('GET', query('/api/form', true));
      // MCP elicitation uses a location-owned "global" sentinel, not a session.
      // Leave those forms pending for a client with location-scoped form UI.
      const sessionForms = forms.filter((form) => form.sessionID !== 'global');
      for (const form of sessionForms) this.forms.set(form.id, form);
      return sessionForms.map(projectV2Form);
    }
    const approval = route.match(/^\/(permission|question)\/([^/]+)\/(reply|reject)$/);
    if (approval) {
      const id = decodeURIComponent(approval[2]!);
      const kind = approval[1];
      if (kind === 'permission') {
        if (!this.permissions.has(id)) await this.request('GET', '/permission', undefined, options);
        const sessionID = this.permissions.get(id);
        if (!sessionID) throw new Error(`404 Permission request not found: ${id}`);
        await raw(
          'POST',
          `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(id)}/reply`,
          { decision: input.reply, message: input.message }
        );
        this.permissions.delete(id);
      } else {
        if (!this.forms.has(id)) await this.request('GET', '/question', undefined, options);
        const form = this.forms.get(id);
        if (!form) throw new Error('OpenCode question is no longer pending');
        if (this.formResponses.has(id))
          throw new Error('A response to this native form is already in progress');
        const target = `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(id)}`;
        this.formResponses.add(id);
        try {
          if (approval[3] === 'reject') await raw('DELETE', target);
          else {
            if (
              input.kind !== 'native-form' ||
              input.sessionID !== form.sessionID ||
              !isNativeFormAnswer(input.answer) ||
              Object.keys(input).some((key) => !['kind', 'sessionID', 'answer'].includes(key))
            ) {
              throw new Error('Native forms require keyed, typed answers. Reload the Varro view.');
            }
            const native = parseNativeForm(form);
            if (!native || native.fields.some((field) => field.type === 'unsupported')) {
              throw new Error(
                'This native form contains unsupported fields. Answer in another OpenCode client or skip it.'
              );
            }
            await raw('POST', `${target}/reply`, { answer: input.answer });
          }
          this.forms.delete(id);
        } finally {
          this.formResponses.delete(id);
        }
      }
      return true;
    }
    const sessionRoute = route.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
    if (sessionRoute) {
      const sessionID = decodeURIComponent(sessionRoute[1]!);
      const endpoint = `/api/session/${encodeURIComponent(sessionID)}`;
      const action = sessionRoute[2] ?? '';
      if (
        (action === 'child-task-controls' && method === 'GET') ||
        ((action === 'interrupt-child' || action === 'background-parent') && method === 'POST')
      ) {
        if (body !== undefined) throw new Error('Child task controls do not accept a body');
        const generation = this.taskControlsGeneration;
        const assertTaskConnection = () => {
          options.signal?.throwIfAborted();
          if (generation !== this.taskControlsGeneration)
            throw new Error(
              'Connection changed while managing child work. Refresh before retrying.'
            );
        };
        const child = await data<SessionInfo>('GET', endpoint);
        if (directory && !isSameWorkspacePath(child.location.directory, directory))
          throw new Error('Conversation moved. Refresh before managing this child.');
        const parentID = child.parentID;
        const parentEndpoint = parentID ? `/api/session/${encodeURIComponent(parentID)}` : null;
        if (parentEndpoint) {
          const parent = await data<SessionInfo>('GET', parentEndpoint);
          if (!isSameWorkspacePath(parent.location.directory, child.location.directory))
            throw new Error('Child task controls require parent and child in the same directory');
        }
        const spec = asRecord(await raw('GET', '/openapi.json'));
        const paths = asRecord(spec?.paths);
        const interrupt = asRecord(asRecord(paths?.['/api/session/{sessionID}/interrupt'])?.post);
        const background = asRecord(asRecord(paths?.['/api/session/{sessionID}/background'])?.post);
        const parameters = Array.isArray(interrupt?.parameters) ? interrupt.parameters : [];
        const resume = parameters.map(asRecord).find((entry) => entry?.name === 'resume');
        const resumeSchema = asRecord(resume?.schema);
        const resumeVariants = Array.isArray(resumeSchema?.anyOf)
          ? resumeSchema.anyOf
          : [resumeSchema];
        const supportsNoResume = resumeVariants.some((variant) => {
          const values = asRecord(variant)?.enum;
          return Array.isArray(values) && values.includes('false') && values.includes('true');
        });
        const stopChild = Boolean(
          parentID &&
          interrupt?.operationId === 'session.interrupt' &&
          resume?.in === 'query' &&
          supportsNoResume
        );
        if (action === 'interrupt-child') {
          if (!stopChild) throw new Error('Child-only interruption is unavailable on this server');
          assertTaskConnection();
          // Unlike abort, this neither resolves the root nor deletes background shells.
          const result = asRecord(await raw('POST', `${endpoint}/interrupt?resume=false`, {}));
          assertTaskConnection();
          if (!isBoolean(result?.interrupted))
            throw new Error('Invalid native child interruption acknowledgement');
          return { interrupted: result.interrupted };
        }
        let backgroundEligible = false;
        let messages: SessionMessageInfo[] = [];
        if (parentEndpoint && background?.operationId === 'session.background') {
          messages = await data<SessionMessageInfo[]>(
            'GET',
            `${parentEndpoint}/message?limit=50&order=desc`
          );
          const latest = messages.find((message) => message.type === 'assistant');
          // Native subagent progress establishes a foreground child link. Do not infer
          // eligibility from a shell, a local status, or a compatibility annotation.
          backgroundEligible = Boolean(
            latest?.type === 'assistant' &&
            latest.content.some(
              (part) =>
                part.type === 'tool' &&
                part.name === 'subagent' &&
                part.state.status === 'running' &&
                part.state.input.background !== true &&
                ((part.state.metadata?.sessionID === sessionID &&
                  part.state.metadata?.status === 'running') ||
                  this.foregroundChildProgress.get(`${parentID}:${latest.id}:${part.id}`) ===
                    sessionID)
            )
          );
        }
        assertTaskConnection();
        if (action === 'child-task-controls')
          return {
            parentID: parentID ?? null,
            stopChild,
            backgroundEligible,
            directory: child.location.directory,
          };
        if (!backgroundEligible || !parentEndpoint)
          throw new Error('No verified foreground child work is eligible for background handoff');
        const before = new Set(messages.map((message) => message.id));
        const pendingBefore = await data<SessionInboxInfo[]>('GET', `${parentEndpoint}/inbox`);
        for (const item of pendingBefore) before.add(item.id);
        assertTaskConnection();
        await raw('POST', `${parentEndpoint}/background`, {});
        assertTaskConnection();
        // Read admission before projection so delivery between reads cannot hide
        // the native guidance from both snapshots.
        const pendingAfter = await data<SessionInboxInfo[]>('GET', `${parentEndpoint}/inbox`);
        const after = await data<SessionMessageInfo[]>(
          'GET',
          `${parentEndpoint}/message?limit=50&order=desc`
        );
        assertTaskConnection();
        // The native route is a no-op if the job finished between inspection and
        // execution. Its durable guidance, not HTTP 204 alone, proves a handoff.
        return {
          backgrounded:
            pendingAfter.some(
              (item) =>
                !before.has(item.id) &&
                item.type === 'synthetic' &&
                item.payload.text.startsWith(
                  'User requested that active blocking work be moved to the background.\n'
                )
            ) ||
            after.some(
              (message) =>
                !before.has(message.id) &&
                message.type === 'synthetic' &&
                message.text.startsWith(
                  'User requested that active blocking work be moved to the background.\n'
                )
            ),
        };
      }
      if (action === 'side-question' && method === 'POST') {
        if (
          Object.keys(input).some((key) => key !== 'question' && key !== 'history') ||
          !isString(input.question) ||
          !input.question.trim() ||
          input.question.length > MAX_SIDE_QUESTION_LENGTH
        ) {
          throw new Error('Invalid side question');
        }
        const history = input.history === undefined ? [] : input.history;
        if (!Array.isArray(history) || history.length >= MAX_SIDE_QUESTION_TURNS) {
          throw new Error('Invalid side-question history');
        }
        const turns: SideQuestionTurn[] = [];
        let contextLength = input.question.length;
        for (const value of history) {
          const turn = asRecord(value);
          if (
            !turn ||
            Object.keys(turn).length !== 2 ||
            !isString(turn.question) ||
            !turn.question.trim() ||
            turn.question.length > MAX_SIDE_QUESTION_LENGTH ||
            !isString(turn.answer) ||
            !turn.answer.trim() ||
            turn.answer.length > MAX_SIDE_QUESTION_ANSWER_LENGTH
          ) {
            throw new Error('Invalid side-question history');
          }
          contextLength += turn.question.length + turn.answer.length;
          turns.push({ question: turn.question, answer: turn.answer });
        }
        if (contextLength > MAX_SIDE_QUESTION_CONTEXT_LENGTH) {
          throw new Error('This side conversation is full. Close it and start another.');
        }
        const canonical = await data<unknown>('GET', endpoint);
        const session = asRecord(canonical);
        const sessionDirectory = asRecord(session?.location)?.directory;
        if (
          session?.id !== sessionID ||
          !isString(sessionDirectory) ||
          (directory && !isSameWorkspacePath(sessionDirectory, directory))
        ) {
          throw new Error(
            'Conversation location changed. Reopen it before asking a side question.'
          );
        }
        const result = await data<unknown>('POST', `${endpoint}/generate`, {
          prompt: await tracePrompt(this, {
            purpose: 'side-question',
            sessionID,
            directory,
            signal: options.signal,
            prompt: [
              'The user is asking a quick side question about the conversation so far.',
              'Answer directly and concisely in Markdown from what you already know.',
              'Do not call any tools and do not take any actions.',
              'File and line references do not imply file contents. Use only included text or existing conversation context, and do not claim to read files.',
              ...(turns.length
                ? [
                    'Previous side questions and answers, for context only:',
                    JSON.stringify(turns),
                    'Answer the following follow-up:',
                  ]
                : []),
              '',
              input.question.trim(),
            ].join('\n'),
          }),
        });
        const text = asRecord(result)?.text;
        if (!isString(text) || !text.trim()) {
          throw new Error('OpenCode returned no answer. Side questions cannot run tools.');
        }
        if (text.length > MAX_SIDE_QUESTION_ANSWER_LENGTH) {
          throw new Error('The side-question answer was too long. Try a narrower question.');
        }
        return { text: text.trim() };
      }
      if (method === 'GET' && action === 'background-process') {
        const shells = await data<ShellInfo[]>('GET', query('/api/shell', true));
        const services = await this.backgroundServices.read(sessionID);
        return shells
          .filter((shell) => shell.metadata.sessionID === sessionID)
          .map((shell): BackgroundProcess => ({
            id: shell.id,
            status: shell.status,
            command: shell.command.slice(0, 16 * 1024),
            cwd: shell.cwd,
            pid: shell.pid,
            exit: shell.exit,
            signal: shell.signal,
            time: shell.time,
            service: services[shell.id] === true || undefined,
          }));
      }
      const backgroundProcess = action.match(/^background-process\/([^/]+)$/);
      if (backgroundProcess && (method === 'PATCH' || method === 'DELETE')) {
        if (method === 'PATCH' && !isBoolean(input.service))
          throw new Error('Background process service must be a boolean');
        const shellID = decodeURIComponent(backgroundProcess[1]!);
        const shellEndpoint = query(`/api/shell/${encodeURIComponent(shellID)}`, true);
        const shell = await data<ShellInfo>('GET', shellEndpoint);
        if (shell.metadata.sessionID !== sessionID)
          throw new Error('404 Background process not found');
        if (method === 'DELETE') {
          // Released v2 APIs have no cancellation-reason parameter. Deletion can still
          // notify the owning session; do not imply that it silently cancels its job.
          await raw('DELETE', shellEndpoint);
          this.cancelBackgroundReview(shellID);
          this.backgroundWork.observe('shell.deleted', { id: shellID }, directory);
          this.notifyBackgroundChange(sessionID, directory);
          return true;
        }
        if (shell.status !== 'running') throw new Error('Background process is no longer running');
        this.manualServiceChoices.add(shellID);
        this.cancelBackgroundReview(shellID);
        this.backgroundWork.observe('shell.created', { info: shell }, directory);
        try {
          await this.backgroundServices.update(
            sessionID,
            { [shellID]: input.service, [`manual:${shellID}`]: true },
            options.signal
          );
        } catch (error) {
          this.manualServiceChoices.delete(shellID);
          this.queueBackgroundReview(shellID, sessionID, directory, Date.now() + 60_000);
          throw error;
        }
        this.backgroundWork.setService(shellID, input.service === true);
        this.notifyBackgroundChange(sessionID, directory);
        return true;
      }
      const backgroundOutput = action.match(/^background-process\/([^/]+)\/output$/);
      if (method === 'GET' && backgroundOutput) {
        const shellID = decodeURIComponent(backgroundOutput[1]!);
        const shellEndpoint = `/api/shell/${encodeURIComponent(shellID)}`;
        const shell = await data<ShellInfo>('GET', query(shellEndpoint, true));
        if (shell.metadata.sessionID !== sessionID)
          throw new Error('404 Background process not found');
        const target = new URL(query(`${shellEndpoint}/output`, true), 'http://localhost');
        const cursor = url.searchParams.get('cursor');
        if (cursor !== null && (!/^\d+$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))
          throw new Error('Invalid background output cursor');
        // On first open, inspect the size then read only the tail. Never transfer a full log.
        target.searchParams.set('cursor', cursor ?? '0');
        target.searchParams.set(
          'limit',
          cursor === null ? '1' : String(BACKGROUND_OUTPUT_CHUNK_BYTES)
        );
        const first = await data<BackgroundProcessOutput>('GET', target.pathname + target.search);
        if (cursor !== null) return first;
        const start = Math.max(0, first.size - BACKGROUND_OUTPUT_CHUNK_BYTES);
        target.searchParams.set('cursor', String(start));
        target.searchParams.set('limit', String(BACKGROUND_OUTPUT_CHUNK_BYTES));
        const output = await data<BackgroundProcessOutput>('GET', target.pathname + target.search);
        return { ...output, truncated: start > 0 || output.truncated };
      }
      const restoreGenerationTiming = async (messages: readonly SessionMessageInfo[]) => {
        try {
          // Timing metadata is optional. Bound annotation reads and admission as
          // well as the log fetch; never wait for its queued disk writes to paint history.
          await withStartupDeadline(
            (signal) =>
              this.generationTiming.restore(
                sessionID,
                messages,
                async (after) => {
                  const log = await this.wire(
                    'GET',
                    `/api/experimental/session/${encodeURIComponent(sessionID)}/log?follow=false&after=${after}`,
                    undefined,
                    {
                      unscoped: true,
                      maxResponseBytes: Math.min(
                        options.maxResponseBytes ?? 2 * 1024 * 1024,
                        2 * 1024 * 1024
                      ),
                      signal,
                    }
                  );
                  if (!isString(log))
                    throw new Error('Invalid OpenCode generation timing log response');
                  return log;
                },
                signal
              ),
            2000,
            'Generation timing lookup',
            options.signal
          );
        } catch (error) {
          options.signal?.throwIfAborted();
          logger.warn(
            `Could not restore optional generation timing: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      };
      if (!action) {
        if (method === 'GET')
          return this.session(await data<SessionInfo>('GET', endpoint), options);
        if (method === 'DELETE') {
          await raw('DELETE', endpoint);
          await this.annotations.remove(sessionID);
          return true;
        }
        if (method === 'PATCH') {
          const time = asRecord(input.time);
          const changesArchive = Boolean(time && Object.hasOwn(time, 'archived'));
          if (
            changesArchive &&
            time?.archived !== null &&
            time?.archived !== undefined &&
            (!isNumber(time?.archived) || !Number.isFinite(time.archived))
          )
            throw new Error('Invalid session archive timestamp');
          const nativeArchive =
            changesArchive && (await this.capabilities(options)).sessionArchiving;
          if (input.title !== undefined || input.permission !== undefined || nativeArchive) {
            const nativePatch: UnknownRecord = {
              title: input.title,
              permissions: input.permission !== undefined ? v2Rules(input.permission) : undefined,
            };
            if (nativeArchive) nativePatch.archived = isNumber(time?.archived);
            await raw('PATCH', endpoint, nativePatch);
          }
          const patch: UnknownRecord = {};
          if (input.metadata !== undefined) patch.metadata = input.metadata;
          if (time) {
            const localTime = { ...time };
            if (nativeArchive) delete localTime.archived;
            if (Object.keys(localTime).length) patch.time = localTime;
          }
          if (Object.keys(patch).length)
            await this.annotations.update(sessionID, patch, options.signal);
          return this.session(await data<SessionInfo>('GET', endpoint), options);
        }
      }
      if (action === 'children') {
        const result = (await raw(
          'GET',
          `/api/session?parentID=${encodeURIComponent(sessionID)}&limit=1000`
        )) as SessionsResponse;
        return Promise.all(result.data.map((session) => this.session(session, options)));
      }
      if (action === 'message' && method === 'GET') {
        const target = new URL(`${endpoint}/message`, 'http://localhost');
        target.searchParams.set('order', 'desc');
        const limit = url.searchParams.has('limit')
          ? Number(url.searchParams.get('limit'))
          : Infinity;
        if (!(limit > 0)) throw new Error('Invalid message page limit');
        const collected: SessionMessageInfo[] = [];
        const records: SessionMessageInfo[] = [];
        let cursor = url.searchParams.get('before') ?? undefined;
        const seen = new Set<string>();
        let bytes = 0;
        // Read pending inputs first so delivery between the two reads cannot hide a prompt.
        // Older pages keep their transcript-only boundaries and cursor semantics.
        const inbox = cursor ? [] : await data<SessionInboxInfo[]>('GET', `${endpoint}/inbox`);
        if (!Array.isArray(inbox)) throw new Error('Invalid OpenCode v2 session inbox');
        bytes += Buffer.byteLength(JSON.stringify(inbox));
        do {
          target.searchParams.set('limit', String(Math.min(200, limit - collected.length)));
          if (cursor) {
            target.searchParams.set('cursor', cursor);
            target.searchParams.delete('order');
          }
          const result = (await raw(
            'GET',
            target.pathname + target.search
          )) as SessionMessagesResponse;
          if (!Array.isArray(result?.data)) throw new Error('Invalid OpenCode v2 message page');
          bytes += Buffer.byteLength(JSON.stringify(result.data));
          if (bytes > (options.maxResponseBytes ?? 16 * 1024 * 1024))
            throw new OpenCodeResponseTooLargeError(options.maxResponseBytes ?? 16 * 1024 * 1024);
          records.push(...result.data);
          collected.push(...result.data.filter(isV2TranscriptMessage));
          cursor = result.cursor?.next ?? undefined;
          if (cursor && seen.has(cursor))
            throw new Error('OpenCode repeated a message pagination cursor');
          if (cursor) seen.add(cursor);
        } while (cursor && collected.length < limit);
        const ordered = records.toReversed();
        const firstAssistant = ordered.findIndex(
          (message) =>
            message.type === 'assistant' ||
            message.type === 'skill' ||
            message.type === 'shell' ||
            (message.type === 'idle' &&
              (message.outcome === 'failed' || message.outcome === 'interrupted'))
        );
        const firstUser = ordered.findIndex((message) => message.type === 'user');
        let parent =
          firstAssistant >= 0 ? (this.messageParents.get(ordered[firstAssistant]!.id) ?? '') : '';
        let assistantFailed = false;
        // V2 messages omit parent IDs. Read context outside the page without adding rows or changing its cursor.
        if (!parent && firstAssistant >= 0 && (firstUser < 0 || firstAssistant < firstUser)) {
          let contextCursor = cursor;
          const contextCursors = new Set<string>();
          while (contextCursor) {
            if (contextCursors.has(contextCursor))
              throw new Error('OpenCode repeated a context pagination cursor');
            contextCursors.add(contextCursor);
            const context = (await raw(
              'GET',
              `${endpoint}/message?limit=200&cursor=${encodeURIComponent(contextCursor)}`
            )) as SessionMessagesResponse;
            if (!Array.isArray(context?.data)) throw new Error('Invalid OpenCode v2 context page');
            bytes += Buffer.byteLength(JSON.stringify(context.data));
            if (bytes > (options.maxResponseBytes ?? 16 * 1024 * 1024))
              throw new OpenCodeResponseTooLargeError(options.maxResponseBytes ?? 16 * 1024 * 1024);
            const user = context.data.find((message) => message.type === 'user');
            const preceding = context.data.slice(0, user ? context.data.indexOf(user) : undefined);
            assistantFailed ||= preceding.some(
              (message) => message.type === 'assistant' && !!message.error
            );
            if (user) {
              parent = user.id;
              break;
            }
            if (!context.data.length) break;
            contextCursor = context.cursor?.next ?? undefined;
          }
        }
        const context = { ...this.contexts.get(sessionID) };
        if (!options.stripMessageParts) await restoreGenerationTiming(ordered);
        const messages = ordered.flatMap((message) => {
          if (message.type === 'agent-switched') context.agent = message.agent;
          if (message.type === 'model-switched') context.model = message.model;
          if (!isV2TranscriptMessage(message)) return [];
          if (message.type === 'idle' && message.outcome === 'failed' && assistantFailed) return [];
          const projected = projectV2Message(
            message,
            sessionID,
            directory,
            parent,
            { ...context, ...this.failures.get(message.id) },
            options
          );
          if (message.type === 'user') {
            parent = message.id;
            assistantFailed = false;
          }
          if (message.type === 'assistant' && message.error) assistantFailed = true;
          if (projected.info.role === 'assistant' && parent)
            this.messageParents.set(message.id, parent);
          if (options.stripMessageParts) projected.parts = [];
          else this.generationTiming.apply(projected);
          return [projected];
        });
        while (this.messageParents.size > 4096)
          this.messageParents.delete(this.messageParents.keys().next().value!);
        if (!messages.length && cursor) {
          url.searchParams.set('before', cursor);
          return this.request(method, url.pathname + url.search, body, options);
        }
        const messageIDs = new Set(messages.map((message) => message.info.id));
        for (const item of inbox.toSorted((a, b) => a.time.created - b.time.created)) {
          if (messageIDs.has(item.id)) continue;
          // Restart cancellation notices are admitted without waking an idle owner.
          // Show the canonical notice now, under the same ID it keeps on delivery.
          if (
            item.type === 'synthetic' &&
            item.payload.metadata?.source === 'shell' &&
            item.payload.metadata.state === 'cancelled'
          ) {
            const notice = projectV2Message(
              { ...item.payload, id: item.id, type: 'synthetic', time: item.time },
              sessionID,
              directory,
              '',
              context,
              options
            );
            if (options.stripMessageParts) notice.parts = [];
            messages.push(notice);
            messageIDs.add(item.id);
            continue;
          }
          if (item.type !== 'user') continue;
          const projected = projectV2Message(
            { ...item.payload, id: item.id, type: 'user', time: item.time },
            sessionID,
            directory,
            '',
            context,
            options
          );
          if (options.stripMessageParts) projected.parts = [];
          messages.push(projected);
          projected.info.pendingDelivery = item.delivery;
          messageIDs.add(item.id);
        }
        return options.captureNextCursor ? { data: messages, nextCursor: cursor } : messages;
      }
      if (action.startsWith('message/') && method === 'GET') {
        const message = await data<SessionMessageInfo>('GET', `${endpoint}/${action}`);
        if (!options.stripMessageParts) await restoreGenerationTiming([message]);
        const projected = projectV2Message(
          message,
          sessionID,
          directory,
          this.messageParents.get(message.id),
          this.contexts.get(sessionID),
          options
        );
        this.generationTiming.apply(projected);
        return projected;
      }
      if (action.startsWith('message/') && method === 'DELETE') {
        const messageID = decodeURIComponent(action.slice('message/'.length));
        const notLast = new Error(
          'OpenCode v2 can only delete messages from the end of the transcript'
        );
        let cursor: string | undefined;
        const seen = new Set<string>();
        let bytes = 0;
        let trailingFailure = false;
        let found = false;
        do {
          const page = (await raw(
            'GET',
            `${endpoint}/message?limit=20&${cursor ? `cursor=${encodeURIComponent(cursor)}` : 'order=desc'}`
          )) as SessionMessagesResponse;
          if (!Array.isArray(page?.data)) throw new Error('Invalid OpenCode v2 message page');
          bytes += Buffer.byteLength(JSON.stringify(page.data));
          if (bytes > (options.maxResponseBytes ?? 16 * 1024 * 1024))
            throw new OpenCodeResponseTooLargeError(options.maxResponseBytes ?? 16 * 1024 * 1024);
          for (const message of page.data) {
            if (!isV2TranscriptMessage(message)) continue;
            if (message.id === messageID) {
              // History suppresses failed idle records when the assistant already carries the error.
              if (trailingFailure && !(message.type === 'assistant' && message.error))
                throw notLast;
              found = true;
              break;
            }
            if (message.type !== 'idle' || message.outcome !== 'failed') throw notLast;
            trailingFailure = true;
          }
          if (found) break;
          cursor = page.cursor?.next ?? undefined;
          if (cursor && seen.has(cursor))
            throw new Error('OpenCode repeated a message pagination cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
        if (!found) throw notLast;
        await raw('POST', `${endpoint}/revert/stage`, { messageID, files: false });
        await raw('POST', `${endpoint}/revert/commit`, {});
        return true;
      }
      if (['prompt_async', 'prompt', 'message', 'command'].includes(action) && method === 'POST') {
        return this.submit(sessionID, async () => {
          const model = v2ModelRef(input.model);
          if (model && input.variant !== undefined) model.variant = input.variant;
          const parts = Array.isArray(input.parts)
            ? input.parts.map(asRecord).filter((part) => part !== null)
            : [];
          const pdfs = parts.filter(
            (part) => part.type === 'file' && part.mime === NATIVE_PDF_MIME
          );
          if (pdfs.length) {
            let total = 0;
            for (const pdf of pdfs) {
              const size = isString(pdf.url) ? getPdfDataUrlSize(pdf.url) : null;
              if (
                size === null ||
                !isString(pdf.filename) ||
                !pdf.filename.length ||
                pdf.filename.length > MAX_NATIVE_PDF_FILENAME_LENGTH
              )
                throw new Error('Invalid PDF attachment. Reattach the PDF and try again.');
              total += size;
            }
            if (total > MAX_NATIVE_PDF_TOTAL_BYTES)
              throw new Error('PDFs must total 20 MiB or less.');
            if (action === 'message' && (input.system || input.format)) {
              throw new Error('PDF attachments are not supported by one-shot generation.');
            }
            if (action === 'command') {
              // The command catalog omits model/agent overrides, including child routing.
              throw new Error(
                'PDF input support cannot be verified for configured commands. Send the PDF as a regular prompt with a PDF-capable model.'
              );
            }
            // Admission alone is insufficient: native V2 can replace unsupported media with text.
            // Check the location's authoritative catalog before model changes or revert commits.
            const selected = model ?? (await data<SessionInfo>('GET', endpoint)).model;
            const catalog = await data<ModelInfo[]>('GET', query('/api/model', true)).catch(
              (cause: unknown) => {
                throw new Error(
                  'Cannot verify PDF input support from the backend model catalog. No PDF was submitted. Refresh the catalog or choose another model.',
                  { cause }
                );
              }
            );
            const resolved = selected
              ? (Array.isArray(catalog) ? catalog : []).find(
                  (entry) => entry.providerID === selected.providerID && entry.id === selected.id
                )
              : await data<ModelInfo | null>('GET', query('/api/model/default', true));
            const error = getPdfInputError(getPdfInputSupport(resolved?.capabilities?.input));
            if (error) throw new Error(error);
          }
          const textParts = parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '');
          const attachedSkillIds = [
            ...new Set(
              textParts
                .map((value) => (isString(value) ? parseSkillAttachment(value) : null))
                .filter(isString)
            ),
          ];
          const text = textParts
            .filter((value) => !isString(value) || !parseSkillAttachment(value))
            .join('\n');
          if (action === 'message' && (input.system || input.format)) {
            const format = asRecord(input.format);
            const prompt = [
              input.system,
              textParts.join('\n'),
              format?.type === 'json_schema'
                ? `Return only JSON matching this schema:\n${JSON.stringify(format.schema)}`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n');
            if (model) await raw('POST', `${endpoint}/model`, { model });
            const result = await data<UnknownRecord>('POST', `${endpoint}/generate`, { prompt });
            const response = isString(result.text) ? result.text : '';
            return {
              info: { id: `msg_${randomUUID().replaceAll('-', '')}`, sessionID, role: 'assistant' },
              parts: [{ type: 'text', text: response }],
            };
          }
          if (input.agent) await raw('POST', `${endpoint}/agent`, { agent: input.agent });
          if (model) await raw('POST', `${endpoint}/model`, { model });
          // A staged edit is committed only when the replacement input is submitted.
          const current = await data<SessionInfo>('GET', endpoint);
          if (current.revert) await raw('POST', `${endpoint}/revert/commit`, {});
          // V2 prompt bodies have no system field; keep host context in a replaceable entry.
          if (isString(input.system)) {
            await raw(
              'PUT',
              `/api/experimental/session/${encodeURIComponent(sessionID)}/instructions/entries/varro.system`,
              { value: input.system }
            );
          }
          const followupTitle = parseFollowupTitle(input.followupTitle);
          const metadata: UnknownRecord = {};
          if (input.delivery === 'steer' || input.delivery === 'queue')
            metadata.varroDelivery = input.delivery;
          if (followupTitle) metadata.varroFollowupTitle = followupTitle;
          const payload = {
            id: input.messageID,
            text: action === 'command' ? (input.arguments ?? text) : text,
            files: parts
              .filter((part) => part.type === 'file')
              .map((part) => ({ uri: part.url, name: part.filename })),
            agents: parts
              .filter((part) => part.type === 'agent')
              .map((part) => ({ name: part.name })),
            skills: attachedSkillIds.length ? attachedSkillIds.map((id) => ({ id })) : undefined,
            // Keep the prompt with pending context, including Plan mode's synthetic reminder.
            // Queuing by default lets the reminder run as a separate provider turn.
            delivery: input.delivery === 'queue' ? 'queue' : 'steer',
            metadata: Object.keys(metadata).length ? metadata : undefined,
            resume: input.noReply ? false : undefined,
          };
          if (action === 'command') {
            const commands = await data<CommandInfo[]>('GET', query('/api/command', true));
            if (!commands.some((command) => command.name === input.command)) {
              const skills = await data<SkillInfo[]>('GET', query('/api/skill', true));
              const skill = skills.find((entry) => entry.id === input.command);
              if (skill) {
                await raw('POST', `${endpoint}/prompt`, {
                  ...payload,
                  skills: [...new Set([skill.id, ...attachedSkillIds])].map((id) => ({ id })),
                });
                return;
              }
            }
          }
          const admitted = await raw(
            'POST',
            `${endpoint}/${action === 'command' ? 'command' : 'prompt'}`,
            action === 'command' ? { ...payload, name: input.command } : payload
          );
          // Commands run asynchronously in V2; their messages arrive through events and history.
          if (action === 'command') return;
          if (action === 'prompt_async' || input.noReply) return admitted;
          await raw('POST', `/api/experimental/session/${encodeURIComponent(sessionID)}/wait`, {});
          const messages = await data<SessionMessageInfo[]>(
            'GET',
            `${endpoint}/message?limit=50&order=desc`
          );
          const message = messages.find((candidate) => candidate.type === 'assistant');
          if (!message) throw new Error('OpenCode finished without an assistant message');
          return projectV2Message(message, sessionID, directory);
        });
      }
      if (action === 'abort') {
        if (this.backgroundWork.isWaiting(sessionID)) {
          await Promise.all(
            this.backgroundWork
              .shellIDs(sessionID)
              .map((id) => raw('DELETE', query(`/api/shell/${encodeURIComponent(id)}`, true)))
          );
          this.backgroundWork.clearSession(sessionID);
        }
        await raw('POST', `${endpoint}/interrupt?resume=false`, {});
        return true;
      }
      if (action === 'resume-steering' && method === 'POST') {
        const inbox = await data<SessionInboxInfo[]>('GET', `${endpoint}/inbox`);
        if (!Array.isArray(inbox)) throw new Error('Invalid OpenCode v2 session inbox');
        const pending = inbox.find((item) => item.type === 'user' && item.delivery === 'steer');
        if (!pending) return false;
        // A prompt wake drains queued input too. Interrupt's steer-scoped wake
        // resumes existing steering without admitting input or unpausing queues.
        await raw('POST', `${endpoint}/interrupt?resume=true`, {});
        return true;
      }
      if (action === 'summarize') {
        return this.submit(sessionID, async () => {
          if (isString(input.providerID) && isString(input.modelID)) {
            await raw('POST', `${endpoint}/model`, {
              model: { providerID: input.providerID, id: input.modelID },
            });
          }
          await raw('POST', `${endpoint}/compact`, {});
          return true;
        });
      }
      if (action === 'fork')
        return this.session(
          await data<SessionInfo>('POST', `${endpoint}/fork`, { before: input.messageID }),
          options
        );
      if (action === 'revert') {
        await raw('POST', `${endpoint}/revert/stage`, { messageID: input.messageID, files: true });
        return this.session(await data<SessionInfo>('GET', endpoint), options);
      }
      if (action === 'unrevert') {
        await raw('DELETE', `${endpoint}/revert`);
        return this.session(await data<SessionInfo>('GET', endpoint), options);
      }
      if (action === 'diff')
        return data(
          'GET',
          `${endpoint}/diff${url.searchParams.has('messageID') ? `?from=${encodeURIComponent(url.searchParams.get('messageID')!)}` : ''}`
        );
      if (action === 'todo') {
        const messages = await data<SessionMessageInfo[]>(
          'GET',
          `${endpoint}/message?limit=100&order=desc`
        );
        for (const message of messages) {
          if (message.type !== 'assistant') continue;
          for (const content of message.content.toReversed()) {
            if (
              content.type === 'tool' &&
              content.name === 'todowrite' &&
              content.state.status !== 'streaming' &&
              Array.isArray(content.state.input.todos)
            )
              return content.state.input.todos;
          }
        }
        return [];
      }
    }
    if (route === '/command' && method === 'GET') {
      // The native registry owns precedence, including Markdown/plugin overrides. Config
      // documents are not a command catalog and cannot establish delegation mode.
      const commands = (await data<CommandInfo[]>('GET', query('/api/command', true))).map(
        (command) => ({
          name: command.name,
          description: command.description ?? '',
          source: 'command',
          template: '',
          hints: [],
        })
      );
      const skills = await data<SkillInfo[]>('GET', query('/api/skill', true));
      return [
        ...commands,
        ...skills
          .filter((skill) => !commands.some((command) => command.name === skill.id))
          .map((skill) => ({
            name: skill.id,
            description: skill.description ?? '',
            template: skill.content,
            source: 'skill',
            hints: [],
          })),
      ];
    }
    if (['/skill', '/project', '/vcs', '/vcs/status'].includes(route) && method === 'GET')
      return data('GET', query(`/api${route}`, true));
    if (route === '/project/current' || route === '/path') {
      const location = await raw('GET', query('/api/location', true));
      const record = asRecord(location) ?? {};
      const project = asRecord(record.project) ?? {};
      return route === '/project/current'
        ? { ...project, worktree: project.directory }
        : { directory: record.directory, worktree: project.directory, config: '', state: '' };
    }
    if (route === '/mcp' && method === 'GET') {
      const servers = await data<UnknownRecord[]>('GET', query('/api/mcp', true));
      return Object.fromEntries(servers.map((server) => [String(server.name), server.status]));
    }
    const mcpAuth = route.match(/^\/mcp\/([^/]+)\/auth(?:\/(authenticate|callback))?$/);
    if (mcpAuth) {
      const name = decodeURIComponent(mcpAuth[1]!);
      const servers = await data<UnknownRecord[]>('GET', query('/api/mcp', true));
      const integrationID = servers.find((server) => server.name === name)?.integrationID;
      if (!isString(integrationID))
        throw new Error('This MCP server does not expose an OpenCode authentication integration');
      const key = `mcp:${name}`;
      if (method === 'DELETE') {
        await this.authenticate(key, undefined, method, input, directory, options, integrationID);
        return { success: true };
      }
      if (mcpAuth[2] === 'callback') {
        await this.authenticate(key, 'callback', 'POST', input, directory, options, integrationID);
        return asRecord(await this.request('GET', '/mcp', undefined, options))?.[name];
      }
      const authorization = asRecord(
        await this.authenticate(key, 'authorize', 'POST', input, directory, options, integrationID)
      );
      if (!isString(authorization?.url))
        throw new Error('OpenCode did not provide an MCP authentication URL');
      if (mcpAuth[2] !== 'authenticate') {
        const started = {
          authorizationUrl: authorization.url,
          oauthState: authorization.attemptID,
        };
        return authorization.paste === true ? { ...started, paste: true } : started;
      }
      if (!(await this.openExternal(authorization.url)))
        throw new Error('Could not open the MCP authentication page');
      await this.authenticate(
        key,
        'callback',
        'POST',
        { attemptID: authorization.attemptID },
        directory,
        options,
        integrationID
      );
      return true;
    }
    const mcp = route.match(/^\/mcp\/([^/]+)\/(connect|disconnect)$/);
    if (mcp) {
      await raw('POST', query(`/api/experimental/mcp/${mcp[1]}/${mcp[2]}`, true), {});
      return true;
    }
    if (route === '/lsp') return []; // V2 intentionally has no LSP service.
    if (route === '/experimental/workspace/status') return []; // V2 does not expose legacy workspace warp jobs.
    const auth = route.match(/^\/(?:auth|provider)\/([^/]+)(?:\/oauth\/(authorize|callback))?$/);
    if (auth)
      return this.authenticate(
        decodeURIComponent(auth[1]!),
        auth[2],
        method,
        input,
        directory,
        options
      );
    throw new Error(`OpenCode v2 does not support this Varro operation: ${method} ${route}`);
  }

  private async readBackgroundServiceChoices(
    shells: ShellInfo[],
    jobSessionIDs: readonly string[] = []
  ): Promise<ReadonlyMap<string, UnknownRecord>> {
    const sessionIDs = [
      ...new Set([
        ...jobSessionIDs,
        ...shells.flatMap((shell) =>
          isString(shell.metadata.sessionID) ? [shell.metadata.sessionID] : []
        ),
      ]),
    ];
    return new Map(
      await Promise.all(
        sessionIDs.map(
          async (sessionID) => [sessionID, await this.backgroundServices.read(sessionID)] as const
        )
      )
    );
  }

  private async readBackgroundJobs(
    load: (path: string) => Promise<unknown>,
    directory?: string
  ): Promise<ReadonlyMap<string, readonly JobInfo[]> | undefined> {
    // The experimental route first shipped in 2.2.6. Do not probe older servers or
    // turn authentication, network, or malformed-response failures into an idle snapshot.
    if (
      !this.serverVersion ||
      compareVersions(this.serverVersion, '2.2.6') < 0 ||
      this.backgroundJobsAvailable === false
    )
      return undefined;
    const generation = this.taskControlsGeneration;
    let response: unknown;
    try {
      response = await load('/api/experimental/job');
    } catch (error: unknown) {
      if (!isNotFoundError(error)) throw error;
      if (generation === this.taskControlsGeneration) this.backgroundJobsAvailable = false;
      return undefined;
    }
    const jobs = parseBackgroundJobs(response).filter((job) => job.status !== 'cancelled');
    const sessions = new Map<
      string,
      Promise<{ directory: string; parentID?: string } | undefined>
    >();
    const session = (id: string) => {
      let pending = sessions.get(id);
      if (!pending) {
        pending = load(`/api/session/${encodeURIComponent(id)}`)
          .then((value) => {
            const info = asRecord(value);
            const location = asRecord(info?.location);
            if (
              !info ||
              info.id !== id ||
              !isString(location?.directory) ||
              (info.parentID !== undefined && !isString(info.parentID))
            )
              throw new Error('Invalid OpenCode v2 background-job session');
            return { directory: location.directory, parentID: info.parentID };
          })
          .catch((error: unknown) => {
            // Deletion may race the job snapshot. Other failures must not erase pending work.
            if (isNotFoundError(error)) return undefined;
            throw error;
          });
        sessions.set(id, pending);
      }
      return pending;
    };
    const owners = await Promise.all(
      jobs.map(async (job) => {
        const included: string[] = [];
        const seen = new Set<string>();
        let id: string | undefined = job.sessionID;
        while (id && !seen.has(id)) {
          seen.add(id);
          const info = await session(id);
          if (!info) break;
          if (!directory || isSameWorkspacePath(info.directory, directory)) included.push(id);
          id = info.parentID;
        }
        return included;
      })
    );
    const grouped = new Map<string, JobInfo[]>();
    for (const [index, job] of jobs.entries()) {
      for (const id of owners[index] ?? []) {
        const items = grouped.get(id) ?? [];
        items.push(job);
        grouped.set(id, items);
      }
    }
    return grouped;
  }

  private scheduleBackgroundJudgment(
    shell: ShellInfo,
    sessionID: string,
    directory?: string,
    nextReviewAt?: number
  ): void {
    if (
      !this.classifyBackgroundProcess ||
      this.backgroundJudgments.has(shell.id) ||
      this.manualServiceChoices.has(shell.id)
    )
      return;
    if (nextReviewAt !== undefined && nextReviewAt > Date.now()) {
      this.queueBackgroundReview(shell.id, sessionID, directory, nextReviewAt);
      return;
    }
    if (this.backgroundJudgments.size >= 4) {
      this.queueBackgroundReview(shell.id, sessionID, directory, Date.now() + 20_000);
      return;
    }
    clearTimeout(this.backgroundReviewTimers.get(shell.id));
    this.backgroundReviewTimers.delete(shell.id);
    const controller = new AbortController();
    this.backgroundJudgments.set(shell.id, controller);
    // Do not delay status snapshots, startup, or chat rendering while the same-session model judges lifetime.
    void this.classifyBackgroundProcess(shell, directory, controller.signal)
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          logger.warn(
            `Background process classification failed; preserving its current wait setting: ${error instanceof Error ? error.message : String(error)}`
          );
        return null;
      })
      .then(async (service) => {
        if (
          controller.signal.aborted ||
          this.manualServiceChoices.has(shell.id) ||
          !this.backgroundWork.hasShell(shell.id)
        )
          return;
        const next = nextBackgroundReviewAt(shell.time.started, Date.now());
        const patch: UnknownRecord = { [`review:${shell.id}`]: { next } };
        if (service !== null) patch[shell.id] = service;
        await this.backgroundServices.update(
          sessionID,
          patch,
          controller.signal,
          `manual:${shell.id}`
        );
        if (controller.signal.aborted) return;
        const saved = await this.backgroundServices.read(sessionID);
        if (
          controller.signal.aborted ||
          this.manualServiceChoices.has(shell.id) ||
          saved[`manual:${shell.id}`] === true
        )
          return;
        const previousCount = this.backgroundWork.serviceCount(sessionID);
        if (isBoolean(saved[shell.id]))
          this.backgroundWork.setService(shell.id, saved[shell.id] === true);
        this.queueBackgroundReview(shell.id, sessionID, directory, next);
        if (previousCount !== this.backgroundWork.serviceCount(sessionID))
          this.notifyBackgroundChange(sessionID, directory);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          logger.warn(
            `Could not save background process judgment: ${error instanceof Error ? error.message : String(error)}`
          );
          this.queueBackgroundReview(shell.id, sessionID, directory, Date.now() + 60_000);
        }
      })
      .finally(() => {
        if (this.backgroundJudgments.get(shell.id) === controller)
          this.backgroundJudgments.delete(shell.id);
      });
  }

  private queueBackgroundReview(
    shellID: string,
    sessionID: string,
    directory: string | undefined,
    next: number
  ): void {
    if (
      !this.classifyBackgroundProcess ||
      this.backgroundReviewTimers.has(shellID) ||
      this.manualServiceChoices.has(shellID)
    )
      return;
    const timer = setTimeout(
      () => {
        this.backgroundReviewTimers.delete(shellID);
        const refresh = this.backgroundChanged
          ? this.backgroundChanged(sessionID, directory)
          : this.request('GET', '/session/status', undefined, { directory });
        void refresh.catch((error: unknown) => {
          logger.warn(
            `Could not refresh background processes for review: ${error instanceof Error ? error.message : String(error)}`
          );
          if (this.backgroundWork.hasShell(shellID))
            this.queueBackgroundReview(shellID, sessionID, directory, Date.now() + 60_000);
        });
      },
      Math.max(0, Math.min(next - Date.now(), 2_147_483_647))
    );
    timer.unref();
    this.backgroundReviewTimers.set(shellID, timer);
  }

  private cancelBackgroundReview(shellID: string): void {
    clearTimeout(this.backgroundReviewTimers.get(shellID));
    this.backgroundReviewTimers.delete(shellID);
    this.backgroundJudgments.get(shellID)?.abort();
  }

  private notifyBackgroundChange(sessionID: string, directory?: string): void {
    void this.backgroundChanged?.(sessionID, directory).catch((error: unknown) =>
      logger.warn(
        `Could not publish background process status: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  private async capabilities(options: OpenCodeRequestOptions) {
    this.apiCapabilities ??= this.request('GET', '/openapi.json', undefined, options)
      .then((spec) => {
        if (!asRecord(asRecord(spec)?.paths))
          throw new Error('Invalid OpenCode API capability response');
        return getOpenCodeApiCapabilities(spec);
      })
      .catch((error: unknown) => {
        if (isNotFoundError(error)) return getOpenCodeApiCapabilities(undefined);
        this.apiCapabilities = undefined;
        throw error;
      });
    return this.apiCapabilities;
  }

  private async session(
    value: SessionInfo,
    options: OpenCodeRequestOptions = {}
  ): Promise<UnknownRecord> {
    const projected = projectV2Session(value);
    const annotations = await this.annotations.read(value.id);
    const time = { ...value.time, ...asRecord(annotations.time) };
    if (
      Object.hasOwn(asRecord(annotations.time) ?? {}, 'archived') &&
      (await this.capabilities(options)).sessionArchiving
    ) {
      // Absence is authoritative too: another client may have restored the session.
      // Retain legacy annotations on disk, but never let them mask native state.
      delete time.archived;
      if (value.time.archived !== undefined) time.archived = value.time.archived;
    }
    const session: UnknownRecord = {
      ...projected,
      ...annotations,
      time,
    };
    // Timing belongs to transcript restoration, not session results. Including it
    // across full history can exceed the transport's projected-response budget.
    delete session.generationTiming;
    if (value.parentID) session.parentID = value.parentID;
    return session;
  }

  private async providers(
    route: string,
    directory: string | undefined,
    options: OpenCodeRequestOptions
  ): Promise<unknown> {
    const query = directory ? `?location[directory]=${encodeURIComponent(directory)}` : '';
    const [providerResult, modelResult, configResult, integrationResult] = await Promise.all([
      this.wire('GET', `/api/provider${query}`, undefined, { ...options, unscoped: true }),
      this.wire('GET', `/api/model${query}`, undefined, { ...options, unscoped: true }),
      this.request('GET', '/config', undefined, { ...options, directory }),
      this.wire('GET', `/api/integration${query}`, undefined, { ...options, unscoped: true }),
    ]);
    const providers = asRecord(providerResult)?.data as ProviderInfo[];
    const models = asRecord(modelResult)?.data as ModelInfo[];
    if (!Array.isArray(providers) || !Array.isArray(models))
      throw new Error('Invalid OpenCode v2 provider catalog');
    const integrations = asRecord(integrationResult)?.data as IntegrationInfo[];
    if (!Array.isArray(integrations)) throw new Error('Invalid OpenCode v2 integration catalog');
    const all = providers.map((provider) => ({
      ...provider,
      disconnectMode:
        !provider.integrationID && ['ollama', 'lmstudio', 'vllm'].includes(provider.id)
          ? ('disable' as const)
          : undefined,
      ...connectionInfo(
        integrations.find(
          (integration) => integration.id === (provider.integrationID ?? provider.id)
        )
      ),
      options: provider.settings ?? {},
      models: Object.fromEntries(
        models
          .filter((model) => model.providerID === provider.id)
          .map((model) => [model.id, projectV2Model(model)])
      ),
    }));
    for (const integration of integrations) {
      if (
        !all.some(
          (provider) => provider.integrationID === integration.id || provider.id === integration.id
        )
      )
        all.push({
          id: integration.id,
          disconnectMode: undefined,
          integrationID: integration.id,
          name: integration.name,
          package: '',
          activation: 'auto',
          ...connectionInfo(integration),
          options: {},
          models: {},
        });
    }
    // 2.0.5's catalog omits custom configuration entries even though prompt resolution accepts them.
    const config = asRecord(configResult);
    const configured = asRecord(config?.providers) ?? {};
    const experimentalPolicies = asRecord(config?.experimental)?.policies;
    // 2.0.29 normalizes legacy policies into the top-level key, whose entries win within a file.
    const policies = [
      ...(Array.isArray(experimentalPolicies) ? experimentalPolicies : []),
      ...(Array.isArray(config?.policies) ? config.policies : []),
    ];
    const nativeCatalog = this.serverVersion && compareVersions(this.serverVersion, '2.2.0') >= 0;
    for (const [id, entry] of Object.entries(configured)) {
      // Do not restore configured models that the native provider policy removed.
      if (
        policies.findLast((value) => {
          const policy = asRecord(value);
          return policy?.action === 'provider.use' && policy.resource === id;
        })?.effect === 'deny'
      ) {
        // A denied provider may still have a connectable integration in the native catalog.
        const index = all.findIndex((provider) => provider.id === id);
        if (index !== -1) all.splice(index, 1);
        continue;
      }
      const provider = asRecord(entry);
      if (!provider) continue;
      let target = all.find((item) => item.id === id);
      if (target?.source === 'custom') target.source = 'config';
      // Keep source labels and deny filtering above, but never restore native omissions.
      // Modern model catalogs exclude non-chat models and unavailable packages.
      if (nativeCatalog) continue;
      if (!target) {
        target = {
          id,
          disconnectMode: ['ollama', 'lmstudio', 'vllm'].includes(id) ? 'disable' : undefined,
          name: isString(provider.name) ? provider.name : id,
          package: String(provider.package ?? ''),
          activation: 'enabled',
          env: [],
          source: 'config',
          options: {},
          models: {},
        };
        all.push(target);
      }
      for (const [modelID, definition] of Object.entries(asRecord(provider.models) ?? {})) {
        const model = asRecord(definition);
        if (!model) continue;
        if (model.type !== undefined && model.type !== 'chat') continue;
        const existing = target.models[modelID];
        // Recent OpenCode/Go catalogs filter models server-side, including free-model exclusions.
        // Keep the old-server/custom-provider fallback without undoing those exclusions.
        if (
          !existing &&
          (id === 'opencode' || id === 'opencode-go') &&
          this.serverVersion &&
          compareVersions(this.serverVersion, '2.1.2') >= 0
        )
          continue;
        target.models[modelID] = {
          id: modelID,
          providerID: id,
          name: model.name ?? modelID,
          api: { id: model.modelID ?? modelID, npm: provider.package ?? '', url: '' },
          capabilities: { tools: true, input: ['text'], output: ['text'] },
          ...existing,
          ...model,
          cost:
            model.cost !== undefined
              ? projectV2ModelCost(model.cost)
              : (existing?.cost ?? projectV2ModelCost([])),
          limit: {
            context: 0,
            output: 0,
            ...asRecord(existing?.limit),
            ...asRecord(model.limit),
          },
          enabled: model.disabled !== true,
          variants: Array.isArray(model.variants)
            ? Object.fromEntries(
                model.variants.map((variant) => [String(asRecord(variant)?.id), variant])
              )
            : (existing?.variants ?? {}),
        };
      }
    }
    const defaults = Object.fromEntries(
      all.map((provider) => [
        provider.id,
        Object.keys(provider.models).find((id) => provider.models[id]?.enabled !== false) ?? '',
      ])
    );
    const connected = all
      .filter((provider) =>
        integrations.some(
          (integration) =>
            integration.id === (provider.integrationID ?? provider.id) &&
            (integration.connections?.length ?? 0) > 0
        )
      )
      .map((provider) => provider.id);
    if (route === '/config/providers') {
      const activeProviders = all.filter(
        (provider) =>
          connected.includes(provider.id) ||
          Object.hasOwn(configured, provider.id) ||
          provider.activation === 'enabled' ||
          Object.values(provider.models).some((model) => model.enabled !== false)
      );
      return {
        providers: activeProviders,
        default: Object.fromEntries(
          activeProviders.map((provider) => [provider.id, defaults[provider.id]])
        ),
      };
    }
    return { all, default: defaults, connected };
  }

  private async authenticate(
    providerID: string,
    action: string | undefined,
    method: string,
    input: UnknownRecord,
    directory: string | undefined,
    options: OpenCodeRequestOptions,
    integrationOverride?: string
  ): Promise<unknown> {
    const suffix = directory ? `?location[directory]=${encodeURIComponent(directory)}` : '';
    const raw = (verb: string, path: string, body?: unknown) =>
      this.wire(verb, path + suffix, body, { ...options, unscoped: true });
    let integrationID = integrationOverride ?? providerID;
    if (!integrationOverride) {
      try {
        const provider = asRecord(
          asRecord(await raw('GET', `/api/provider/${encodeURIComponent(providerID)}`))?.data
        );
        if (isString(provider?.integrationID)) integrationID = provider.integrationID;
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
        // Disconnected integrations need not have a registered provider yet.
      }
    }
    const base = `/api/integration/${encodeURIComponent(integrationID)}`;
    if (method === 'PUT' && input.type === 'api') {
      const integration = asRecord(await raw('GET', base))?.data as IntegrationInfo;
      await raw('POST', `${base}/connect/key`, {
        key: input.key,
        answer: v2AuthAnswers(
          integration.methods.find((item) => item.type === 'key')?.form,
          input.metadata
        ),
      });
      return true;
    }
    if (method === 'DELETE') {
      let integration: IntegrationInfo | undefined;
      try {
        integration = asRecord(await raw('GET', base))?.data as IntegrationInfo;
      } catch (error) {
        // Local discovery providers such as Ollama have no integration or saved credential.
        if (isNotFoundError(error))
          throw new Error(
            'This provider has no saved credential. Disable it in this workspace to remove its models.',
            { cause: error }
          );
        throw error;
      }
      const connections = integration?.connections ?? [];
      const credentials = connections.filter((connection) => connection.type === 'credential');
      if (!credentials.length && connections.length)
        throw new Error(
          'Remove the provider environment variable to disconnect this OpenCode integration'
        );
      for (const credential of credentials)
        await raw('DELETE', `/api/credential/${encodeURIComponent(credential.id)}`);
      return true;
    }
    if (action === 'authorize') {
      const integration = asRecord(await raw('GET', base))?.data as IntegrationInfo;
      const methods = integration.methods.filter(
        (item) => item.type === 'key' || item.type === 'oauth' || item.type === 'external'
      );
      const selected = methods[Number(input.method ?? 0)];
      if (selected?.type === 'external') {
        await raw('POST', `${base}/connect/external`, {
          methodID: selected.id,
          answer: v2AuthAnswers(selected.form, input.inputs),
        });
        return { url: '', method: 'complete', instructions: '' };
      }
      if (selected?.type !== 'oauth') throw new Error('Unsupported OpenCode authentication method');
      const result = asRecord(
        asRecord(
          await raw('POST', `${base}/connect/oauth`, {
            methodID: selected.id,
            answer: v2AuthAnswers(selected.form, input.inputs),
          })
        )?.data
      );
      if (!isString(result?.attemptID)) throw new Error('Invalid OpenCode OAuth attempt');
      this.oauth.set(result.attemptID, {
        integrationID,
        attemptID: result.attemptID,
        providerID,
        directory,
        paste: result.mode === 'auto' && result.paste === true,
      });
      const authorization = {
        attemptID: result.attemptID,
        url: result.url,
        method: result.mode === 'code' ? 'code' : 'auto',
        instructions: result.instructions ?? '',
      };
      return result.paste === true ? { ...authorization, paste: true } : authorization;
    }
    if (action === 'callback') {
      const candidates = [...this.oauth.values()].filter(
        (attempt) => attempt.providerID === providerID && attempt.directory === directory
      );
      const attempt = isString(input.attemptID)
        ? candidates.find((candidate) => candidate.attemptID === input.attemptID)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (!attempt) throw new Error('OpenCode OAuth attempt was not started');
      const attemptPath = `/api/integration/${encodeURIComponent(attempt.integrationID)}/connect/oauth/${encodeURIComponent(attempt.attemptID)}`;
      if (input.submitOnly === true) {
        if (!attempt.paste || !isString(input.code) || !input.code.trim())
          throw new Error('This OAuth attempt does not accept a pasted redirect URL');
        // The existing callback owns polling and cancellation. A rejected paste must
        // leave that callback and its native attempt alive so the user can retry.
        await raw('POST', `${attemptPath}/complete`, { code: input.code });
        return true;
      }
      let completed = false;
      try {
        if (input.code) await raw('POST', `${attemptPath}/complete`, { code: input.code });
        const deadline = Date.now() + 5 * 60_000;
        while (true) {
          options.signal?.throwIfAborted();
          const result = asRecord(asRecord(await raw('GET', attemptPath))?.data);
          if (result?.status === 'complete') break;
          if (result?.status !== 'pending' || Date.now() >= deadline)
            throw new Error(
              isString(result?.message)
                ? result.message
                : 'OpenCode authentication did not complete'
            );
          await delay(500, undefined, { signal: options.signal });
        }
        completed = true;
        return true;
      } finally {
        this.oauth.delete(attempt.attemptID);
        if (!completed) {
          await this.wire('DELETE', attemptPath + suffix, undefined, {
            ...options,
            signal: undefined,
            unscoped: true,
          }).catch(() => undefined);
        }
      }
    }
    throw new Error('This credential operation requires OpenCode v2 credential management');
  }

  private async submit(sessionID: string, run: () => Promise<unknown>): Promise<unknown> {
    const previous = this.submissions.get(sessionID);
    const operation = (async () => {
      await previous?.catch(() => {});
      return run();
    })();
    this.submissions.set(sessionID, operation);
    try {
      return await operation;
    } finally {
      if (this.submissions.get(sessionID) === operation) this.submissions.delete(sessionID);
    }
  }
}
