import { beforeEach, describe, expect, it } from 'vitest';
import type { Permission, QuestionRequest } from '../../types';
import { STORAGE_KEYS } from '../state-storage';
import { draftPermissionMode, resetDefaultAppState, state } from '../state';
import { permissionsStore } from './permissions-store';

function createQuestion(id: string): QuestionRequest {
  return {
    id,
    sessionID: 'session-1',
    questions: [
      {
        question: 'Continue?',
        header: 'Confirm',
        options: [{ label: 'Yes', description: 'Continue execution' }],
      },
    ],
  };
}

function createPermission(id: string, created: number): Permission {
  return {
    id,
    type: 'edit',
    pattern: 'src/index.ts',
    sessionID: 'session-1',
    messageID: `message-${id}`,
    callID: `call-${id}`,
    title: 'Edit src/index.ts',
    metadata: { path: 'src/index.ts' },
    time: { created },
  };
}

describe('permissionsStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetDefaultAppState();
  });

  it('syncs draft and per-session permission modes', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.projectPermissionModes,
      JSON.stringify({ '/workspace': 'full' })
    );

    permissionsStore.syncDraftPermissionForWorkspace('/workspace///');

    expect(draftPermissionMode()).toBe('full');

    permissionsStore.setPermissionModeForSession(null, 'default');
    expect(draftPermissionMode()).toBe('default');
    expect(window.localStorage.getItem(STORAGE_KEYS.draftPermissionMode)).toBe(
      JSON.stringify('default')
    );
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEYS.projectPermissionModes) || '{}')
    ).toEqual({ '/workspace': 'default' });

    permissionsStore.setPermissionModeForSession('session-1', 'full');
    expect(permissionsStore.getPermissionModeForSession('session-1')).toBe('full');

    permissionsStore.removePermissionModeForSession('session-1');
    expect(permissionsStore.getPermissionModeForSession('session-1')).toBe('default');

    permissionsStore.resetDraftPermissionMode();
    expect(draftPermissionMode()).toBe('default');
  });

  it('updates questions and groups duplicate permissions', () => {
    const firstQuestion = createQuestion('question-1');
    const secondQuestion = createQuestion('question-2');
    const updatedFirstQuestion: QuestionRequest = {
      ...firstQuestion,
      questions: [
        {
          ...firstQuestion.questions[0],
          question: 'Retry?',
        },
      ],
    };

    permissionsStore.setQuestions([firstQuestion]);
    permissionsStore.upsertQuestion(updatedFirstQuestion);
    permissionsStore.upsertQuestion(secondQuestion);
    permissionsStore.removeQuestion('question-1');

    expect(state.questions).toEqual([secondQuestion]);

    const firstPermission = createPermission('permission-1', 1);
    const secondPermission = createPermission('permission-2', 2);

    permissionsStore.addPermission(firstPermission);
    permissionsStore.addPermission(secondPermission);

    expect(state.permissions).toHaveLength(1);
    expect(permissionsStore.getPermissionGroupMembers(state.permissions[0])).toEqual([
      {
        id: 'permission-1',
        sessionID: 'session-1',
        messageID: 'message-permission-1',
        callID: 'call-permission-1',
      },
      {
        id: 'permission-2',
        sessionID: 'session-1',
        messageID: 'message-permission-2',
        callID: 'call-permission-2',
      },
    ]);

    permissionsStore.removePermission('permission-1');

    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0]).toMatchObject({
      id: 'permission-2',
      sessionID: 'session-1',
      messageID: 'message-permission-2',
      callID: 'call-permission-2',
    });
    expect(state.permissions[0]).not.toHaveProperty('duplicateIDs');
    expect(state.permissions[0]).not.toHaveProperty('groupMembers');
  });

  it('replaces stale permissions with an authoritative server snapshot', () => {
    permissionsStore.addPermission(createPermission('permission-stale', 1));
    const reconciliation = permissionsStore.beginPermissionReconciliation();

    permissionsStore.reconcilePermissions([], reconciliation);

    expect(state.permissions).toEqual([]);
  });

  it('does not restore a permission removed while its server snapshot was loading', () => {
    const permission = createPermission('permission-1', 1);
    permissionsStore.addPermission(permission);
    const reconciliation = permissionsStore.beginPermissionReconciliation();

    permissionsStore.removePermission(permission.id);
    permissionsStore.reconcilePermissions([permission], reconciliation);

    expect(state.permissions).toEqual([]);
  });

  it('preserves a permission added while its server snapshot was loading', () => {
    const reconciliation = permissionsStore.beginPermissionReconciliation();
    const permission = createPermission('permission-new', 1);

    permissionsStore.addPermission(permission);
    permissionsStore.reconcilePermissions([], reconciliation);

    expect(state.permissions).toEqual([expect.objectContaining({ id: permission.id })]);
  });

  it('releases metadata for thousands of resolved permission IDs', () => {
    for (let index = 0; index < 5_000; index += 1) {
      const reconciliation = permissionsStore.beginPermissionReconciliation();
      permissionsStore.removePermission(`permission-resolved-${index}`);
      permissionsStore.reconcilePermissions([], reconciliation);
    }

    expect(permissionsStore.getPermissionReconciliationMetadataSize()).toEqual({
      activeReconciliations: 0,
      retainedPermissionIds: 0,
    });
  });

  it('retains tombstones only until every active reconciliation finishes', () => {
    const first = permissionsStore.beginPermissionReconciliation();
    const second = permissionsStore.beginPermissionReconciliation();
    const permission = createPermission('permission-race', 1);

    permissionsStore.removePermission(permission.id);
    expect(permissionsStore.getPermissionReconciliationMetadataSize()).toEqual({
      activeReconciliations: 2,
      retainedPermissionIds: 2,
    });

    permissionsStore.reconcilePermissions([permission], first);
    expect(state.permissions).toEqual([]);
    expect(permissionsStore.getPermissionReconciliationMetadataSize()).toEqual({
      activeReconciliations: 1,
      retainedPermissionIds: 1,
    });

    permissionsStore.reconcilePermissions([permission], second);
    expect(state.permissions).toEqual([]);
    expect(permissionsStore.getPermissionReconciliationMetadataSize()).toEqual({
      activeReconciliations: 0,
      retainedPermissionIds: 0,
    });
  });
});
