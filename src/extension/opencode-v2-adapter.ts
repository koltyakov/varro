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
} from '@opencode/client';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { asRecord, isString, type UnknownRecord } from '../shared/type-utils';
import type {
  ProviderAuthMethod,
  ProviderAuthPromptCondition,
  ProviderAuthPromptText,
} from '../shared/opencode-types';
import { OpenCodeResponseTooLargeError, type OpenCodeRequestOptions } from './open-code-transport';
import { OpenCodeV2SessionState } from './opencode-v2-session-state';
import { OpenCodeV2BackgroundWork } from './opencode-v2-background-work';
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
      .filter((item) => item.type === 'oauth' || item.type === 'key')
      .map((item) => ({
        type: item.type === 'key' ? 'api' : 'oauth',
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
          if (field.type === 'string' && field.options)
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

export class OpenCodeV2Adapter {
  private readonly backgroundWork = new OpenCodeV2BackgroundWork();
  private readonly permissions = new Map<string, string>();
  private readonly forms = new Map<string, FormInfo>();
  private readonly messageParents = new Map<string, string>();
  private readonly contexts = new Map<string, V2MessageContext>();
  private readonly inputTypes = new Map<string, string>();
  private readonly failures = new Map<string, V2MessageContext>();
  private readonly submissions = new Map<string, Promise<unknown>>();
  private readonly oauth = new Map<
    string,
    { integrationID: string; attemptID: string; providerID: string; directory?: string }
  >();

  constructor(
    private readonly wire: WireRequest,
    private readonly annotations = new OpenCodeV2SessionState(),
    private readonly openExternal: (url: string) => Promise<boolean> = async () => false
  ) {}

  observe(type: string, data: UnknownRecord, eventID?: string, eventDirectory?: string): void {
    this.backgroundWork.observe(type, data, eventDirectory);
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
      if (form && isString(form.id) && isString(form.sessionID) && Array.isArray(form.fields))
        this.forms.set(form.id, form as FormInfo);
    }
    if ((type === 'form.replied' || type === 'form.cancelled') && isString(data.id))
      this.forms.delete(data.id);
  }

  reset(): void {
    this.backgroundWork.reset();
    this.permissions.clear();
    this.forms.clear();
    this.messageParents.clear();
    this.contexts.clear();
    this.inputTypes.clear();
    this.failures.clear();
    this.oauth.clear();
  }

  eventContext(sessionID: string): V2MessageContext | undefined {
    return {
      ...this.contexts.get(sessionID),
      backgroundPending: this.backgroundWork.isWaiting(sessionID),
      backgroundStartedAt: this.backgroundWork.startedAt(sessionID),
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
      const [active, shells] = await Promise.all([
        data<Record<string, SessionActive>>('GET', '/api/session/active'),
        data<ShellInfo[]>('GET', query('/api/shell', true)),
      ]);
      const waiting = this.backgroundWork.reconcile(
        shells,
        new Set(Object.keys(active)),
        directory,
        version
      );
      return Object.fromEntries([
        ...Object.entries(active).map(([id, status]) => {
          if (status.type !== 'running')
            throw new Error('Invalid OpenCode v2 active-session status');
          return [id, { type: 'busy' }];
        }),
        ...waiting.map((id) => [
          id,
          {
            type: 'busy',
            background: true,
            backgroundStartedAt: this.backgroundWork.startedAt(id),
          },
        ]),
      ]);
    }
    if ((route === '/session' || route === '/experimental/session') && method === 'GET') {
      const target = new URL('/api/session', 'http://localhost');
      for (const key of ['limit', 'search', 'parentID', 'cursor', 'order']) {
        const value = url.searchParams.get(key);
        if (value) target.searchParams.set(key, value);
      }
      if (route === '/session' && directory) target.searchParams.set('directory', directory);
      if (url.searchParams.get('roots') === 'true') target.searchParams.set('parentID', 'null');
      const result = (await raw('GET', target.pathname + target.search)) as SessionsResponse;
      if (!Array.isArray(result?.data)) throw new Error('Invalid OpenCode v2 session list');
      const sessions = await Promise.all(result.data.map((session) => this.session(session)));
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
      return this.session(session);
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
      for (const form of forms) this.forms.set(form.id, form);
      return forms.map(projectV2Form);
    }
    const approval = route.match(/^\/(permission|question)\/([^/]+)\/(reply|reject)$/);
    if (approval) {
      const id = decodeURIComponent(approval[2]!);
      const kind = approval[1];
      if (kind === 'permission') {
        if (!this.permissions.has(id)) await this.request('GET', '/permission', undefined, options);
        const sessionID = this.permissions.get(id);
        if (!sessionID) throw new Error('OpenCode permission request is no longer pending');
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
        const target = `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(id)}`;
        if (approval[3] === 'reject') await raw('DELETE', target);
        else {
          if (!Array.isArray(input.answers)) throw new Error('Invalid question answers');
          const answers = input.answers;
          const answer = Object.fromEntries(
            form.fields.map((field, index) => {
              const selected = Array.isArray(answers[index]) ? (answers[index] as string[]) : [];
              const values = selected.map((label) =>
                'options' in field
                  ? (field.options?.find((option) => option.label === label)?.value ?? label)
                  : label
              );
              return [
                field.key,
                field.type === 'multiselect'
                  ? values
                  : field.type === 'boolean'
                    ? values[0] === 'Yes'
                    : field.type === 'number' || field.type === 'integer'
                      ? Number(values[0])
                      : (values[0] ?? ''),
              ];
            })
          );
          await raw('POST', `${target}/reply`, { answer });
        }
        this.forms.delete(id);
      }
      return true;
    }
    const sessionRoute = route.match(/^\/session\/([^/]+)(?:\/(.*))?$/);
    if (sessionRoute) {
      const sessionID = decodeURIComponent(sessionRoute[1]!);
      const endpoint = `/api/session/${encodeURIComponent(sessionID)}`;
      const action = sessionRoute[2] ?? '';
      if (!action) {
        if (method === 'GET') return this.session(await data<SessionInfo>('GET', endpoint));
        if (method === 'DELETE') {
          await raw('DELETE', endpoint);
          await this.annotations.remove(sessionID);
          return true;
        }
        if (method === 'PATCH') {
          if (input.title !== undefined || input.permission !== undefined)
            await raw('PATCH', endpoint, {
              title: input.title,
              permissions: input.permission !== undefined ? v2Rules(input.permission) : undefined,
            });
          const patch: UnknownRecord = {};
          if (input.metadata !== undefined) patch.metadata = input.metadata;
          if (input.time !== undefined) patch.time = input.time;
          if (Object.keys(patch).length)
            await this.annotations.update(sessionID, patch, options.signal);
          return this.session(await data<SessionInfo>('GET', endpoint));
        }
      }
      if (action === 'children') {
        const result = (await raw(
          'GET',
          `/api/session?parentID=${encodeURIComponent(sessionID)}&limit=1000`
        )) as SessionsResponse;
        return Promise.all(result.data.map((session) => this.session(session)));
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
            (message.type === 'idle' && message.outcome === 'failed')
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
        const messages = ordered.flatMap((message) => {
          if (message.type === 'agent-switched') context.agent = message.agent;
          if (message.type === 'model-switched') context.model = message.model;
          if (!isV2TranscriptMessage(message)) return [];
          if (message.type === 'idle' && assistantFailed) return [];
          const projected = projectV2Message(message, sessionID, directory, parent, {
            ...context,
            ...this.failures.get(message.id),
          });
          if (message.type === 'user') {
            parent = message.id;
            assistantFailed = false;
          }
          if (message.type === 'assistant' && message.error) assistantFailed = true;
          if (projected.info.role === 'assistant' && parent)
            this.messageParents.set(message.id, parent);
          if (options.stripMessageParts) projected.parts = [];
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
          if (item.type !== 'user' || messageIDs.has(item.id)) continue;
          const projected = projectV2Message(
            { ...item.payload, id: item.id, type: 'user', time: item.time },
            sessionID,
            directory,
            '',
            context
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
        return projectV2Message(
          message,
          sessionID,
          directory,
          this.messageParents.get(message.id),
          this.contexts.get(sessionID)
        );
      }
      if (action.startsWith('message/') && method === 'DELETE') {
        const messageID = decodeURIComponent(action.slice('message/'.length));
        const page = await data<SessionMessageInfo[]>(
          'GET',
          `${endpoint}/message?limit=20&order=desc`
        );
        const last = page.find(isV2TranscriptMessage);
        if (last?.id !== messageID)
          throw new Error('OpenCode v2 can only delete messages from the end of the transcript');
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
          const text = parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('\n');
          if (action === 'message' && (input.system || input.format)) {
            const format = asRecord(input.format);
            const prompt = [
              input.system,
              text,
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
          const payload = {
            id: input.messageID,
            text: action === 'command' ? (input.arguments ?? text) : text,
            files: parts
              .filter((part) => part.type === 'file')
              .map((part) => ({ uri: part.url, name: part.filename })),
            agents: parts
              .filter((part) => part.type === 'agent')
              .map((part) => ({ name: part.name })),
            // Keep the prompt with pending context, including Plan mode's synthetic reminder.
            // Queuing by default lets the reminder run as a separate provider turn.
            delivery: input.delivery === 'queue' ? 'queue' : 'steer',
            resume: input.noReply ? false : undefined,
          };
          const admitted = await raw(
            'POST',
            `${endpoint}/${action === 'command' ? 'command' : 'prompt'}`,
            action === 'command' ? { ...payload, name: input.command } : payload
          );
          if (action === 'prompt_async' || action === 'command' || input.noReply) return admitted;
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
      if (action === 'summarize') {
        await raw('POST', `${endpoint}/compact`, {});
        return true;
      }
      if (action === 'fork')
        return this.session(
          await data<SessionInfo>('POST', `${endpoint}/fork`, { before: input.messageID })
        );
      if (action === 'revert') {
        await raw('POST', `${endpoint}/revert/stage`, { messageID: input.messageID, files: true });
        return this.session(await data<SessionInfo>('GET', endpoint));
      }
      if (action === 'unrevert') {
        await raw('DELETE', `${endpoint}/revert`);
        return this.session(await data<SessionInfo>('GET', endpoint));
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
      // V2 exposes executable callbacks, not their templates. Keep the UI's text fields defined.
      const commands = (await data<CommandInfo[]>('GET', query('/api/command', true))).map(
        (command) => ({
          ...command,
          description: command.description ?? '',
          template: '',
          hints: [],
        })
      );
      const config = asRecord(await this.request('GET', '/config', undefined, options));
      for (const [name, value] of Object.entries(asRecord(config?.commands) ?? {})) {
        const command = asRecord(value);
        if (!command || !isString(command.template)) continue;
        const normalized = {
          name,
          description: isString(command.description) ? command.description : '',
          template: command.template,
          hints: [],
        };
        const existing = commands.findIndex((entry) => entry.name === name);
        if (existing >= 0) commands[existing] = normalized;
        else commands.push(normalized);
      }
      return commands;
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
      if (mcpAuth[2] !== 'authenticate')
        return { authorizationUrl: authorization.url, oauthState: authorization.attemptID };
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

  private async session(value: SessionInfo): Promise<UnknownRecord> {
    const projected = projectV2Session(value);
    const annotations = await this.annotations.read(value.id);
    return { ...projected, ...annotations, time: { ...value.time, ...asRecord(annotations.time) } };
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
    const configured = asRecord(asRecord(configResult)?.providers) ?? {};
    for (const [id, entry] of Object.entries(configured)) {
      // Do not restore configured models that the native provider policy removed.
      const policies = asRecord(asRecord(configResult)?.experimental)?.policies;
      if (
        Array.isArray(policies) &&
        policies.findLast((value) => {
          const policy = asRecord(value);
          return policy?.action === 'provider.use' && policy.resource === id;
        })?.effect === 'deny'
      )
        continue;
      const provider = asRecord(entry);
      if (!provider) continue;
      let target = all.find((item) => item.id === id);
      if (target?.source === 'custom') target.source = 'config';
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
        const existing = target.models[modelID];
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
        (item) => item.type === 'key' || item.type === 'oauth'
      );
      const selected = methods[Number(input.method ?? 0)];
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
      });
      return {
        attemptID: result.attemptID,
        url: result.url,
        method: result.mode === 'code' ? 'code' : 'auto',
        instructions: result.instructions ?? '',
      };
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
