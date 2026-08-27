import { createSignal } from 'solid-js';
import {
  claimQueuedMessageDispatch,
  getSelectedModelForSession,
  ownsQueuedMessage,
  releaseQueuedMessageDispatch,
  removeQueuedMessage,
  replaceQueuedMessage,
  setState,
  state,
} from '../../lib/state';
import { sendMessage } from '../../hooks/useOpenCode';
import { isString, isObject } from '../../lib/runtime-values';
import { createOpenCodeMessageID } from '../../../shared/opencode-id';
import { queuedMessageWasAdmitted } from './queued-message-history';
import type { ChatModelSelection, QueuedContextSnapshot } from '../../../shared/protocol';
import type { Provider } from '../../types';

const [steeringQueuedMessageIds, setSteeringQueuedMessageIds] = createSignal<ReadonlySet<string>>(
  new Set()
);
const [failedSteerQueuedMessageIds, setFailedSteerQueuedMessageIds] = createSignal<
  ReadonlySet<string>
>(new Set());

export { steeringQueuedMessageIds, failedSteerQueuedMessageIds };

type QueuedModelSnapshot = NonNullable<QueuedContextSnapshot['editorContext']['queuedModel']>;

export function sendWithQueuedModelSnapshot<T>(
  item: (typeof state.queuedMessages)[number],
  send: (selectedModel: ChatModelSelection | undefined) => Promise<T>
): Promise<T> {
  const snapshot = item.queuedContext?.editorContext.queuedModel;
  const selectedModel =
    snapshot?.selection ?? getSelectedModelForSession(item.sessionId) ?? undefined;
  if (!snapshot) return send(selectedModel);

  const previousProviders = [...state.providers];
  setState('providers', applyQueuedModelCapabilities(previousProviders, snapshot));
  try {
    return send(selectedModel);
  } finally {
    setState('providers', previousProviders);
  }
}

function applyQueuedModelCapabilities(
  providers: Provider[],
  snapshot: QueuedModelSnapshot
): Provider[] {
  const { providerID, modelID } = snapshot.selection;
  const provider = providers.find((item) => item.id === providerID);
  const existingModel = provider?.models[modelID];
  const existingInput = existingModel?.capabilities.input;
  const input = Array.isArray(existingInput)
    ? snapshot.capabilities.pdf
      ? [...new Set([...existingInput, 'pdf'])]
      : existingInput.filter((modality) => modality !== 'pdf')
    : existingInput
      ? { ...existingInput, pdf: snapshot.capabilities.pdf }
      : snapshot.capabilities.pdf
        ? ['pdf']
        : undefined;
  const variant = snapshot.selection.variant;
  const model = {
    ...(existingModel ?? {
      id: modelID,
      name: modelID,
      cost: { input: 0, output: 0 },
    }),
    capabilities: {
      ...existingModel?.capabilities,
      vision: snapshot.capabilities.vision,
      toolcall: snapshot.capabilities.tools,
      input,
    },
    variants: variant
      ? { ...existingModel?.variants, [variant]: existingModel?.variants?.[variant] ?? {} }
      : existingModel?.variants,
  };
  if (provider) {
    return providers.map((item) =>
      item === provider ? { ...item, models: { ...item.models, [modelID]: model } } : item
    );
  }
  return [
    ...providers,
    {
      id: providerID,
      name: providerID,
      source: 'custom',
      models: { [modelID]: model },
    },
  ];
}

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
  const workspaceDirectory = item.queuedContext?.editorContext.workspacePath ?? undefined;
  if (!priorAttemptId) replaceQueuedMessage(item.id, { ...item, messageId });
  let sent = false;
  let dispatchLease: number | null = null;
  try {
    if (priorAttemptId) {
      dispatchLease = await claimQueuedMessageDispatch(item, 'steer');
      if (dispatchLease === null) return;
      const admitted = await queuedMessageWasAdmitted(
        item.sessionId,
        priorAttemptId,
        workspaceDirectory,
        { itemId: item.id, lease: dispatchLease }
      );
      releaseQueuedMessageDispatch(item, dispatchLease);
      dispatchLease = null;
      if (admitted) {
        removeQueuedMessage(item.id);
        return;
      }
    }
    dispatchLease = await claimQueuedMessageDispatch(item, 'steer');
    if (dispatchLease === null) return;
    if (state.messagesLoading && state.activeSessionId === item.sessionId) return;
    sent = await sendWithQueuedModelSnapshot(item, async (selectedModel) => {
      const options: NonNullable<Parameters<typeof sendMessage>[1]> & {
        selectedModel?: ChatModelSelection;
      } = {
        messageId,
        delivery: 'steer' as const,
        agent: item.agent ? item.agent : undefined,
        queuedAttachments: {
          droppedFiles: item.droppedFiles,
          clipboardImages: item.clipboardImages,
          nativePdfs: item.nativePdfs,
          terminalSelection: item.terminalSelection,
          attachedDiagnostics: item.attachedDiagnostics ? item.attachedDiagnostics : undefined,
        },
        queuedContext: item.queuedContext,
        preserveComposer: true,
        targetSessionId: item.sessionId,
        workspaceDirectory,
        queuedMessageDispatch: { itemId: item.id, lease: dispatchLease! },
      };
      if (selectedModel) options.selectedModel = selectedModel;
      return (await sendMessage(item.text, options)) !== false;
    });
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
