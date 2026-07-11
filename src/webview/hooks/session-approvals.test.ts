import { describe, expect, it, vi } from 'vitest';
import type { Permission, QuestionRequest, Session } from '../types';
import {
  autoApprovePermissionsForSessionWithDependencies,
  getQuestionById,
  rejectQuestionWithDependencies,
  respondPermissionWithDependencies,
  respondQuestionWithDependencies,
  SessionApprovalOperations,
  updatePermissionModeForSessionWithDependencies,
} from './session/session-approvals';

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

function question(id: string): QuestionRequest {
  return {
    id,
    sessionID: 'session-1',
    questions: [
      {
        header: 'Question',
        question: 'Continue?',
        options: [{ label: 'Yes', description: 'Approve' }],
      },
    ],
  };
}

describe('session-approvals helpers', () => {
  it('responds to the selected permission and clears covered prompts locally', async () => {
    const removePermission = vi.fn();
    const respondPermission = vi.fn(async () => {});

    await respondPermissionWithDependencies(
      {
        respondPermission,
        removePermission,
        setError: vi.fn(),
      },
      'session-1',
      'perm-1',
      'always'
    );

    expect(respondPermission).toHaveBeenCalledTimes(1);
    expect(respondPermission).toHaveBeenCalledWith('session-1', 'perm-1', 'always');
    expect(removePermission).toHaveBeenCalledWith('perm-1', { removeGroup: true });
  });

  it('keeps one-time approvals scoped to the selected permission', async () => {
    const removePermission = vi.fn();
    const respondPermission = vi.fn(async () => {});

    await respondPermissionWithDependencies(
      {
        respondPermission,
        removePermission,
        setError: vi.fn(),
      },
      'session-1',
      'perm-1',
      'once'
    );

    expect(respondPermission).toHaveBeenCalledWith('session-1', 'perm-1', 'once');
    expect(removePermission).toHaveBeenCalledWith('perm-1', { removeGroup: false });
  });

  it('rejects every grouped permission before clearing the group', async () => {
    const removePermission = vi.fn();
    const respondPermission = vi.fn(async () => {});

    await respondPermissionWithDependencies(
      {
        respondPermission,
        removePermission,
        setError: vi.fn(),
      },
      'session-1',
      'perm-1',
      'reject',
      {
        groupMembers: [
          { id: 'perm-1', sessionID: 'session-1' },
          { id: 'perm-2', sessionID: 'session-1' },
        ],
      }
    );

    expect(respondPermission.mock.calls).toEqual([
      ['session-1', 'perm-1', 'reject'],
      ['session-1', 'perm-2', 'reject'],
    ]);
    expect(removePermission).toHaveBeenCalledWith('perm-1', { removeGroup: true });
  });

  it('sets a fallback error and rethrows when permission responses fail', async () => {
    const setError = vi.fn();

    await expect(
      respondPermissionWithDependencies(
        {
          respondPermission: vi.fn(async () => {
            throw 'permission failed';
          }),
          removePermission: vi.fn(),
          setError,
        },
        'session-1',
        'perm-1',
        'reject',
        { rethrow: true }
      )
    ).rejects.toBe('permission failed');

    expect(setError).toHaveBeenCalledWith('Failed to respond to permission');
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

  it('surfaces question reply and rejection failures without removing the request', async () => {
    const removeQuestion = vi.fn();
    const setReplyError = vi.fn();
    const setRejectError = vi.fn();

    await respondQuestionWithDependencies(
      {
        replyQuestion: vi.fn(async () => {
          throw 'reply failed';
        }),
        removeQuestion,
        setError: setReplyError,
      },
      'question-1',
      [['no']]
    );

    await rejectQuestionWithDependencies(
      {
        rejectQuestion: vi.fn(async () => {
          throw new Error('reject failed');
        }),
        removeQuestion,
        setError: setRejectError,
      },
      'question-2'
    );

    expect(removeQuestion).not.toHaveBeenCalled();
    expect(setReplyError).toHaveBeenCalledWith('Failed to answer question');
    expect(setRejectError).toHaveBeenCalledWith('reject failed');
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
    const syncPendingPermissions = vi.fn(async () => {});

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
        syncPendingPermissions,
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
    expect(syncPendingPermissions).toHaveBeenCalledTimes(1);
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

  it('updates local permission state without a session id', async () => {
    const setPermissionModeForSession = vi.fn();
    const setDraftPermissionMode = vi.fn();
    const saveProjectPermissionMode = vi.fn();
    const updateSessionPermission = vi.fn();

    await updatePermissionModeForSessionWithDependencies(
      {
        getPermissionModeForSession: () => 'default',
        getDraftPermissionMode: () => 'default',
        setPermissionModeForSession,
        setDraftPermissionMode,
        saveProjectPermissionMode,
        updateSessionPermission,
        upsertSession: vi.fn(),
        setError: vi.fn(),
        getPermissionsForSession: vi.fn(() => []),
        autoApprovePermissionsForSession: vi.fn(async () => {}),
      },
      'default',
      [{ permission: 'bash', pattern: '*', action: 'ask' }],
      null
    );

    expect(setPermissionModeForSession).toHaveBeenCalledWith(null, 'default');
    expect(setDraftPermissionMode).toHaveBeenCalledWith('default');
    expect(saveProjectPermissionMode).toHaveBeenCalledWith('default');
    expect(updateSessionPermission).not.toHaveBeenCalled();
  });

  it('skips auto-approval when the mode is not full', async () => {
    const autoApprovePermissionsForSession = vi.fn(async () => {});
    const getPermissionsForSession = vi.fn(() => [permission('perm-1')]);

    await updatePermissionModeForSessionWithDependencies(
      {
        getPermissionModeForSession: () => 'full',
        getDraftPermissionMode: () => 'full',
        setPermissionModeForSession: vi.fn(),
        setDraftPermissionMode: vi.fn(),
        saveProjectPermissionMode: vi.fn(),
        updateSessionPermission: vi.fn(async () => session('session-1')),
        upsertSession: vi.fn(),
        setError: vi.fn(),
        getPermissionsForSession,
        autoApprovePermissionsForSession,
      },
      'default',
      [{ permission: 'bash', pattern: '*', action: 'ask' }],
      'session-1'
    );

    expect(getPermissionsForSession).not.toHaveBeenCalled();
    expect(autoApprovePermissionsForSession).not.toHaveBeenCalled();
  });

  it('syncs pending permissions when switching to auto mode', async () => {
    const autoApprovePermissionsForSession = vi.fn(async () => {});
    const getPermissionsForSession = vi.fn(() => [permission('perm-1')]);
    const syncPendingPermissions = vi.fn(async () => {});

    await updatePermissionModeForSessionWithDependencies(
      {
        getPermissionModeForSession: () => 'default',
        getDraftPermissionMode: () => 'default',
        setPermissionModeForSession: vi.fn(),
        setDraftPermissionMode: vi.fn(),
        saveProjectPermissionMode: vi.fn(),
        updateSessionPermission: vi.fn(async () => session('session-1')),
        upsertSession: vi.fn(),
        setError: vi.fn(),
        getPermissionsForSession,
        autoApprovePermissionsForSession,
        syncPendingPermissions,
      },
      'auto',
      [{ permission: 'bash', pattern: '*', action: 'ask' }],
      'session-1'
    );

    expect(getPermissionsForSession).not.toHaveBeenCalled();
    expect(autoApprovePermissionsForSession).not.toHaveBeenCalled();
    expect(syncPendingPermissions).toHaveBeenCalledTimes(1);
  });

  it('uses the generic update error for non-Error failures', async () => {
    const setError = vi.fn();

    await updatePermissionModeForSessionWithDependencies(
      {
        getPermissionModeForSession: () => 'default',
        getDraftPermissionMode: () => 'default',
        setPermissionModeForSession: vi.fn(),
        setDraftPermissionMode: vi.fn(),
        saveProjectPermissionMode: vi.fn(),
        updateSessionPermission: vi.fn(async () => {
          throw 'update failed';
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

    expect(setError).toHaveBeenCalledWith('Failed to update permissions');
  });

  it('finds questions by id and returns null for missing requests', () => {
    const questions = [question('question-1'), question('question-2')];

    expect(getQuestionById(questions, 'question-2')).toEqual(question('question-2'));
    expect(getQuestionById(questions, 'question-3')).toBeNull();
  });

  it('creates bound approval operations from shared dependencies', async () => {
    const respondRemotePermission = vi.fn(async () => {});
    const replyQuestion = vi.fn(async () => {});
    const rejectRemoteQuestion = vi.fn(async () => {});
    const updateSessionPermission = vi.fn(async () => session('session-1'));

    const operations = new SessionApprovalOperations({
      respondRemotePermission,
      removePermission: vi.fn(),
      setError: vi.fn(),
      replyQuestion,
      removeQuestion: vi.fn(),
      rejectRemoteQuestion,
      getPermissionModeForSession: () => 'default',
      getDraftPermissionMode: () => 'default',
      setPermissionModeForSession: vi.fn(),
      setDraftPermissionMode: vi.fn(),
      saveProjectPermissionMode: vi.fn(),
      updateSessionPermission,
      upsertSession: vi.fn(),
      getPermissionsForSession: () => [permission('perm-1')],
    });

    await operations.respondPermission('session-1', 'perm-1', 'always');
    await operations.respondQuestion('question-1', [['yes']]);
    await operations.rejectQuestion('question-2');
    await operations.autoApprovePermissionsForSession([permission('perm-2')]);
    await operations.updatePermissionModeForSession(
      'full',
      [{ permission: 'bash', pattern: '*', action: 'allow' }],
      'session-1'
    );

    expect(respondRemotePermission).toHaveBeenCalledWith('session-1', 'perm-1', 'always');
    expect(replyQuestion).toHaveBeenCalledWith('question-1', [['yes']]);
    expect(rejectRemoteQuestion).toHaveBeenCalledWith('question-2');
    expect(respondRemotePermission).toHaveBeenCalledWith('session-1', 'perm-2', 'always');
    expect(updateSessionPermission).toHaveBeenCalledWith('session-1', {
      permission: [{ permission: 'bash', pattern: '*', action: 'allow' }],
    });
  });
});
