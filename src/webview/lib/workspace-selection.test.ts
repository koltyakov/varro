import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebviewMessage } from '../../shared/protocol';
import { fixture } from '../test-fixtures';
import {
  error,
  manualWorkspaceSelection,
  resetDefaultAppState,
  setError,
  setManualWorkspaceSelection,
  setState,
  state,
} from './state';
import { handleWorkspaceSelectionFailure, requestWorkspaceSelection } from './workspace-selection';

describe('workspace selection', () => {
  const send = vi.fn<(message: WebviewMessage) => void>();

  beforeEach(() => {
    resetDefaultAppState();
    setError(null);
    setManualWorkspaceSelection(false);
    send.mockClear();
    fixture<{ __sendToExtension?: typeof send }>(window).__sendToExtension = send;
  });

  afterEach(() => {
    delete window.__sendToExtension;
  });

  it('correlates selections across callers, including repeated paths', () => {
    requestWorkspaceSelection('/repo-b');
    const firstId = state.workspaceSelectionRequestId;
    requestWorkspaceSelection('/repo-c');
    requestWorkspaceSelection('/repo-b');
    const latestId = state.workspaceSelectionRequestId;

    expect(latestId).not.toBe(firstId);
    expect(send).toHaveBeenLastCalledWith({
      type: 'workspace/select',
      payload: { path: '/repo-b', requestId: latestId },
    });
    if (firstId === null || latestId === null) throw new Error('Missing selection request ID');

    handleWorkspaceSelectionFailure({ requestId: firstId, path: '/repo-b', error: 'Old failure' });
    expect(state.pendingWorkspaceSelectionPath).toBe('/repo-b');
    expect(state.workspaceSelectionRequestId).toBe(latestId);
    expect(error()).toBeNull();

    handleWorkspaceSelectionFailure({
      requestId: latestId,
      path: '/repo-b',
      error: 'Selected workspace folder is not open',
    });
    expect(state.pendingWorkspaceSelectionPath).toBeNull();
    expect(state.workspaceSelectionRequestId).toBeNull();
    expect(manualWorkspaceSelection()).toBe(true);
    expect(error()).toContain('Selected workspace folder is not open');
  });

  it('ignores failure after local cancellation without sending another request', () => {
    requestWorkspaceSelection('/repo-b');
    const requestId = state.workspaceSelectionRequestId;
    requestWorkspaceSelection(null);
    if (requestId === null) throw new Error('Missing selection request ID');

    handleWorkspaceSelectionFailure({ requestId, path: '/repo-b', error: 'Late failure' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.pendingWorkspaceSelectionPath).toBeNull();
    expect(state.workspaceSelectionRequestId).toBeNull();
    expect(manualWorkspaceSelection()).toBe(false);
    expect(error()).toBeNull();
  });

  it('reports persistence failure even when context already acknowledged the endpoint switch', () => {
    requestWorkspaceSelection('/repo-b');
    const requestId = state.workspaceSelectionRequestId;
    setState('editorContext', 'workspacePath', '/repo-b');
    setState('pendingWorkspaceSelectionPath', null);
    if (requestId === null) throw new Error('Missing selection request ID');

    handleWorkspaceSelectionFailure({ requestId, path: '/repo-b', error: 'Storage unavailable' });
    expect(state.editorContext.workspacePath).toBe('/repo-b');
    expect(state.pendingWorkspaceSelectionPath).toBeNull();
    expect(error()).toContain('Storage unavailable');
    expect(manualWorkspaceSelection()).toBe(false);
  });
});
