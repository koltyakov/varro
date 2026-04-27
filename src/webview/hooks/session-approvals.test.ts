import { describe, expect, it, vi } from 'vitest';
import type { Permission, Session } from '../types';
import {
  autoApprovePermissionsForSessionWithDependencies,
  rejectQuestionWithDependencies,
  respondPermissionWithDependencies,
  respondQuestionWithDependencies,
  updatePermissionModeForSessionWithDependencies,
} from './session-approvals';

function permission(
  id: string,
  sessionID = 'session-1',
  overrides?: Partial<Permission>
): Permission {
  return {
    id,
    type: 'apply_patch',
    sessionID,
    messageID: 'message-1',
    title: 'apply_patch',
    metadata: {},
    time: { created: 0 },
    ...overrides,
  };
}

function session(id = 'session-1'): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: 'Session',
    version: '1',
    time: { created: 0, updated: 0 },
  };
}

describe('session-approvals helpers', () => {
  it('responds to grouped permissions and removes all members', async () => {
    const removePermission = vi.fn();
    const respondPermission = vi.fn(async () => {});

    await respondPermissionWithDependencies(
      {
        getPermissions: () => [
          permission('perm-1', 'session-1', {
            groupMembers: [
              { id: 'perm-1', sessionID: 'session-1', messageID: 'message-1' },
              { id: 'perm-2', sessionID: 'session-2', messageID: 'message-2' },
            ],
          }),
        ],
        respondPermission,
        removePermission,
        setError: vi.fn(),
      },
      'session-1',
      'perm-1',
      'always'
    );

    expect(respondPermission).toHaveBeenCalledTimes(2);
    expect(removePermission).toHaveBeenCalledWith('perm-1');
    expect(removePermission).toHaveBeenCalledWith('perm-2');
  });

  it('answers and rejects questions through the question API', async () => {
    const removeQuestion = vi.fn();

    await respondQuestionWithDependencies(
      {
        replyQuestion: vi.fn(async () => {}),
        removeQuestion,
        setError: vi.fn(),
      },
      'question-1',
      [['yes']]
    );

    await rejectQuestionWithDependencies(
      {
        rejectQuestion: vi.fn(async () => {}),
        removeQuestion,
        setError: vi.fn(),
      },
      'question-2'
    );

    expect(removeQuestion).toHaveBeenCalledWith('question-1');
    expect(removeQuestion).toHaveBeenCalledWith('question-2');
  });

  it('auto-approves all pending permissions for a session', async () => {
    const respondPermission = vi.fn(async () => {});

    await autoApprovePermissionsForSessionWithDependencies(
      {
        respondPermission,
      },
      [permission('perm-1'), permission('perm-2')]
    );

    expect(respondPermission).toHaveBeenCalledWith('session-1', 'perm-1', 'always');
    expect(respondPermission).toHaveBeenCalledWith('session-1', 'perm-2', 'always');
  });

  it('updates permission mode and auto-approves full-access sessions', async () => {
    const setPermissionModeForSession = vi.fn();
    const setDraftPermissionMode = vi.fn();
    const saveProjectPermissionMode = vi.fn();
    const upsertSession = vi.fn();
    const autoApprovePermissionsForSession = vi.fn(async () => {});

    await updatePermissionModeForSessionWithDependencies(
      {
        getPermissionModeForSession: () => 'default',
        getDraftPermissionMode: () => 'default',
        setPermissionModeForSession,
        setDraftPermissionMode,
        saveProjectPermissionMode,
        updateSessionPermission: vi.fn(async () => session('session-1')),
        upsertSession,
        setError: vi.fn(),
        getPermissionsForSession: () => [permission('perm-1')],
        autoApprovePermissionsForSession,
      },
      'full',
      [{ permission: 'bash', pattern: '*', action: 'allow' }],
      'session-1'
    );

    expect(setPermissionModeForSession).toHaveBeenCalledWith('session-1', 'full');
    expect(setDraftPermissionMode).toHaveBeenCalledWith('full');
    expect(saveProjectPermissionMode).toHaveBeenCalledWith('full');
    expect(upsertSession).toHaveBeenCalledWith(session('session-1'));
    expect(autoApprovePermissionsForSession).toHaveBeenCalledWith([permission('perm-1')]);
  });

  it('rolls permission mode changes back when the remote update fails', async () => {
    const setPermissionModeForSession = vi.fn();
    const setDraftPermissionMode = vi.fn();
    const saveProjectPermissionMode = vi.fn();
    const setError = vi.fn();

    await updatePermissionModeForSessionWithDependencies(
      {
        getPermissionModeForSession: () => 'default',
        getDraftPermissionMode: () => 'default',
        setPermissionModeForSession,
        setDraftPermissionMode,
        saveProjectPermissionMode,
        updateSessionPermission: vi.fn(async () => {
          throw new Error('permission update failed');
        }),
        upsertSession: vi.fn(),
        setError,
        getPermissionsForSession: () => [],
        autoApprovePermissionsForSession: vi.fn(async () => {}),
      },
      'full',
      [{ permission: 'bash', pattern: '*', action: 'allow' }],
      'session-1'
    );

    expect(setPermissionModeForSession).toHaveBeenNthCalledWith(1, 'session-1', 'full');
    expect(setPermissionModeForSession).toHaveBeenNthCalledWith(2, 'session-1', 'default');
    expect(setDraftPermissionMode).toHaveBeenNthCalledWith(1, 'full');
    expect(setDraftPermissionMode).toHaveBeenNthCalledWith(2, 'default');
    expect(saveProjectPermissionMode).toHaveBeenNthCalledWith(1, 'full');
    expect(saveProjectPermissionMode).toHaveBeenNthCalledWith(2, 'default');
    expect(setError).toHaveBeenCalledWith('permission update failed');
  });
});
