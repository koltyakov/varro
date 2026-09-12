/* oxlint-disable anti-slop/no-unknown-parameters -- Session metadata is an external OpenCode boundary; validate selections before restoring them. */
import type { ChatModelSelection } from './protocol';
import { asRecord, isString } from './type-utils';

export type SessionSelectionMetadata = {
  varroModel?: ChatModelSelection;
  varroAgent?: string;
};

export function readSessionModelMetadata(metadata: unknown): ChatModelSelection | undefined {
  const model = asRecord(asRecord(metadata)?.varroModel);
  if (
    !isString(model?.providerID) ||
    !model.providerID.trim() ||
    !isString(model.modelID) ||
    !model.modelID.trim() ||
    (model.variant !== undefined && !isString(model.variant))
  )
    return undefined;
  const selection: ChatModelSelection = { providerID: model.providerID, modelID: model.modelID };
  if (model.variant) selection.variant = model.variant;
  return selection;
}

export function readSessionAgentMetadata(metadata: unknown): string | undefined {
  const agent = asRecord(metadata)?.varroAgent;
  return isString(agent) && agent.trim() ? agent : undefined;
}
