/* oxlint-disable anti-slop/no-unknown-parameters -- OpenCode history responses are validated at this API boundary. */
import { apiCall } from '../../lib/bridge';
import { isObject, isString } from '../../lib/runtime-values';

type QueuedDispatch = { itemId: string; lease: number };
type QueuedHistoryRequest = { messageID: string; workspaceDirectory?: string };

export async function queuedMessageWasAdmitted(
  sessionId: string,
  messageId: string,
  workspaceDirectory: string | undefined,
  queuedMessageDispatch: QueuedDispatch
) {
  let before: string | undefined;
  const consumedCursors = new Set<string>();
  do {
    const params = new URLSearchParams({ limit: '200' });
    if (before) params.set('before', before);
    const path = `/session/${encodeURIComponent(sessionId)}/message?${params.toString()}`;
    const body: QueuedHistoryRequest = { messageID: messageId };
    if (workspaceDirectory) body.workspaceDirectory = workspaceDirectory;
    const response = await apiCall('GET', path, body, {
      queuedMessageDispatch,
    });
    const page = normalizeMessagePage(response);
    if (page.messageIds.includes(messageId)) return true;
    const nextCursor = page.nextCursor;
    if (!nextCursor) return false;
    if (consumedCursors.has(nextCursor)) {
      throw new Error('Queued message history cursor did not advance');
    }
    consumedCursors.add(nextCursor);
    before = nextCursor;
  } while (before);
  return false;
}

function normalizeMessagePage(value: unknown): { messageIds: string[]; nextCursor?: string } {
  const record = value && isObject(value) && !Array.isArray(value) ? value : null;
  const recordItems = record && 'items' in record ? record.items : undefined;
  const items = Array.isArray(value) ? value : Array.isArray(recordItems) ? recordItems : null;
  if (!items) throw new Error('Malformed queued message history response');
  const messageIds = items.flatMap((item) => {
    if (!item || !isObject(item) || Array.isArray(item)) return [];
    const info = item.info;
    if (!info || !isObject(info) || Array.isArray(info) || !isString(info.id)) return [];
    return [info.id];
  });
  const nextCursor = record && 'nextCursor' in record ? record.nextCursor : undefined;
  if (nextCursor !== undefined && !isString(nextCursor)) {
    throw new Error('Malformed queued message history cursor');
  }
  return nextCursor ? { messageIds, nextCursor } : { messageIds };
}
