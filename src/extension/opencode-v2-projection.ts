/* oxlint-disable anti-slop/no-unknown-parameters -- This adapter validates and projects external protocol records. */
import type {
  AgentInfo,
  ModelInfo,
  PermissionRequest,
  SessionInfo,
  SessionMessageInfo,
  SessionMessageAssistantTool,
  FormInfo,
  ModelRef,
  SessionStructuredError,
} from '@opencode/client';
import { asRecord, isNumber, isString, type UnknownRecord } from '../shared/type-utils';
import { formatSkillAttachment } from '../shared/skill-reference';

export function v2PartId(messageID: string, type: string, ordinal: number): string {
  return `${messageID}:${type}:${ordinal}`;
}

export function v2ModelRef(value: unknown): UnknownRecord | undefined {
  if (isString(value)) {
    const match = value.match(/^([^/]+)\/(.+?)(?:#([^#]+))?$/);
    return match ? { providerID: match[1], id: match[2], variant: match[3] } : undefined;
  }
  const model = asRecord(value);
  if (!model || !isString(model.providerID)) return undefined;
  const id = model.modelID ?? model.id ?? model.model;
  return isString(id)
    ? {
        providerID: model.providerID,
        id,
        variant: isString(model.variant) ? model.variant : undefined,
      }
    : undefined;
}

export function v2Action(action: string): string {
  if (action === 'bash') return 'shell';
  if (action === 'task') return 'subagent';
  if (action === 'write' || action === 'patch') return 'edit';
  return action;
}

export function v1Action(action: string): string {
  if (action === 'shell') return 'bash';
  if (action === 'subagent') return 'task';
  return action;
}

export function v2Rules(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) throw new Error('Invalid OpenCode permission rules');
  return value.map((item: unknown) => {
    const rule = asRecord(item);
    const action = rule?.permission ?? rule?.action;
    const resource = rule?.pattern ?? rule?.resource;
    const effect = rule?.permission !== undefined ? rule.action : rule?.effect;
    if (
      !isString(action) ||
      !isString(resource) ||
      !['allow', 'deny', 'ask'].includes(String(effect))
    )
      throw new Error('Invalid OpenCode permission rule');
    return { action: v2Action(action), resource, effect };
  });
}

export function projectV2Session(session: SessionInfo): UnknownRecord {
  return {
    ...session,
    sharingSupported: false,
    // Native v2 omits the legacy version field required by recycle-bin snapshots.
    version: '2',
    title: session.title ?? '',
    directory: session.location.directory,
    permission: session.permissions?.map((rule) => ({
      permission: v1Action(rule.action),
      pattern: rule.resource,
      action: rule.effect,
    })),
    model: session.model ? { ...session.model, modelID: session.model.id } : undefined,
    revert: session.revert,
  };
}

export function projectV2Permission(request: PermissionRequest): UnknownRecord {
  const source = asRecord(request.source);
  return {
    ...request,
    permission: v1Action(request.action),
    patterns: request.resources,
    always: request.save ?? request.resources,
    metadata: request.metadata ?? {},
    tool: source ? { messageID: source.messageID, callID: source.callID ?? source.id } : undefined,
  };
}

export function projectV2Agent(agent: AgentInfo): UnknownRecord {
  return {
    ...agent,
    name: agent.id,
    prompt: agent.system,
    model: agent.model
      ? { providerID: agent.model.providerID, modelID: agent.model.id }
      : undefined,
    variant: agent.model?.variant,
    permission: agent.permissions.map((rule) => ({
      permission: v1Action(rule.action),
      pattern: rule.resource,
      action: rule.effect,
    })),
    options: agent.request.body ?? {},
  };
}

export function projectV2ModelCost(value: unknown) {
  const tiers = (Array.isArray(value) ? value : [value])
    .map(asRecord)
    .filter((tier) => tier !== null);
  const cost = tiers.find((tier) => !tier.tier) ?? tiers[0];
  const cache = asRecord(cost?.cache);
  const read = isNumber(cache?.read) ? cache.read : 0;
  const write = isNumber(cache?.write) ? cache.write : 0;
  return {
    input: isNumber(cost?.input) ? cost.input : 0,
    output: isNumber(cost?.output) ? cost.output : 0,
    cache_read: read,
    cache_write: write,
    cache: { read, write },
    tiers: tiers.filter((tier) => tier.tier),
  };
}

export function projectV2Model(model: ModelInfo): UnknownRecord {
  const released = new Date(model.time.released);
  return {
    ...model,
    release_date:
      model.time.released > 0 && Number.isFinite(released.getTime())
        ? released.toISOString().slice(0, 10)
        : undefined,
    api: { id: model.modelID, npm: model.package ?? '', url: '' },
    cost: projectV2ModelCost(model.cost),
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant])),
    capabilities: model.capabilities,
    options: model.settings ?? {},
  };
}

export function v2ToolOutput(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((item: unknown) => asRecord(item))
    .filter((item) => item?.type === 'text')
    .map((item) => item?.text ?? '')
    .join('\n');
}

function projectTool(
  tool: SessionMessageAssistantTool,
  sessionID: string,
  messageID: string
): UnknownRecord {
  const base = {
    id: tool.id,
    callID: tool.id,
    sessionID,
    messageID,
    type: 'tool',
    tool: v1Action(tool.name),
  };
  const state = tool.state;
  const time = {
    start: tool.time.ran ?? tool.time.created,
    end: tool.time.completed,
  };
  if (state.status === 'streaming')
    return { ...base, state: { status: 'pending', input: {}, raw: state.input } };
  const metadata = state.metadata ?? {};
  if (state.status === 'running') return { ...base, state: { ...state, metadata, time } };
  const attachments = state.content
    ?.filter((content) => content.type === 'file')
    .map((content, index) => ({
      id: `${tool.id}:file:${index}`,
      sessionID,
      messageID,
      type: 'file',
      url: content.uri,
      mime: content.mime,
      filename: content.name,
    }));
  return {
    ...base,
    state: {
      ...state,
      metadata,
      title: isString(metadata.title) ? metadata.title : undefined,
      time,
      output: v2ToolOutput(state.content),
      error: state.status === 'error' ? state.error.message : undefined,
      attachments,
    },
  };
}

export type ProjectedV2Message = { info: UnknownRecord; parts: UnknownRecord[] };

export type V2MessageContext = {
  agent?: string;
  model?: ModelRef;
  parentID?: string;
  directory?: string;
  hasAssistant?: boolean;
  backgroundPending?: boolean;
  backgroundStartedAt?: number;
  error?: SessionStructuredError;
};

export function normalizeV2Error(value: unknown): SessionStructuredError | undefined {
  const error = asRecord(value);
  if (!isString(error?.message)) return undefined;
  const authorization = /^(?:Integration\.Authorization:\s*)?Request failed:\s*(401|403)\b/i.exec(
    error.message
  );
  return {
    type: isString(error.type) ? error.type : 'unknown',
    message: error.message.slice(0, 16384),
    status: isNumber(error.status)
      ? error.status
      : authorization
        ? Number(authorization[1])
        : undefined,
  };
}

export function isV2TranscriptMessage(message: SessionMessageInfo): boolean {
  return (
    message.type === 'user' ||
    message.type === 'assistant' ||
    message.type === 'compaction' ||
    message.type === 'skill' ||
    message.type === 'shell' ||
    (message.type === 'idle' && message.outcome === 'failed')
  );
}

export function projectV2Message(
  message: SessionMessageInfo,
  sessionID: string,
  directory = '',
  parentID = '',
  context: V2MessageContext = {}
): ProjectedV2Message {
  const base = { id: message.id, sessionID, time: message.time };
  const part = (ordinal: number, type: string, fields: UnknownRecord): UnknownRecord => ({
    id: v2PartId(message.id, message.type === 'assistant' ? type : 'content', ordinal),
    sessionID,
    messageID: message.id,
    type,
    ...fields,
  });
  if (message.type === 'skill' || message.type === 'shell') {
    const completed = message.type === 'skill' || message.status !== 'running';
    const time = {
      created: message.time.created,
      completed: completed
        ? ((message.type === 'shell' ? message.time.completed : undefined) ?? message.time.created)
        : undefined,
    };
    const input: Record<string, string> =
      message.type === 'skill' ? { name: message.skill } : { command: message.command };
    const output = message.type === 'skill' ? message.text : (message.output?.output ?? '');
    const shellFailure =
      message.type === 'shell'
        ? message.status === 'timeout' || message.status === 'killed'
          ? `Shell ${message.status}`
          : message.status === 'exited' && message.exit !== undefined && message.exit !== 0
            ? `Shell exited with code ${message.exit}`
            : undefined
        : undefined;
    const error = shellFailure
      ? {
          type: 'ShellError',
          message: [output, shellFailure].filter(Boolean).join('\n'),
        }
      : undefined;
    return projectV2Message(
      {
        id: message.id,
        type: 'assistant',
        agent: context.agent ?? '',
        model: context.model ?? { providerID: '', id: '' },
        time,
        content: [
          {
            type: 'tool',
            id: message.type === 'shell' ? message.shellID : v2PartId(message.id, 'content', 0),
            name: message.type,
            time,
            state: error
              ? { status: 'error', input, error }
              : completed
                ? { status: 'completed', input, content: [{ type: 'text', text: output }] }
                : { status: 'running', input, metadata: { output } },
          },
        ],
      },
      sessionID,
      directory,
      parentID,
      context
    );
  }
  if (message.type === 'idle' && message.outcome === 'failed') {
    const error = normalizeV2Error(context.error);
    return {
      info: {
        ...base,
        role: 'assistant',
        parentID,
        agent: context.agent ?? '',
        mode: context.agent ?? '',
        modelID: context.model?.id ?? '',
        providerID: context.model?.providerID ?? '',
        path: { cwd: directory, root: directory },
        time: { created: message.time.created, completed: message.time.created },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        error: {
          name:
            error?.status === 401 || error?.status === 403 ? 'ProviderAuthError' : 'UnknownError',
          data: {
            providerID: context.model?.providerID,
            statusCode: error?.status,
            message:
              error?.message ??
              'OpenCode failed before a response was recorded. Check the provider connection and the OpenCode server log.',
          },
        },
      },
      parts: [],
    };
  }
  if (message.type === 'assistant') {
    // V2 stream ordinals count within each content type, including empty blocks.
    const ordinals = { text: 0, reasoning: 0 };
    return {
      info: {
        ...base,
        role: 'assistant',
        parentID,
        agent: message.agent,
        mode: message.agent,
        providerID: message.model.providerID,
        modelID: message.model.id,
        variant: message.model.variant,
        path: { cwd: directory, root: directory },
        cost: message.cost ?? 0,
        tokens: message.tokens ?? {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: message.finish,
        retry: message.retry ? { attempt: message.retry.attempt, at: message.retry.at } : undefined,
        error: message.error
          ? {
              name: message.error.type,
              data: { message: message.error.message, statusCode: message.error.status },
            }
          : undefined,
      },
      parts: message.content.map((content) =>
        content.type === 'tool'
          ? projectTool(content, sessionID, message.id)
          : part(ordinals[content.type]++, content.type, {
              text: content.text,
              time:
                content.type === 'reasoning'
                  ? {
                      start: content.time?.created ?? message.time.created,
                      end: content.time?.completed,
                    }
                  : undefined,
            })
      ),
    };
  }
  const info: UnknownRecord = {
    ...base,
    role: 'user',
    agent: context.agent ?? '',
    model: {
      providerID: context.model?.providerID ?? '',
      modelID: context.model?.id ?? '',
      variant: context.model?.variant,
    },
  };
  if (message.type === 'user') {
    return {
      info,
      parts: [
        part(0, 'text', { text: message.text }),
        ...(message.files ?? []).map((file, index) =>
          part(index + 1, 'file', {
            mime: file.mime,
            filename: file.name,
            url:
              file.source.type === 'uri'
                ? file.source.uri
                : `data:${file.mime};base64,${file.data}`,
          })
        ),
        ...(message.agents ?? []).map((agent, index) =>
          part((message.files?.length ?? 0) + index + 1, 'agent', { name: agent.name })
        ),
        ...(message.skills ?? []).map((skill, index) =>
          part((message.files?.length ?? 0) + (message.agents?.length ?? 0) + index + 1, 'text', {
            text: formatSkillAttachment(skill.name),
            synthetic: true,
          })
        ),
      ],
    };
  }
  if (message.type === 'compaction')
    return {
      info,
      parts: [
        part(0, 'compaction', {
          auto: message.reason === 'auto',
          status: message.status,
          error: message.status === 'failed' ? message.error.message : undefined,
        }),
      ],
    };
  // Control records and internal instructions must stay invisible on direct reads too.
  return { info, parts: [] };
}

export function projectV2Form(form: FormInfo): UnknownRecord {
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: form.fields.map((field) => ({
      header: field.title ?? form.title,
      question: field.description ?? field.title ?? form.title,
      multiple: field.type === 'multiselect',
      custom: 'custom' in field ? field.custom !== false : true,
      options:
        'options' in field
          ? (field.options?.map((option) => ({
              label: option.label,
              description: option.description ?? '',
            })) ?? [])
          : field.type === 'boolean'
            ? [
                { label: 'Yes', description: '' },
                { label: 'No', description: '' },
              ]
            : [],
    })),
  };
}
