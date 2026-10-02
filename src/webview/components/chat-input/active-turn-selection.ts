import type { ChatModelSelection } from '../../../shared/protocol';
import { normalizeModelVariant } from '../../../shared/model-variant';
import type { MessageEntry } from '../../types';

export const QUEUE_ONLY_SELECTION_TOOLTIP =
  'Only queueing is available until agent, model, and reasoning match the active turn.';

export function getActiveTurnSelection(messages: readonly MessageEntry[], sessionId: string) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]!.info;
    if (info.sessionID !== sessionId) continue;
    if (info.role === 'user' && (info.pendingDelivery || info.delivery === 'steer')) continue;
    // The active prompt is normally near the tail. Scanning from the beginning also makes
    // the caller track metadata for every unrelated historical message on each selection check.
    const parent =
      info.role === 'assistant'
        ? messages.findLast(
            (entry) => entry.info.sessionID === sessionId && entry.info.id === info.parentID
          )?.info
        : undefined;
    const parentModel = parent?.role === 'user' ? parent.model : undefined;
    const activeModel =
      info.role === 'user'
        ? info.model
        : {
            providerID: info.providerID,
            modelID: info.modelID,
            variant:
              info.variant ??
              (parentModel?.providerID === info.providerID && parentModel.modelID === info.modelID
                ? parentModel.variant
                : undefined),
          };
    const activeAgent = info.agent ?? (parent?.role === 'user' ? parent.agent : undefined);
    return { agent: activeAgent, model: activeModel };
  }
  return null;
}

export function matchesActiveTurnSelection(
  messages: readonly MessageEntry[],
  sessionId: string,
  agent: string | null | undefined,
  model: ChatModelSelection | null | undefined
) {
  const active = getActiveTurnSelection(messages, sessionId);
  return (
    !!active &&
    !!model &&
    !!agent &&
    agent === active.agent &&
    model.providerID === active.model.providerID &&
    model.modelID === active.model.modelID &&
    normalizeModelVariant(model.modelID, model.variant) ===
      normalizeModelVariant(active.model.modelID, active.model.variant)
  );
}
