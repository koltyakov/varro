import { createSignal } from 'solid-js';
import { state, removeQueuedMessage } from '../../lib/state';
import { sendMessage } from '../../hooks/useOpenCode';

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

export function getPromptEventText(prompt: unknown) {
  if (!prompt || typeof prompt !== 'object') return null;
  const text = (prompt as { text?: unknown }).text;
  return typeof text === 'string' ? text : null;
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
  if (steeringQueuedMessageIds().has(item.id)) return;
  updateQueuedSteerId(setSteeringQueuedMessageIds, item.id, true);
  updateQueuedSteerId(setFailedSteerQueuedMessageIds, item.id, false);
  let sent = false;
  try {
    sent =
      (await sendMessage(item.text, {
        delivery: 'steer',
        queuedAttachments: {
          droppedFiles: item.droppedFiles,
          clipboardImages: item.clipboardImages,
          terminalSelection: item.terminalSelection,
        },
        preserveComposer: true,
      })) !== false;
  } catch {
    sent = false;
  } finally {
    updateQueuedSteerId(setSteeringQueuedMessageIds, item.id, false);
  }
  if (sent) {
    removeQueuedMessage(item.id);
    return;
  }
  if (!state.queuedMessages.some((queued) => queued.id === item.id)) return;
  updateQueuedSteerId(setFailedSteerQueuedMessageIds, item.id, true);
}
