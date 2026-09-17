/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- Native event envelopes are narrowed before projecting released payload contracts. */
import type { FormInfo, PermissionRequest } from '@opencode/client';
import { asRecord, isString, isNumber, type UnknownRecord } from '../shared/type-utils';
import { parseServerEvent } from '../shared/protocol';
import {
  projectV2Form,
  projectV2Permission,
  v1Action,
  v2PartId,
  v2ToolOutput,
  projectV2Message,
  normalizeV2Error,
  type V2MessageContext,
} from './opencode-v2-projection';

/** Translate released v2 events into the existing Varro event vocabulary. */
export function projectV2Event(value: unknown, context: V2MessageContext = {}): unknown[] {
  const event = asRecord(value);
  const data = asRecord(event?.data);
  if (!event || !isString(event.type) || !data) return [];
  const properties: UnknownRecord = { ...data, timestamp: event.created };
  const location = asRecord(event.location) ?? asRecord(data.location);
  const durable = asRecord(event.durable);
  const base = {
    id: event.id,
    seq: durable?.seq,
    workspaceDirectory: location?.directory ?? context.directory,
  };
  const emit = (type: string, props = properties): unknown[] => [
    { ...base, type, properties: props },
  ];
  const sessionID = isString(data.sessionID) ? data.sessionID : '';
  if (event.type === 'server.connected') return emit('server.connected');
  if (event.type === 'session.created')
    return emit('session.created', {
      info: {
        ...data,
        id: sessionID,
        directory: location?.directory,
        time: { created: event.created, updated: event.created },
        title: data.title ?? '',
      },
    });
  if (event.type === 'session.renamed')
    return emit('session.updated', {
      info: { id: sessionID, title: data.title, time: { updated: event.created } },
    });
  if (event.type === 'session.deleted')
    return emit('session.deleted', { sessionID, info: { id: sessionID } });
  if (event.type === 'session.status.updated') return emit('session.status');
  if (event.type === 'session.execution.started')
    return emit('session.status', { sessionID, status: { type: 'busy' } });
  if (
    [
      'session.execution.succeeded',
      'session.execution.interrupted',
      'session.execution.failed',
    ].includes(event.type)
  ) {
    if (event.type !== 'session.execution.failed')
      return emit('session.status', { sessionID, status: { type: 'idle' } });
    // Record the failure before settling busy state, so an idle notification cannot report success.
    const error = normalizeV2Error(data.error);
    const messages: unknown[] = [];
    if (!context.hasAssistant && isString(event.id)) {
      const failed = projectV2Message(
        {
          id: event.id.replace(/^evt_/, 'msg_'),
          type: 'idle',
          outcome: 'failed',
          time: { created: isNumber(event.created) ? event.created : 0 },
        },
        sessionID,
        context.directory,
        context.parentID,
        { ...context, error }
      );
      messages.push({
        ...base,
        id: `${event.id}:message`,
        seq: undefined,
        type: 'message.updated',
        properties: { info: failed.info },
      });
    }
    return [
      ...messages,
      ...emit('session.error', {
        sessionID,
        error: {
          name: 'APIError',
          data: {
            message: error?.message ?? 'OpenCode execution failed',
            statusCode: error?.status,
          },
        },
      }),
      {
        ...base,
        id: `${String(event.id)}:idle`,
        seq: undefined,
        type: 'session.status',
        properties: { sessionID, status: { type: 'idle' } },
      },
    ];
  }
  if (event.type === 'permission.asked' && isString(data.id) && Array.isArray(data.resources))
    return emit('permission.asked', projectV2Permission(data as PermissionRequest));
  if (event.type === 'permission.replied') return emit('permission.replied');
  if (event.type === 'form.created') {
    const form = asRecord(data.form);
    return form && Array.isArray(form.fields)
      ? emit('question.asked', projectV2Form(form as FormInfo))
      : [];
  }
  if (event.type === 'form.replied' || event.type === 'form.cancelled')
    return emit(event.type === 'form.replied' ? 'question.replied' : 'question.rejected', {
      ...properties,
      requestID: data.id,
    });
  if (event.type === 'session.inbox.enqueued')
    return emit('session.next.prompt.admitted', { ...properties, messageID: data.inboxID });
  if (event.type === 'session.inbox.delivered')
    return emit('session.next.prompted', { ...properties, messageID: data.inboxID });
  if (event.type === 'session.skill.activated') return emit('session.next.synthetic');
  if (event.type === 'session.shell.started' || event.type === 'session.shell.ended')
    return emit(event.type.replace('session.', 'session.next.'), {
      ...properties,
      callID: asRecord(data.shell)?.id,
      output: asRecord(data.output)?.output,
    });
  if (event.type === 'session.agent.selected') return emit('session.next.agent.switched');
  if (event.type === 'session.model.selected')
    return emit('session.next.model.switched', {
      ...properties,
      model: { ...asRecord(data.model), modelID: asRecord(data.model)?.id },
    });
  if (event.type === 'session.retry.scheduled')
    return emit('session.status', {
      sessionID,
      status: {
        type: 'retry',
        attempt: data.attempt,
        next: data.at,
        message: asRecord(data.error)?.message ?? 'Retrying',
      },
    });
  if (/^session\.(text|reasoning)\./.test(event.type)) {
    if (!isString(data.assistantMessageID) || !isNumber(data.ordinal)) return [];
    const type = event.type.startsWith('session.text.') ? 'text' : 'reasoning';
    const partID = v2PartId(data.assistantMessageID, type, data.ordinal);
    return emit(event.type.replace('session.', 'session.next.'), {
      ...properties,
      textID: partID,
      reasoningID: partID,
    });
  }
  if (event.type.startsWith('session.tool.')) {
    return emit(event.type.replace('session.', 'session.next.'), {
      ...properties,
      callID: data.id,
      structured: data.metadata,
      provider: data.state,
      result: data.resultState,
      name: isString(data.name) ? v1Action(data.name) : undefined,
      output: v2ToolOutput(data.content),
    });
  }
  if (event.type.startsWith('session.step.')) {
    if (event.type === 'session.step.streamed')
      return emit('session.next.context.updated', { sessionID });
    const model = asRecord(data.model);
    return emit(event.type.replace('session.', 'session.next.'), {
      ...properties,
      timestamp:
        event.type === 'session.step.started' && isNumber(data.started)
          ? data.started
          : properties.timestamp,
      model: model ? { ...model, modelID: model.id } : undefined,
      executionContinues: true,
    });
  }
  if (
    /^session\.(compaction|revert)\./.test(event.type) ||
    ['session.synthetic', 'session.moved'].includes(event.type)
  ) {
    if (event.type === 'session.compaction.failed')
      return [
        ...emit('session.next.compaction.ended'),
        {
          ...base,
          id: `${event.id}:error`,
          seq: undefined,
          type: 'session.error',
          properties: {
            sessionID,
            error: {
              name: 'APIError',
              data: { message: asRecord(data.error)?.message ?? 'Compaction failed' },
            },
          },
        },
      ];
    return emit(event.type.replace('session.', 'session.next.'));
  }
  if (
    [
      'provider.updated',
      'model.updated',
      'agent.updated',
      'integration.updated',
      'credential.updated',
    ].includes(event.type)
  )
    return emit('catalog.updated');
  if (event.type === 'config.updated') return emit('global.disposed');
  if (parseServerEvent(event)) return [event];
  // Account for durable events which have no UI representation, without fabricating activity.
  return sessionID && isNumber(durable?.seq)
    ? [
        {
          ...base,
          type: 'session.next.context.updated',
          sequenceOnly: true,
          properties: { sessionID },
        },
      ]
    : [];
}
