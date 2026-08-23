import type { QueuedMessage } from './app-state-types';
import { prepareForQueuedMessageRemoval } from './message-list-layout';
import { setState, state } from './app-state';
import { postMessage } from './bridge';
import { STORAGE_KEYS, writeStored } from './state-storage';
import { readWebviewInstanceContext } from './state-stored-values';

function ownsQueuedMessage(message: QueuedMessage) {
  const ownerViewId = readWebviewInstanceContext()?.viewId ?? 'sidebar';
  return (message.ownerViewId ?? 'sidebar') === ownerViewId;
}

function commitQueuedMessages(messages: QueuedMessage[]) {
  setState('queuedMessages', messages);
  const ids = new Set(messages.map((message) => message.id));
  if (state.queuedMessageDispatchingId && !ids.has(state.queuedMessageDispatchingId)) {
    setState('queuedMessageDispatchingId', null);
  }
  if (state.queuedMessageEdit && !ids.has(state.queuedMessageEdit.id)) {
    setState('queuedMessageEdit', null);
  }
  const failedIds = state.failedQueuedMessageIds.filter((id) => ids.has(id));
  if (failedIds.length !== state.failedQueuedMessageIds.length) {
    setState('failedQueuedMessageIds', failedIds);
  }
  // Data URLs can make queued media messages tens of megabytes. Persist them through the
  // asynchronous extension bridge, but not synchronously in webview state and localStorage.
  const browserPersisted = messages.filter(
    (message) =>
      (message.clipboardImages?.length ?? 0) === 0 && (message.nativePdfs?.length ?? 0) === 0
  );
  writeStored(STORAGE_KEYS.queuedMessages, browserPersisted);
  const hostPersisted = messages.map(
    ({
      id,
      ownerViewId,
      messageId,
      sessionId,
      text,
      agent,
      paused,
      droppedFiles = [],
      clipboardImages = [],
      nativePdfs = [],
      terminalSelection = null,
      attachedDiagnostics,
      queuedContext,
    }) => ({
      id,
      ownerViewId,
      messageId: messageId || undefined,
      sessionId,
      text,
      agent: agent || undefined,
      paused: paused ? true : undefined,
      droppedFiles,
      clipboardImages,
      nativePdfs: nativePdfs.length > 0 ? nativePdfs : undefined,
      terminalSelection,
      attachedDiagnostics: attachedDiagnostics || undefined,
      queuedContext,
    })
  );
  postMessage({ type: 'queued-messages/update', payload: { messages: hostPersisted } });
}

export function syncQueuedMessages() {
  commitQueuedMessages([...state.queuedMessages]);
}

export function setQueuedMessageDispatchingId(id: string | null) {
  setState('queuedMessageDispatchingId', id);
}

export function setQueuedMessageFailed(id: string, failed: boolean) {
  const ids = new Set(state.failedQueuedMessageIds);
  if (failed) ids.add(id);
  else ids.delete(id);
  setState('failedQueuedMessageIds', [...ids]);
}

export function setQueuedMessageEdit(edit: { id: string; sessionId: string } | null) {
  setState('queuedMessageEdit', edit);
}

export function enqueueMessage(message: QueuedMessage) {
  const context = readWebviewInstanceContext();
  const ownedMessage =
    context?.surface === 'editor' ? { ...message, ownerViewId: context.viewId } : message;
  commitQueuedMessages([...state.queuedMessages, ownedMessage]);
}

export function applyQueuedMessagesSnapshot(messages: QueuedMessage[]) {
  setState('queuedMessages', messages);
}

export function replaceQueuedMessage(id: string, message: QueuedMessage) {
  const next = [...state.queuedMessages];
  const index = next.findIndex((item) => item.id === id);
  if (index === -1) return false;
  const existing = next[index]!;
  if (!ownsQueuedMessage(existing)) return false;
  next[index] = { ...message, ownerViewId: existing.ownerViewId };
  commitQueuedMessages(next);
  return true;
}

export function removeQueuedMessage(id: string) {
  const message = state.queuedMessages.find((item) => item.id === id);
  if (!message || !ownsQueuedMessage(message)) return;
  const next = state.queuedMessages.filter((item) => item.id !== id);
  if (next.length === state.queuedMessages.length) return;
  prepareForQueuedMessageRemoval(id);
  commitQueuedMessages(next);
}

export function setQueuedMessagePaused(id: string, paused: boolean, allForSession = false) {
  const message = state.queuedMessages.find((item) => item.id === id);
  if (!message || !ownsQueuedMessage(message)) return;
  let changed = false;
  state.queuedMessages.forEach((item, index) => {
    if (item.id !== id && (!allForSession || item.sessionId !== message.sessionId)) return;
    if (!ownsQueuedMessage(item)) return;
    if ((item.paused === true) === paused) return;
    setState('queuedMessages', index, 'paused', paused ? true : undefined);
    changed = true;
  });
  if (changed) syncQueuedMessages();
}

export function reorderQueuedMessage(id: string, targetId: string) {
  if (id === targetId) return;
  const message = state.queuedMessages.find((item) => item.id === id);
  const target = state.queuedMessages.find((item) => item.id === targetId);
  if (
    !message ||
    !target ||
    !ownsQueuedMessage(message) ||
    !ownsQueuedMessage(target) ||
    message.sessionId !== target.sessionId
  ) {
    return;
  }

  const sessionMessages = state.queuedMessages.filter(
    (item) => item.sessionId === message.sessionId
  );
  const sourceIndex = sessionMessages.findIndex((item) => item.id === id);
  const targetIndex = sessionMessages.findIndex((item) => item.id === targetId);
  const moved = sessionMessages[sourceIndex];
  if (!moved || targetIndex === -1) return;

  sessionMessages.splice(sourceIndex, 1);
  sessionMessages.splice(targetIndex, 0, moved);
  let sessionIndex = 0;
  const next = state.queuedMessages.map((item) => {
    if (item.sessionId !== message.sessionId) return item;
    return sessionMessages[sessionIndex++] ?? item;
  });
  commitQueuedMessages(next);
}

export function clearQueuedMessagesForSession(sessionId: string) {
  const next = state.queuedMessages.filter(
    (item) => item.sessionId !== sessionId || !ownsQueuedMessage(item)
  );
  if (next.length === state.queuedMessages.length) return;
  commitQueuedMessages(next);
}
