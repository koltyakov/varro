import { storePath } from '@solidjs/signals';
import { snapshot } from 'solid-js';
import { isFunction } from './runtime-values';
import type { QueuedMessage } from './app-state-types';
import { prepareForQueuedMessageRemoval } from './message-list-layout';
import { setState } from './app-state';
import { postMessage } from './bridge';
import { STORAGE_KEYS, writeStored } from './state-storage';
import { readWebviewInstanceContext } from './state-stored-values';

let nextQueueClaimRequestId = 0;
let pendingQueueMutationId: string | undefined;
const pendingQueueClaims = new Map<
  number,
  {
    itemId: string;
    sessionId: string;
    resolve(lease: number | null): void;
    timer: ReturnType<typeof setTimeout>;
  }
>();

export function ownsQueuedMessage(message: QueuedMessage) {
  const ownerViewId = readWebviewInstanceContext()?.viewId ?? 'sidebar';
  return (message.ownerViewId ?? 'sidebar') === ownerViewId;
}

export function claimQueuedMessageDispatch(
  message: QueuedMessage,
  mode: 'next' | 'steer' = 'next'
): Promise<number | null> {
  if (!ownsQueuedMessage(message)) return Promise.resolve(null);
  const requestId = ++nextQueueClaimRequestId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingQueueClaims.delete(requestId);
      resolve(null);
    }, 5_000);
    pendingQueueClaims.set(requestId, {
      itemId: message.id,
      sessionId: message.sessionId,
      resolve,
      timer,
    });
    if (
      !postMessage({
        type: 'queued-messages/claim',
        payload:
          mode === 'next'
            ? { requestId, itemId: message.id, sessionId: message.sessionId }
            : { requestId, itemId: message.id, sessionId: message.sessionId, mode },
      })
    ) {
      clearTimeout(timer);
      pendingQueueClaims.delete(requestId);
      setQueuedMessageFailed(message.id, true);
      resolve(null);
    }
  });
}

export function applyQueuedMessageClaimResult(payload: {
  requestId: number;
  itemId: string;
  sessionId: string;
  granted: boolean;
  lease?: number;
  deniedReason?: 'missing';
}) {
  const pending = pendingQueueClaims.get(payload.requestId);
  if (!pending) {
    if (payload.granted && payload.lease !== undefined) {
      postMessage({
        type: 'queued-messages/release',
        payload: { itemId: payload.itemId, sessionId: payload.sessionId, lease: payload.lease },
      });
    }
    return;
  }
  clearTimeout(pending.timer);
  pendingQueueClaims.delete(payload.requestId);
  const matches = pending.itemId === payload.itemId && pending.sessionId === payload.sessionId;
  if (matches && !payload.granted && payload.deniedReason === 'missing') {
    setQueuedMessageFailed(payload.itemId, true);
  }
  pending.resolve(matches && payload.granted && payload.lease !== undefined ? payload.lease : null);
}

export function releaseQueuedMessageDispatch(message: QueuedMessage, lease: number) {
  postMessage({
    type: 'queued-messages/release',
    payload: { itemId: message.id, sessionId: message.sessionId, lease },
  });
}

function commitQueuedMessages(
  update: QueuedMessage[] | ((current: QueuedMessage[]) => QueuedMessage[])
) {
  let messages: QueuedMessage[] = [];
  setState((draft) => {
    draft.queuedMessages = isFunction(update) ? update(draft.queuedMessages) : update;
    messages = snapshot(draft.queuedMessages);
  });
  reconcileQueuedMessageState(messages);
  const ownedMessages = messages.filter(ownsQueuedMessage);
  // Data URLs can make queued media messages tens of megabytes. Persist them through the
  // asynchronous extension bridge, but not synchronously in webview state and localStorage.
  const browserPersisted = ownedMessages.filter(
    (message) =>
      (message.clipboardImages?.length ?? 0) === 0 && (message.nativePdfs?.length ?? 0) === 0
  );
  writeStored(STORAGE_KEYS.queuedMessages, browserPersisted);
  const hostPersisted = ownedMessages.map(
    ({
      id,
      ownerViewId,
      messageId,
      sessionId,
      text,
      followupTitle,
      agent,
      paused,
      droppedFiles = [],
      clipboardImages = [],
      nativePdfs = [],
      terminalSelection = null,
      attachedDiagnostics,
      inlineProblems,
      queuedContext,
    }) => ({
      id,
      ownerViewId,
      messageId: messageId || undefined,
      sessionId,
      text,
      followupTitle,
      agent: agent || undefined,
      paused: paused ? true : undefined,
      droppedFiles,
      clipboardImages,
      nativePdfs: nativePdfs.length > 0 ? nativePdfs : undefined,
      terminalSelection,
      attachedDiagnostics: attachedDiagnostics || undefined,
      inlineProblems,
      queuedContext,
    })
  );
  pendingQueueMutationId = crypto.randomUUID();
  if (
    !postMessage({
      type: 'queued-messages/update',
      payload: { messages: hostPersisted, mutationId: pendingQueueMutationId },
    })
  ) {
    pendingQueueMutationId = undefined;
  }
}

function reconcileQueuedMessageState(messages: QueuedMessage[], preserveMissingEdit = false) {
  const ids = new Set(messages.map((message) => message.id));
  setState((draft) => {
    if (draft.queuedMessageDispatchingId && !ids.has(draft.queuedMessageDispatchingId)) {
      draft.queuedMessageDispatchingId = null;
    }
    if (!preserveMissingEdit && draft.queuedMessageEdit && !ids.has(draft.queuedMessageEdit.id)) {
      draft.queuedMessageEdit = null;
    }
    const failedIds = draft.failedQueuedMessageIds.filter((id) => ids.has(id));
    if (failedIds.length !== draft.failedQueuedMessageIds.length) {
      draft.failedQueuedMessageIds = failedIds;
    }
  });
}

export function syncQueuedMessages() {
  commitQueuedMessages((messages) => messages);
}

export function setQueuedMessageDispatchingId(id: string | null) {
  setState(storePath('queuedMessageDispatchingId', id));
}

export function setQueuedMessageFailed(id: string, failed: boolean) {
  setState((draft) => {
    const ids = new Set(draft.failedQueuedMessageIds);
    if (failed) ids.add(id);
    else ids.delete(id);
    draft.failedQueuedMessageIds = [...ids];
  });
}

export function setQueuedMessageEdit(edit: { id: string; sessionId: string } | null) {
  setState(storePath('queuedMessageEdit', edit));
  writeStored(STORAGE_KEYS.queuedMessageEdit, edit);
}

export function enqueueMessage(message: QueuedMessage) {
  const context = readWebviewInstanceContext();
  const ownedMessage =
    context?.surface === 'editor' ? { ...message, ownerViewId: context.viewId } : message;
  commitQueuedMessages((current) => [...current, ownedMessage]);
}

export function applyQueuedMessagesSnapshot(messages: QueuedMessage[], mutationId?: string) {
  // An older persistence echo must not erase a newer local enqueue, edit, or removal.
  if (pendingQueueMutationId && mutationId && mutationId !== pendingQueueMutationId) return;
  pendingQueueMutationId = undefined;
  setState(storePath('queuedMessages', messages));
  reconcileQueuedMessageState(messages, true);
  const browserPersisted = messages
    .filter(ownsQueuedMessage)
    .filter(
      (message) =>
        (message.clipboardImages?.length ?? 0) === 0 && (message.nativePdfs?.length ?? 0) === 0
    );
  writeStored(STORAGE_KEYS.queuedMessages, browserPersisted);
}

export function replaceQueuedMessage(id: string, message: QueuedMessage) {
  let replaced = false;
  setState((draft) => {
    const next = [...draft.queuedMessages];
    const index = next.findIndex((item) => item.id === id);
    if (index === -1) return;
    const existing = next[index]!;
    if (!ownsQueuedMessage(existing)) return;
    next[index] = { ...message, ownerViewId: existing.ownerViewId };
    commitQueuedMessages(next);
    replaced = true;
  });
  return replaced;
}

export function removeQueuedMessage(id: string) {
  setState((draft) => {
    const message = draft.queuedMessages.find((item) => item.id === id);
    if (!message || !ownsQueuedMessage(message)) return;
    const next = draft.queuedMessages.filter((item) => item.id !== id);
    if (next.length === draft.queuedMessages.length) return;
    prepareForQueuedMessageRemoval(id);
    commitQueuedMessages(next);
  });
}

export function setQueuedMessagePaused(id: string, paused: boolean, allForSession = false) {
  setState((draft) => {
    const message = draft.queuedMessages.find((item) => item.id === id);
    if (!message || !ownsQueuedMessage(message)) return;
    let changed = false;
    draft.queuedMessages.forEach((item) => {
      if (item.id !== id && (!allForSession || item.sessionId !== message.sessionId)) return;
      if (!ownsQueuedMessage(item)) return;
      if ((item.paused === true) === paused) return;
      item.paused = paused ? true : undefined;
      changed = true;
    });
    if (changed) syncQueuedMessages();
  });
}

export function reorderQueuedMessage(id: string, targetId: string) {
  if (id === targetId) return;
  setState((draft) => {
    const message = draft.queuedMessages.find((item) => item.id === id);
    const target = draft.queuedMessages.find((item) => item.id === targetId);
    if (
      !message ||
      !target ||
      !ownsQueuedMessage(message) ||
      !ownsQueuedMessage(target) ||
      message.sessionId !== target.sessionId
    ) {
      return;
    }

    const sessionMessages = draft.queuedMessages.filter(
      (item) => item.sessionId === message.sessionId
    );
    const sourceIndex = sessionMessages.findIndex((item) => item.id === id);
    const targetIndex = sessionMessages.findIndex((item) => item.id === targetId);
    const moved = sessionMessages[sourceIndex];
    if (!moved || targetIndex === -1) return;

    sessionMessages.splice(sourceIndex, 1);
    sessionMessages.splice(targetIndex, 0, moved);
    let sessionIndex = 0;
    const next = draft.queuedMessages.map((item) => {
      if (item.sessionId !== message.sessionId) return item;
      return sessionMessages[sessionIndex++] ?? item;
    });
    commitQueuedMessages(next);
  });
}

export function clearQueuedMessagesForSession(sessionId: string) {
  setState((draft) => {
    const next = draft.queuedMessages.filter(
      (item) => item.sessionId !== sessionId || !ownsQueuedMessage(item)
    );
    if (next.length === draft.queuedMessages.length) return;
    commitQueuedMessages(next);
  });
}
