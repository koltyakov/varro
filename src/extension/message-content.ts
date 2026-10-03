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
  const path = `/session/${encodeURIComponent(String(part.sessionID))}/message/${encodeURIComponent(String(part.messageID))}/part/${encodeURIComponent(String(part.id))}`;
  const deferred = directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;
  if (part.type === 'file' && isString(part.url)) {
    return { ...part, url: `varro-content:${deferred}` };
  }
  if (
    part.type === 'reasoning' &&
    asRecord(part.time)?.end !== undefined &&
    isString(part.text) &&
    part.text.length > 512
  ) {
    return { ...part, text: part.text.slice(0, 512), metadata: undefined, deferred };
  }
  const state = asRecord(part.state);
  if (part.type === 'tool' && state && (state.status === 'completed' || state.status === 'error')) {
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
    // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Tool-specific JSON fields remain opaque; this projection only bounds embedded strings.
    const summarize = (value: unknown, key = ''): unknown => {
      if (
        isString(value) &&
        value.length > 512 &&
        !/^(?:.*path|filename|directory|description|title|label|name|sessionID|sessionId|task_id)$/i.test(
          key
        )
      ) {
        omitted = true;
        return value.slice(0, 512);
      }
      if (Array.isArray(value)) return value.map((item) => summarize(item));
      const record = asRecord(value);
      return record
        ? Object.fromEntries(
            Object.entries(record).map(([field, item]) => [field, summarize(item, field)])
          )
        : value;
    };
    const input = summarize(state.input);
    const projectedMetadata = summarize(metadata);
    const error = summarize(state.error);
    if (output.length > 512 || omitted) {
      const common = { input: asRecord(state.input) ?? {}, metadata, time: { start: 0, end: 0 } };
      const summaryState: ToolState =
        state.status === 'completed'
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
        deferred,
        state: {
          ...state,
          input,
          output: output.slice(0, 512),
          error,
          metadata: count
            ? { ...asRecord(projectedMetadata), matches: count.count, truncated: count.truncated }
            : projectedMetadata,
          attachments,
          deferredFiles: files,
        },
      };
    }
    if (attachments !== state.attachments) return { ...part, state: { ...state, attachments } };
  }
  return part;
}
