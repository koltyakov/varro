import type { QueuedMessage } from './app-state-types';
import { setState, state } from './app-state';
import { STORAGE_KEYS, writeStored } from './state-storage';

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
  writeStored(STORAGE_KEYS.queuedMessages, messages);
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
  commitQueuedMessages([...state.queuedMessages, message]);
}

export function replaceQueuedMessage(id: string, message: QueuedMessage) {
  const next = [...state.queuedMessages];
  const index = next.findIndex((item) => item.id === id);
  if (index === -1) return false;
  next[index] = message;
  commitQueuedMessages(next);
  return true;
}

export function removeQueuedMessage(id: string) {
  const next = state.queuedMessages.filter((item) => item.id !== id);
  if (next.length === state.queuedMessages.length) return;
  commitQueuedMessages(next);
}

export function reorderQueuedMessage(id: string, targetId: string) {
  if (id === targetId) return;
  const message = state.queuedMessages.find((item) => item.id === id);
  const target = state.queuedMessages.find((item) => item.id === targetId);
  if (!message || !target || message.sessionId !== target.sessionId) return;

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
  const next = state.queuedMessages.filter((item) => item.sessionId !== sessionId);
  if (next.length === state.queuedMessages.length) return;
  commitQueuedMessages(next);
}
