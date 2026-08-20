import type { AutoApproveJudgeReference } from '../../shared/protocol';
import type { SelectedModel } from './app-state-types';
import type { Permission } from '../types';

/**
 * Builders for auto-approve judge request values that cross the webview
 * bridge. `vscode.postMessage` structured-clones its payload, and SolidJS
 * store reads return Proxy wrappers that structured clone rejects with
 * DataCloneError, so store-backed values must be rebuilt as plain objects
 * before they are sent.
 */

export function toPlainJudgeModel(model: SelectedModel | null): SelectedModel | null {
  if (!model) return null;
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    variant: model.variant ? model.variant : undefined,
  };
}

export function toApprovedPermissionReference(
  permission: Permission,
  response: AutoApproveJudgeReference['response']
): AutoApproveJudgeReference {
  return {
    type: permission.type,
    title: permission.title,
    response,
    pattern:
      permission.pattern !== undefined
        ? Array.isArray(permission.pattern)
          ? [...permission.pattern]
          : permission.pattern
        : undefined,
    metadata: permission.metadata ? deepPlainCopy(permission.metadata) : undefined,
  };
}

function deepPlainCopy<T>(value: T): T {
  // SAFETY: The surrounding shape or discriminator check establishes the T contract used below.
  return JSON.parse(JSON.stringify(value)) as T;
}
