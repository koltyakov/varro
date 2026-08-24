import { createSignal } from 'solid-js';
import {
  claimQueuedMessageDispatch,
  ownsQueuedMessage,
  releaseQueuedMessageDispatch,
  removeQueuedMessage,
  replaceQueuedMessage,
  state,
} from '../../lib/state';
import { sendMessage } from '../../hooks/useOpenCode';
import { isString, isObject } from '../../lib/runtime-values';
import { createOpenCodeMessageID } from '../../../shared/opencode-id';
import { queuedMessageWasAdmitted } from './queued-message-history';

const [steeringQueuedMessageIds, setSteeringQueuedMessageIds] = createSignal<ReadonlySet<string>>(
  new Set()
);
const [failedSteerQueuedMessageIds, setFailedSteerQueuedMessageIds] = createSignal<
  ReadonlySet<string>
>(new Set());

export { steeringQueuedMessageIds, failedSteerQueuedMessageIds };

function updateQueuedSteerId(
  setter: typeof setSteeringQueuedMessageIds,
  id: string,
  active: boolean
) {
  setter((ids) => {
    const next = new Set(ids);
    if (active) {
      next.add(id);
    } else {
      next.delete(id);
    }
    return next;
  });
}

export function getPromptEventText<T>(prompt: T) {
  if (!prompt || !isObject(prompt)) return null;
  // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
  const text = (prompt as { text?: unknown }).text;
  return isString(text) ? text : null;
}

function matchesQueuedPromptText(itemText: string, promptText: string | null) {
  const text = itemText.trim();
  if (!text) return true;
  const prompt = promptText?.trim();
  return !!prompt && (prompt === text || prompt.startsWith(`${text}\n`));
}

export function acceptQueuedSteer(sessionId: string, promptText: string | null) {
  const steeringIds = steeringQueuedMessageIds();
  const item = state.queuedMessages.find(
    (queued) =>
      ownsQueuedMessage(queued) &&
      queued.sessionId === sessionId &&
      steeringIds.has(queued.id) &&
      matchesQueuedPromptText(queued.text, promptText)
  );
  if (!item) return;
  updateQueuedSteerId(setSteeringQueuedMessageIds, item.id, false);
  updateQueuedSteerId(setFailedSteerQueuedMessageIds, item.id, false);
  removeQueuedMessage(item.id);
}

export async function sendQueuedAsSteer(item: (typeof state.queuedMessages)[number]) {
  if (!ownsQueuedMessage(item)) return;
  if (state.messagesLoading && state.activeSessionId === item.sessionId) return;
  if (steeringQueuedMessageIds().has(item.id)) return;
  updateQueuedSteerId(setSteeringQueuedMessageIds, item.id, true);
  updateQueuedSteerId(setFailedSteerQueuedMessageIds, item.id, false);
  const priorAttemptId = item.messageId;
  const messageId = priorAttemptId ?? createOpenCodeMessageID();
  if (!priorAttemptId) replaceQueuedMessage(item.id, { ...item, messageId });
  let sent = false;
  let dispatchLease: number | null = null;
  try {
    if (priorAttemptId && (await queuedMessageWasAdmitted(item.sessionId, priorAttemptId))) {
      removeQueuedMessage(item.id);
      return;
    }
    dispatchLease = await claimQueuedMessageDispatch(item, 'steer');
    if (dispatchLease === null) return;
    if (state.messagesLoading && state.activeSessionId === item.sessionId) return;
    sent =
      (await sendMessage(item.text, {
        messageId,
        delivery: 'steer',
        agent: item.agent ? item.agent : undefined,
        queuedAttachments: {
          droppedFiles: item.droppedFiles,
          clipboardImages: item.clipboardImages,
          nativePdfs: item.nativePdfs,
          terminalSelection: item.terminalSelection,
          attachedDiagnostics: item.attachedDiagnostics ? item.attachedDiagnostics : undefined,
        },
        preserveComposer: true,
        targetSessionId: item.sessionId,
        queuedMessageDispatch: { itemId: item.id, lease: dispatchLease },
      })) !== false;
  } catch {
    sent = false;
  } finally {
    if (!sent && dispatchLease !== null) releaseQueuedMessageDispatch(item, dispatchLease);
    updateQueuedSteerId(setSteeringQueuedMessageIds, item.id, false);
  }
  if (sent) {
    removeQueuedMessage(item.id);
    return;
  }
  if (!state.queuedMessages.some((queued) => queued.id === item.id)) return;
  updateQueuedSteerId(setFailedSteerQueuedMessageIds, item.id, true);
}
