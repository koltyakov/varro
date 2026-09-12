/* oxlint-disable anti-slop/no-unknown-parameters -- Session metadata is an external OpenCode boundary; validate selections before restoring them. */
import { VARRO_SESSION_METADATA_VERSION } from './protocol';
import type { ChatModelSelection, PermissionMode } from './protocol';
import { asRecord, isString } from './type-utils';
import type { UnknownRecord } from './type-utils';

export type SessionSelectionMetadata = {
  model?: ChatModelSelection;
  agent?: string;
};

type VarroModelMetadata = {
  provider: string;
  model: string;
  variant?: string;
};

export function mergeVarroSessionMetadata(
  metadata: unknown,
  update: SessionSelectionMetadata & { permissionMode?: PermissionMode }
) {
  const existing = asRecord(metadata);
  const varro: UnknownRecord = {
    ...asRecord(existing?.varro),
    schemaVersion: VARRO_SESSION_METADATA_VERSION,
  };
  if (update.permissionMode !== undefined) varro.permissionMode = update.permissionMode;
  if (update.agent !== undefined) varro.agent = update.agent;
  if (update.model) {
    const model: VarroModelMetadata = {
      provider: update.model.providerID,
      model: update.model.modelID,
    };
    if (update.model.variant) model.variant = update.model.variant;
    varro.model = model;
  }
  return { ...existing, varro };
}

export function readSessionModelMetadata(metadata: unknown): ChatModelSelection | undefined {
  const model = asRecord(asRecord(asRecord(metadata)?.varro)?.model);
  if (
    !isString(model?.provider) ||
    !model.provider.trim() ||
    !isString(model.model) ||
    !model.model.trim() ||
    (model.variant !== undefined && !isString(model.variant))
  )
    return undefined;
  const selection: ChatModelSelection = { providerID: model.provider, modelID: model.model };
  if (model.variant) selection.variant = model.variant;
  return selection;
}

export function readSessionAgentMetadata(metadata: unknown): string | undefined {
  const agent = asRecord(asRecord(metadata)?.varro)?.agent;
  return isString(agent) && agent.trim() ? agent : undefined;
}
