import { flush as flushSolid } from 'solid-js';
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
    flushSolid();
    resetDefaultAppState();
    flushSolid();
  });

  it('syncs draft and per-session permission modes', () => {
    window.localStorage.setItem(
      STORAGE_KEYS.projectPermissionModes,
      JSON.stringify({ '/workspace': 'full' })
    );
    flushSolid();

    permissionsStore.syncDraftPermissionForWorkspace('/workspace///');
    flushSolid();

    expect(draftPermissionMode()).toBe('full');

    permissionsStore.setPermissionModeForSession(null, 'default');
    flushSolid();
    expect(draftPermissionMode()).toBe('default');
    expect(window.localStorage.getItem(STORAGE_KEYS.draftPermissionMode)).toBe(
      JSON.stringify('default')
    );
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEYS.projectPermissionModes) || '{}')
    ).toEqual({ '/workspace': 'default' });

    permissionsStore.setPermissionModeForSession('session-1', 'full');
    flushSolid();
    expect(permissionsStore.getPermissionModeForSession('session-1')).toBe('full');

    permissionsStore.removePermissionModeForSession('session-1');
    flushSolid();
    expect(permissionsStore.getPermissionModeForSession('session-1')).toBe('default');

    permissionsStore.resetDraftPermissionMode();
    flushSolid();
    expect(draftPermissionMode()).toBe('default');
  });

  it('persists consecutive mode changes and removal before the next render', () => {
    permissionsStore.setPermissionModeForSession('first', 'full');
    permissionsStore.setPermissionModeForSession('second', 'auto');
    permissionsStore.removePermissionModeForSession('first');
    flushSolid();

    expect(state.sessionPermissionModes).toEqual({ second: 'auto' });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.sessionPermissionModes)!)).toEqual({
      second: 'auto',
    });
  });

  it('updates questions and groups duplicate permissions', () => {
    const firstQuestion = createQuestion('question-1');
    const secondQuestion = createQuestion('question-2');
    const updatedFirstQuestion: QuestionRequest = {
      ...firstQuestion,
      questions: [
        {
          ...firstQuestion.questions[0]!,
          question: 'Retry?',
        },
      ],
    };

    permissionsStore.setQuestions([firstQuestion]);
    flushSolid();
    permissionsStore.upsertQuestion(updatedFirstQuestion);
    flushSolid();
    permissionsStore.upsertQuestion(secondQuestion);
    flushSolid();
    permissionsStore.removeQuestion('question-1');
    flushSolid();

    expect(state.questions).toEqual([secondQuestion]);

    const firstPermission = createPermission('permission-1', 1);
    const secondPermission = createPermission('permission-2', 2);

    permissionsStore.addPermission(firstPermission);
    flushSolid();
    permissionsStore.addPermission(secondPermission);
    flushSolid();

    expect(state.permissions).toHaveLength(1);
    expect(permissionsStore.getPermissionGroupMembers(state.permissions[0]!)).toEqual([
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
    flushSolid();

    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0]).toMatchObject({
      id: 'permission-2',
      sessionID: 'session-1',
      messageID: 'message-permission-2',
      callID: 'call-permission-2',
    });
    expect(state.permissions[0]?.duplicateIDs).toBeUndefined();
    expect(state.permissions[0]?.groupMembers).toBeUndefined();
    expect(permissionsStore.getPermissionGroupMembers(state.permissions[0]!)).toEqual([
      {
        id: 'permission-2',
        sessionID: 'session-1',
        messageID: 'message-permission-2',
        callID: 'call-permission-2',
      },
    ]);
  });

  it('replaces stale permissions with an authoritative server snapshot', () => {
    permissionsStore.addPermission(createPermission('permission-stale', 1));
    flushSolid();
    const reconciliation = permissionsStore.beginPermissionReconciliation();
    flushSolid();

    permissionsStore.reconcilePermissions([], reconciliation);
    flushSolid();

    expect(state.permissions).toEqual([]);
  });

  it('hydrates restored approval details when the cached request is replayed during reconciliation', () => {
    const permission = createPermission('permission-restored', 1);
    const restored: Permission = { ...permission, recoveredIncomplete: true };
    permissionsStore.addPermission(restored);
    flushSolid();
    const reconciliation = permissionsStore.beginPermissionReconciliation();
    flushSolid();

    permissionsStore.addPermission(restored);
    flushSolid();
    permissionsStore.reconcilePermissions([permission], reconciliation);
    flushSolid();

    expect(state.permissions).toHaveLength(1);
    expect(state.permissions[0]?.id).toBe(permission.id);
    expect(state.permissions[0]?.recoveredIncomplete).toBeUndefined();
    expect(state.permissions[0]?.metadata).toEqual(permission.metadata);
  });

  it('does not restore a permission removed while its server snapshot was loading', () => {
    const permission = createPermission('permission-1', 1);
    permissionsStore.addPermission(permission);
    flushSolid();
    const reconciliation = permissionsStore.beginPermissionReconciliation();
    flushSolid();

    permissionsStore.removePermission(permission.id);
    flushSolid();
    permissionsStore.reconcilePermissions([permission], reconciliation);
    flushSolid();

    expect(state.permissions).toEqual([]);
  });

  it('preserves a permission added while its server snapshot was loading', () => {
    const reconciliation = permissionsStore.beginPermissionReconciliation();
    flushSolid();
    const permission = createPermission('permission-new', 1);

    permissionsStore.addPermission(permission);
    flushSolid();
    permissionsStore.reconcilePermissions([], reconciliation);
    flushSolid();

    expect(state.permissions).toEqual([expect.objectContaining({ id: permission.id })]);
  });

  it('releases metadata for thousands of resolved permission IDs', () => {
    for (let index = 0; index < 5_000; index += 1) {
      const reconciliation = permissionsStore.beginPermissionReconciliation();
      flushSolid();
      permissionsStore.removePermission(`permission-resolved-${index}`);
      flushSolid();
      permissionsStore.reconcilePermissions([], reconciliation);
    }

    expect(permissionsStore.getPermissionReconciliationMetadataSize()).toEqual({
      activeReconciliations: 0,
      retainedPermissionIds: 0,
    });
  });

  it('retains tombstones only until every active reconciliation finishes', () => {
    const first = permissionsStore.beginPermissionReconciliation();
    flushSolid();
    const second = permissionsStore.beginPermissionReconciliation();
    flushSolid();
    const permission = createPermission('permission-race', 1);

    permissionsStore.removePermission(permission.id);
    flushSolid();
    expect(permissionsStore.getPermissionReconciliationMetadataSize()).toEqual({
      activeReconciliations: 2,
      retainedPermissionIds: 2,
    });

    permissionsStore.reconcilePermissions([permission], first);
    flushSolid();
    expect(state.permissions).toEqual([]);
    expect(permissionsStore.getPermissionReconciliationMetadataSize()).toEqual({
      activeReconciliations: 1,
      retainedPermissionIds: 1,
    });

    permissionsStore.reconcilePermissions([permission], second);
    flushSolid();
    expect(state.permissions).toEqual([]);
    expect(permissionsStore.getPermissionReconciliationMetadataSize()).toEqual({
      activeReconciliations: 0,
      retainedPermissionIds: 0,
    });
  });
});
