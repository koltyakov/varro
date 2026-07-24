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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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

  it('rethrows question failures when the caller requests an actionable result', async () => {
    const replyFailure = new Error('reply failed');
    const rejectFailure = new Error('reject failed');

    await expect(
      respondQuestionWithDependencies(
        {
          replyQuestion: vi.fn(async () => {
            throw replyFailure;
          }),
          removeQuestion: vi.fn(),
          setError: vi.fn(),
        },
        'question-1',
        [['no']],
        { rethrow: true }
      )
    ).rejects.toBe(replyFailure);

    await expect(
      rejectQuestionWithDependencies(
        {
          rejectQuestion: vi.fn(async () => {
            throw rejectFailure;
          }),
          removeQuestion: vi.fn(),
          setError: vi.fn(),
        },
        'question-2',
        { rethrow: true }
      )
    ).rejects.toBe(rejectFailure);
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

  it('serializes full then auto PATCHes and applies only the latest success', async () => {
    const fullUpdate = deferred<Session>();
    const autoUpdate = deferred<Session>();
    let sessionMode: 'default' | 'auto' | 'full' = 'default';
    let draftMode: 'default' | 'auto' | 'full' = 'default';
    const upsertSession = vi.fn();
    const autoApprovePermissionsForSession = vi.fn(async () => {});
    const syncPendingPermissions = vi.fn(async () => {});
    const updateSessionPermission = vi
      .fn()
      .mockReturnValueOnce(fullUpdate.promise)
      .mockReturnValueOnce(autoUpdate.promise);
    const operations = new SessionApprovalOperations({
      respondRemotePermission: vi.fn(async () => {}),
      removePermission: vi.fn(),
      setError: vi.fn(),
      replyQuestion: vi.fn(async () => {}),
      removeQuestion: vi.fn(),
      rejectRemoteQuestion: vi.fn(async () => {}),
      getPermissionModeForSession: () => sessionMode,
      getDraftPermissionMode: () => draftMode,
      setPermissionModeForSession: (_sessionId, mode) => {
        sessionMode = mode;
      },
      setDraftPermissionMode: (mode) => {
        draftMode = mode;
      },
      saveProjectPermissionMode: vi.fn(),
      updateSessionPermission,
      upsertSession,
      getPermissionsForSession: () => [permission('perm-1')],
      syncPendingPermissions,
    });
    vi.spyOn(operations, 'autoApprovePermissionsForSession').mockImplementation(
      autoApprovePermissionsForSession
    );

    const full = operations.updatePermissionModeForSession(
      'full',
      [{ permission: 'bash', pattern: '*', action: 'allow' }],
      'session-1'
    );
    const auto = operations.updatePermissionModeForSession(
      'auto',
      [{ permission: 'bash', pattern: '*', action: 'ask' }],
      'session-1'
    );
    await vi.waitFor(() => expect(updateSessionPermission).toHaveBeenCalledTimes(1));
    expect(updateSessionPermission).toHaveBeenNthCalledWith(1, 'session-1', {
      permission: [{ permission: 'bash', pattern: '*', action: 'allow' }],
    });

    fullUpdate.resolve(session('session-1'));
    await vi.waitFor(() => expect(updateSessionPermission).toHaveBeenCalledTimes(2));
    expect(updateSessionPermission).toHaveBeenNthCalledWith(2, 'session-1', {
      permission: [{ permission: 'bash', pattern: '*', action: 'ask' }],
    });
    autoUpdate.resolve(session('session-1'));
    await Promise.all([full, auto]);

    expect(sessionMode).toBe('auto');
    expect(draftMode).toBe('auto');
    expect(upsertSession).toHaveBeenCalledTimes(1);
    expect(upsertSession).toHaveBeenCalledWith(session('session-1'));
    expect(autoApprovePermissionsForSession).not.toHaveBeenCalled();
    expect(syncPendingPermissions).toHaveBeenCalledTimes(1);
  });

  it('rolls full then auto failures back to the last confirmed mode', async () => {
    const fullUpdate = deferred<Session>();
    const autoUpdate = deferred<Session>();
    let sessionMode: 'default' | 'auto' | 'full' = 'default';
    let draftMode: 'default' | 'auto' | 'full' = 'default';
    const setPermissionModeForSession = vi.fn((_sessionId, mode) => {
      sessionMode = mode;
    });
    const setDraftPermissionMode = vi.fn((mode) => {
      draftMode = mode;
    });
    const saveProjectPermissionMode = vi.fn();
    const setError = vi.fn();
    const updateSessionPermission = vi
      .fn()
      .mockReturnValueOnce(fullUpdate.promise)
      .mockReturnValueOnce(autoUpdate.promise);
    const operations = new SessionApprovalOperations({
      respondRemotePermission: vi.fn(async () => {}),
      removePermission: vi.fn(),
      setError,
      replyQuestion: vi.fn(async () => {}),
      removeQuestion: vi.fn(),
      rejectRemoteQuestion: vi.fn(async () => {}),
      getPermissionModeForSession: () => sessionMode,
      getDraftPermissionMode: () => draftMode,
      setPermissionModeForSession,
      setDraftPermissionMode,
      saveProjectPermissionMode,
      updateSessionPermission,
      upsertSession: vi.fn(),
      getPermissionsForSession: () => [],
    });

    const full = operations.updatePermissionModeForSession(
      'full',
      [{ permission: 'bash', pattern: '*', action: 'allow' }],
      'session-1'
    );
    const auto = operations.updatePermissionModeForSession(
      'auto',
      [{ permission: 'bash', pattern: '*', action: 'ask' }],
      'session-1'
    );
    await vi.waitFor(() => expect(updateSessionPermission).toHaveBeenCalledTimes(1));
    fullUpdate.reject(new Error('full failed'));
    await vi.waitFor(() => expect(updateSessionPermission).toHaveBeenCalledTimes(2));
    autoUpdate.reject(new Error('auto failed'));
    await Promise.all([full, auto]);

    expect(sessionMode).toBe('default');
    expect(draftMode).toBe('default');
    expect(setPermissionModeForSession.mock.calls.map((call) => call[1])).toEqual([
      'full',
      'auto',
      'default',
    ]);
    expect(setDraftPermissionMode.mock.calls.map((call) => call[0])).toEqual([
      'full',
      'auto',
      'default',
    ]);
    expect(saveProjectPermissionMode.mock.calls.map((call) => call[0])).toEqual([
      'full',
      'auto',
      'default',
    ]);
    expect(setError).toHaveBeenCalledOnce();
    expect(setError).toHaveBeenCalledWith('auto failed');
  });

  it('rolls a failed latest auto selection back to a confirmed full selection', async () => {
    const fullUpdate = deferred<Session>();
    const autoUpdate = deferred<Session>();
    let sessionMode: 'default' | 'auto' | 'full' = 'default';
    let draftMode: 'default' | 'auto' | 'full' = 'default';
    const saveProjectPermissionMode = vi.fn();
    const updateSessionPermission = vi
      .fn()
      .mockReturnValueOnce(fullUpdate.promise)
      .mockReturnValueOnce(autoUpdate.promise);
    const operations = new SessionApprovalOperations({
      respondRemotePermission: vi.fn(async () => {}),
      removePermission: vi.fn(),
      setError: vi.fn(),
      replyQuestion: vi.fn(async () => {}),
      removeQuestion: vi.fn(),
      rejectRemoteQuestion: vi.fn(async () => {}),
      getPermissionModeForSession: () => sessionMode,
      getDraftPermissionMode: () => draftMode,
      setPermissionModeForSession: (_sessionId, mode) => {
        sessionMode = mode;
      },
      setDraftPermissionMode: (mode) => {
        draftMode = mode;
      },
      saveProjectPermissionMode,
      updateSessionPermission,
      upsertSession: vi.fn(),
      getPermissionsForSession: () => [],
    });

    const full = operations.updatePermissionModeForSession(
      'full',
      [{ permission: 'bash', pattern: '*', action: 'allow' }],
      'session-1'
    );
    const auto = operations.updatePermissionModeForSession(
      'auto',
      [{ permission: 'bash', pattern: '*', action: 'ask' }],
      'session-1'
    );
    await vi.waitFor(() => expect(updateSessionPermission).toHaveBeenCalledTimes(1));
    fullUpdate.resolve(session('session-1'));
    await vi.waitFor(() => expect(updateSessionPermission).toHaveBeenCalledTimes(2));
    autoUpdate.reject(new Error('auto failed'));
    await Promise.all([full, auto]);

    expect(sessionMode).toBe('full');
    expect(draftMode).toBe('full');
    expect(saveProjectPermissionMode).toHaveBeenLastCalledWith('full');
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
});
