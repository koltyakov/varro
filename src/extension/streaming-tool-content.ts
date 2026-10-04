import type { ServerEvent } from '../shared/protocol';
import type { ToolPart, ToolState } from '../shared/opencode-types';
import { asRecord, isString, type UnknownRecord } from '../shared/type-utils';
import { deferredPartPath, projectDeferredPart } from './message-content';

const MAX_TRACKED_TOOLS = 1024;
const MAX_PENDING_INPUT_CHARACTERS = 512;

/** Retains only routing and the pending-input budget, never tool bodies. */
export class StreamingToolContent {
  private readonly tools = new Map<
    string,
    { name: string; messageID?: string; inputCharacters: number }
  >();

  clear() {
    this.tools.clear();
  }

  project(event: ServerEvent): ServerEvent {
    if (!event.type.startsWith('session.next.tool.') || event.sequenceOnly) return event;
    const source = asRecord(event.properties);
    if (!source || !isString(source.sessionID) || !isString(source.callID)) return event;
    const { sessionID, callID } = source;
    const key = `${event.workspaceDirectory ?? ''}\u0000${sessionID}\u0000${callID}`;
    const previous = this.tools.get(key);
    const name = string(source.name) || string(source.tool) || previous?.name || '';
    const messageID = string(source.assistantMessageID) || previous?.messageID;
    const tracked = {
      name,
      messageID,
      inputCharacters:
        event.type === 'session.next.tool.input.started' ? 0 : (previous?.inputCharacters ?? 0),
    };
    this.tools.delete(key);
    this.tools.set(key, tracked);
    if (this.tools.size > MAX_TRACKED_TOOLS) this.tools.delete(this.tools.keys().next().value!);

    // Native events contain aliases of the same content (metadata/structured,
    // state/provider, content/output). Forward only fields consumed by the UI.
    const properties: UnknownRecord = {
      sessionID,
      assistantMessageID: messageID,
      callID,
      timestamp: source.timestamp,
    };
    if (source.name !== undefined) properties.name = name;
    if (source.tool !== undefined) properties.tool = name;
    const reference = messageID
      ? deferredPartPath({ id: callID, sessionID, messageID }, event.workspaceDirectory)
      : true;

    let state: ToolState;
    const time = { start: 0, end: 0 };
    switch (event.type) {
      case 'session.next.tool.input.started':
        return event;
      case 'session.next.tool.input.delta': {
        const delta = string(source.delta) || string(source.text) || string(source.input);
        const remaining = Math.max(0, MAX_PENDING_INPUT_CHARACTERS - tracked.inputCharacters);
        const fragment = delta.slice(0, remaining);
        properties.delta = fragment;
        tracked.inputCharacters += fragment.length;
        if (delta.length > remaining) properties.deferred = reference;
        break;
      }
      case 'session.next.tool.input.ended': {
        const raw = string(source.text) || string(source.input);
        state = { status: 'pending', raw, input: parseInput(raw) };
        const part = this.summarize(
          name,
          state,
          sessionID,
          messageID,
          callID,
          event.workspaceDirectory
        );
        properties.text = part.deferred ? JSON.stringify(part.state.input) : raw;
        if (part.deferred) properties.deferred = reference;
        if (part.state.deferredFiles) properties.deferredFiles = part.state.deferredFiles;
        break;
      }
      case 'session.next.tool.called': {
        state = {
          status: 'running',
          input: isString(source.input) ? parseInput(source.input) : (asRecord(source.input) ?? {}),
          title: string(source.title) || name,
          metadata: asRecord(source.provider) ?? {},
          time,
        };
        const part = this.summarize(
          name,
          state,
          sessionID,
          messageID,
          callID,
          event.workspaceDirectory
        );
        properties.input = part.state.input;
        properties.title = part.state.title;
        properties.provider = part.state.metadata;
        if (part.deferred) properties.deferred = reference;
        if (part.state.deferredFiles) properties.deferredFiles = part.state.deferredFiles;
        break;
      }
      case 'session.next.tool.progress': {
        state = {
          status: 'running',
          input: {},
          time,
          metadata: {
            ...asRecord(source.structured),
            structured: source.structured,
            content: source.content === undefined ? undefined : textContent(source.content),
            progress: source.progress,
          },
        };
        const part = this.summarize(
          name,
          state,
          sessionID,
          messageID,
          callID,
          event.workspaceDirectory
        );
        properties.structured = part.state.metadata?.structured;
        properties.content = part.state.metadata?.content;
        properties.progress = part.state.metadata?.progress;
        if (part.deferred) properties.deferred = reference;
        if (part.state.deferredFiles?.length) properties.deferredFiles = part.state.deferredFiles;
        break;
      }
      case 'session.next.tool.success': {
        const content = textContent(source.content);
        const structured = asRecord(source.structured);
        const output =
          content.map((item) => item.text).join('\n') ||
          string(source.output) ||
          (structured ? JSON.stringify(structured, null, 2) : '');
        state = {
          status: 'completed',
          input: {},
          title: name,
          output,
          time,
          metadata: { ...structured, provider: source.provider, result: source.result },
        };
        const part = this.summarize(
          name,
          state,
          sessionID,
          messageID,
          callID,
          event.workspaceDirectory
        );
        properties.content = [{ type: 'text', text: part.state.output }];
        const { provider, result, ...summary } = part.state.metadata;
        properties.structured = Object.keys(summary).length > 0 ? summary : undefined;
        properties.provider = provider;
        properties.result = result;
        if (part.deferred) properties.deferred = reference;
        if (part.state.deferredFiles?.length) properties.deferredFiles = part.state.deferredFiles;
        break;
      }
      case 'session.next.tool.failed': {
        state = {
          status: 'error',
          input: {},
          time,
          error:
            string(source.error) ||
            string(asRecord(source.error)?.message) ||
            'Tool execution failed',
          metadata: { provider: source.provider, result: source.result },
        };
        const part = this.summarize(
          name,
          state,
          sessionID,
          messageID,
          callID,
          event.workspaceDirectory
        );
        properties.error = part.state.error;
        properties.provider = part.state.metadata?.provider;
        properties.result = part.state.metadata?.result;
        if (part.deferred) properties.deferred = reference;
        break;
      }
      default:
        return event;
    }
    // SAFETY: Each branch retains the event's routing and projects its tool payload fields.
    return { ...event, properties } as ServerEvent;
  }

  private summarize<T extends ToolState>(
    tool: string,
    state: T,
    sessionID: string,
    messageID: string | undefined,
    id: string,
    directory: string | undefined
  ): ToolPart & { state: T } {
    return projectDeferredPart(
      { type: 'tool', tool, state, sessionID, messageID: messageID ?? '', id, callID: id },
      directory
    );
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native event fields are validated at this boundary.
function string(value: unknown): string {
  return isString(value) ? value : '';
}

function parseInput(raw: string): UnknownRecord {
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch {
    // Incomplete tool input is expected until the called snapshot arrives.
    return {};
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native content blocks are opaque JSON until their type is checked.
function textContent(value: unknown): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (record?.type === 'file' && isString(record.uri) && !record.uri.startsWith('data:'))
      return [{ type: 'text', text: record.uri }];
    return record?.type === 'text' && isString(record.text)
      ? [{ type: 'text', text: record.text }]
      : [];
  });
}
