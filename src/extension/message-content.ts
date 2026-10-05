import { asRecord, isString, type UnknownRecord } from '../shared/type-utils';
import { getToolFileChanges } from '../shared/tool-file-change';
import type { ToolState } from '../shared/opencode-types';
import { getToolKind } from '../shared/tool-normalization';
import { getSearchResultCount } from '../shared/tool-summary';

export function projectPartAttachments<T extends UnknownRecord>(part: T, directory?: string): T {
  const state = asRecord(part.state);
  if (part.type !== 'tool' || !state || !Array.isArray(state.attachments)) return part;
  return {
    ...part,
    state: {
      ...state,
      attachments: state.attachments.map((attachment) => {
        const file = asRecord(attachment);
        return file ? projectDeferredPart(file, directory) : attachment;
      }),
    },
  };
}

export function projectDeferredPart<T extends UnknownRecord>(
  part: T,
  directory?: string
): T & { deferred?: string } {
  if (part.type === 'file' && isString(part.url)) {
    return { ...part, url: `varro-content:${deferredPartPath(part, directory)}` };
  }
  if (
    part.type === 'reasoning' &&
    asRecord(part.time)?.end !== undefined &&
    isString(part.text) &&
    part.text.length > 512
  ) {
    return {
      ...part,
      text: part.text.slice(0, 512),
      metadata: undefined,
      deferred: deferredPartPath(part, directory),
    };
  }
  const state = asRecord(part.state);
  if (part.type === 'tool' && state) {
    const kind = getToolKind(String(part.tool));
    // These tools feed visible answer/todo summaries rather than collapsed detail bodies.
    if (kind === 'question' || kind === 'todo') return projectPartAttachments(part, directory);
    const output = isString(state.output) ? state.output : '';
    const metadata = asRecord(state.metadata) ?? {};
    const attachments = Array.isArray(state.attachments)
      ? state.attachments.map((attachment) => {
          const file = asRecord(attachment);
          return file ? projectDeferredPart(file, directory) : attachment;
        })
      : state.attachments;
    let omitted = false;
    let remaining = 16 * 1024;
    let nodes = 512;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Tool-specific JSON fields remain opaque; this projection only bounds embedded strings.
    const summarize = (value: unknown, key = '', depth = 0): unknown => {
      if (nodes-- <= 0 || depth > 12 || remaining <= 0) {
        omitted = true;
        return undefined;
      }
      if (isString(value)) {
        const limit = /^(?:.*path|filename|directory|sessionID|sessionId|task_id)$/i.test(key)
          ? 4096
          : 512;
        const text = /^data:[^,]*;base64,/i.test(value)
          ? ''
          : value.slice(0, Math.min(limit, remaining));
        remaining -= text.length;
        if (text.length !== value.length) omitted = true;
        return text;
      }
      if (Array.isArray(value)) {
        const items = [];
        for (const item of value) {
          if (nodes <= 0 || remaining <= 0) {
            omitted = true;
            break;
          }
          items.push(summarize(item, '', depth + 1));
        }
        // oxlint-disable-next-line anti-slop/no-known-value-widening -- This recursive JSON projection also returns scalars and records.
        return items;
      }
      const record = asRecord(value);
      if (!record) return value;
      const result: UnknownRecord = {};
      for (const field in record) {
        if (!Object.hasOwn(record, field)) continue;
        if (nodes <= 0 || remaining <= 0 || field.length > remaining) {
          omitted = true;
          break;
        }
        remaining -= field.length;
        result[field] = summarize(record[field], field, depth + 1);
      }
      // oxlint-disable-next-line anti-slop/no-known-value-widening -- Tool JSON has no shared schema beyond this bounded traversal.
      return result;
    };
    const input = summarize(state.input);
    const projectedMetadata = summarize(metadata);
    const error = summarize(state.error);
    const raw = summarize(state.raw);
    const title = summarize(state.title);
    const partMetadata = summarize(part.metadata);
    if (output.length > 512 || omitted) {
      const common = { input: asRecord(state.input) ?? {}, metadata, time: { start: 0, end: 0 } };
      const summaryState: ToolState =
        state.status === 'pending'
          ? { status: 'pending', input: common.input, raw: isString(state.raw) ? state.raw : '' }
          : state.status === 'running'
            ? { ...common, status: 'running' }
            : state.status === 'completed'
              ? {
                  ...common,
                  status: 'completed',
                  output,
                  title: isString(state.title) ? state.title : '',
                }
              : {
                  ...common,
                  status: 'error',
                  error: isString(state.error) ? state.error : '',
                };
      const files = getToolFileChanges(String(part.tool), summaryState).map(
        ({ before, after, patch: _patch, ...file }) => ({
          ...file,
          additions:
            file.additions ??
            (file.kind === 'added' && after ? after.split('\n').length : undefined),
          deletions:
            file.deletions ??
            (file.kind === 'removed' && before ? before.split('\n').length : undefined),
        })
      );
      const count = getSearchResultCount(String(part.tool), summaryState);
      return {
        ...part,
        deferred: deferredPartPath(part, directory),
        metadata: partMetadata,
        state: {
          ...state,
          input: asRecord(input) ?? {},
          output: output.slice(0, 512),
          error,
          raw,
          title,
          metadata: count
            ? { ...asRecord(projectedMetadata), matches: count.count, truncated: count.truncated }
            : (asRecord(projectedMetadata) ?? {}),
          attachments,
          deferredFiles: files,
        },
      };
    }
    if (attachments !== state.attachments) return { ...part, state: { ...state, attachments } };
  }
  return part;
}

export function deferredPartPath(
  part: { sessionID?: unknown; messageID?: unknown; id?: unknown },
  directory?: string
): string {
  const path = `/session/${encodeURIComponent(String(part.sessionID))}/message/${encodeURIComponent(String(part.messageID))}/part/${encodeURIComponent(String(part.id))}`;
  return directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;
}
