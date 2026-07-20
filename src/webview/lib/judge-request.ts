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
    ...(model.variant ? { variant: model.variant } : {}),
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
    ...(permission.pattern !== undefined
      ? {
          pattern: Array.isArray(permission.pattern) ? [...permission.pattern] : permission.pattern,
        }
      : {}),
    ...(permission.metadata ? { metadata: deepPlainCopy(permission.metadata) } : {}),
  };
}

function deepPlainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
