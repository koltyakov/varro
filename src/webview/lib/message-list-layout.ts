type QueuedMessageRemovalHandler = (queuedMessageId: string) => void;
type PermissionRemovalHandler = (permissionId: string, removeGroup: boolean) => void;

let queuedMessageRemovalHandler: QueuedMessageRemovalHandler | null = null;
let permissionRemovalHandler: PermissionRemovalHandler | null = null;
const permissionRemovalIntents = new Map<string, { removeGroup: boolean; token: object }>();

export function registerQueuedMessageRemovalHandler(handler: QueuedMessageRemovalHandler) {
  queuedMessageRemovalHandler = handler;
  return () => {
    if (queuedMessageRemovalHandler === handler) queuedMessageRemovalHandler = null;
  };
}

export function prepareForQueuedMessageRemoval(queuedMessageId: string) {
  queuedMessageRemovalHandler?.(queuedMessageId);
}

export function registerPermissionRemovalHandler(handler: PermissionRemovalHandler) {
  permissionRemovalHandler = handler;
  return () => {
    if (permissionRemovalHandler === handler) permissionRemovalHandler = null;
  };
}

export function prepareForPermissionRemoval(permissionId: string, removeGroup: boolean) {
  permissionRemovalHandler?.(permissionId, shouldRemovePermissionGroup(permissionId, removeGroup));
}

export function shouldRemovePermissionGroup(permissionId: string, removeGroup: boolean) {
  return removeGroup || permissionRemovalIntents.get(permissionId)?.removeGroup === true;
}

export function registerPermissionRemovalIntent(
  permissionIds: readonly string[],
  removeGroup: boolean
) {
  const token = {};
  for (const permissionId of permissionIds) {
    permissionRemovalIntents.set(permissionId, { removeGroup, token });
  }
  return () => {
    for (const permissionId of permissionIds) {
      if (permissionRemovalIntents.get(permissionId)?.token === token) {
        permissionRemovalIntents.delete(permissionId);
      }
    }
  };
}
