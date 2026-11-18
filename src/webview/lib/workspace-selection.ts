import { storePath } from '@solidjs/signals';

import type { ExtensionMessage } from '../../shared/protocol';
import { postMessage } from './bridge';
import { setError, setManualWorkspaceSelection, setState, state } from './state';

let nextRequestId = 0;

export function requestWorkspaceSelection(path: string | null) {
  const requestId = path === null ? null : ++nextRequestId;
  (() => {
    setState(storePath('workspaceSelectionRequestId', requestId));
    setState(storePath('pendingWorkspaceSelectionPath', path));
  })();
  if (path !== null && requestId !== null) {
    postMessage({ type: 'workspace/select', payload: { path, requestId } });
  }
}

export function handleWorkspaceSelectionFailure(
  payload: Extract<ExtensionMessage, { type: 'workspace/select-failed' }>['payload']
) {
  if (payload.requestId !== state.workspaceSelectionRequestId) return;
  (() => {
    // Do not immediately repeat a failed automatic switch to the active editor's folder.
    if (state.pendingWorkspaceSelectionPath) setManualWorkspaceSelection(true);
    setState(storePath('pendingWorkspaceSelectionPath', null));
    setState(storePath('workspaceSelectionRequestId', null));
    setError(
      `Workspace selection failed for ${payload.path}: ${payload.error}. Select a workspace and try again.`
    );
  })();
}
