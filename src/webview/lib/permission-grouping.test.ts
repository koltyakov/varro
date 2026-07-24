import { describe, expect, it } from 'vitest';
import type { Permission } from '../types';
import {
  getPermissionSignature,
  groupPermissions,
  normalizeInitialPermissions,
  normalizeInitialQuestions,
} from './permission-grouping';

function permission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: 'perm-1',
    type: 'bash',
    pattern: 'ls *',
    sessionID: 'session-1',
    messageID: 'message-1',
    callID: 'call-1',
    title: 'bash ls *',
    metadata: { command: 'ls -la' },
    time: { created: 1 },
    ...overrides,
  };
}

const question = {
  question: 'Which approach?',
  header: 'Approach',
  options: [{ label: 'A', description: 'first' }],
};

describe('getPermissionSignature', () => {
  it('is stable across metadata key insertion order', () => {
    const left = permission({ metadata: { alpha: 1, beta: 2, gamma: { x: 1, y: 2 } } });
    const right = permission({ metadata: { gamma: { y: 2, x: 1 }, beta: 2, alpha: 1 } });

    expect(getPermissionSignature(left)).toBe(getPermissionSignature(right));
  });

  it('does not collide for metadata values of different primitive types', () => {
    const signatures = [
      getPermissionSignature(permission({ metadata: { value: 1 } })),
      getPermissionSignature(permission({ metadata: { value: '1' } })),
      getPermissionSignature(permission({ metadata: { value: true } })),
      getPermissionSignature(permission({ metadata: { value: 'true' } })),
      getPermissionSignature(permission({ metadata: { value: null } })),
      getPermissionSignature(permission({ metadata: { value: undefined } })),
      getPermissionSignature(permission({ metadata: { value: 'null' } })),
    ];

    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('distinguishes array order and array-vs-string patterns', () => {
    expect(getPermissionSignature(permission({ pattern: ['a', 'b'] }))).not.toBe(
      getPermissionSignature(permission({ pattern: ['b', 'a'] }))
    );
    expect(getPermissionSignature(permission({ pattern: ['a'] }))).not.toBe(
      getPermissionSignature(permission({ pattern: 'a' }))
    );
  });

  it('treats a missing pattern and an explicit null pattern alike', () => {
    expect(getPermissionSignature(permission({ pattern: undefined }))).toBe(
      getPermissionSignature(permission({ pattern: null as unknown as string }))
    );
  });

  it('ignores fields that vary between duplicate requests', () => {
    expect(getPermissionSignature(permission({ id: 'perm-1', callID: 'call-1' }))).toBe(
      getPermissionSignature(
        permission({
          id: 'perm-9',
          callID: 'call-9',
          messageID: 'message-9',
          time: { created: 99 },
        })
      )
    );
  });

  it('separates permissions from different sessions', () => {
    expect(getPermissionSignature(permission({ sessionID: 'session-1' }))).not.toBe(
      getPermissionSignature(permission({ sessionID: 'session-2' }))
    );
  });

  it('serializes nested arrays inside metadata', () => {
    expect(getPermissionSignature(permission({ metadata: { paths: [['a'], ['b']] } }))).not.toBe(
      getPermissionSignature(permission({ metadata: { paths: [['b'], ['a']] } }))
    );
  });
});

describe('groupPermissions', () => {
  it('uses the earliest created permission as the group head regardless of input order', () => {
    const grouped = groupPermissions([
      permission({ id: 'perm-late', time: { created: 20 } }),
      permission({ id: 'perm-early', time: { created: 5 } }),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.id).toBe('perm-early');
    expect(grouped[0]!.duplicateIDs).toEqual(['perm-early', 'perm-late']);
  });

  it('de-duplicates repeated ids within a group', () => {
    const grouped = groupPermissions([
      permission({ id: 'perm-1', time: { created: 1 } }),
      permission({ id: 'perm-1', time: { created: 2 } }),
    ]);

    expect(grouped[0]!.duplicateIDs).toEqual(['perm-1']);
  });

  it('keeps permissions with different metadata in separate groups', () => {
    const grouped = groupPermissions([
      permission({ id: 'perm-1', metadata: { command: 'ls' } }),
      permission({ id: 'perm-2', metadata: { command: 'rm -rf /' } }),
    ]);

    expect(grouped.map((entry) => entry.id)).toEqual(['perm-1', 'perm-2']);
  });

  it('returns an empty list for no permissions', () => {
    expect(groupPermissions([])).toEqual([]);
  });
});

describe('normalizeInitialPermissions', () => {
  it('normalizes and groups a raw permission payload', () => {
    const normalized = normalizeInitialPermissions([
      {
        id: 'perm-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        permission: 'bash',
        pattern: 'ls *',
        time: { created: 1 },
      },
      {
        permissionID: 'perm-2',
        sessionID: 'session-1',
        messageID: 'message-1',
        permission: 'bash',
        pattern: 'ls *',
        time: { created: 2 },
      },
    ]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]!.duplicateIDs).toEqual(['perm-1', 'perm-2']);
  });

  it('drops entries that cannot be normalized', () => {
    expect(
      normalizeInitialPermissions([
        null,
        'not an object',
        42,
        { sessionID: 'session-1' },
        { id: 'perm-1' },
      ])
    ).toEqual([]);
  });

  it('returns an empty list for a non-array payload', () => {
    for (const value of [null, undefined, {}, 'permissions', 0]) {
      expect(normalizeInitialPermissions(value)).toEqual([]);
    }
  });
});

describe('normalizeInitialQuestions', () => {
  it('keeps the tool linkage so the prompt can attach to its tool card', () => {
    const normalized = normalizeInitialQuestions([
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [question],
        tool: { messageID: 'message-1', callID: 'call-1' },
      },
    ]);

    expect(normalized).toEqual([
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [question],
        tool: { messageID: 'message-1', callID: 'call-1' },
      },
    ]);
  });

  it('drops a malformed tool linkage instead of the whole question', () => {
    const [normalized] = normalizeInitialQuestions([
      {
        id: 'question-1',
        sessionID: 'session-1',
        questions: [question],
        tool: { messageID: 'message-1' },
      },
    ]);

    expect(normalized).toMatchObject({ id: 'question-1' });
    expect(normalized!.tool).toBeUndefined();
  });

  it('accepts a question with no tool linkage', () => {
    const [normalized] = normalizeInitialQuestions([
      { id: 'question-1', sessionID: 'session-1', questions: [question] },
    ]);

    expect(normalized!.tool).toBeUndefined();
  });

  it('drops entries missing an id, session, or questions array', () => {
    expect(
      normalizeInitialQuestions([
        null,
        'not an object',
        { sessionID: 'session-1', questions: [question] },
        { id: 'question-1', questions: [question] },
        { id: 'question-1', sessionID: 'session-1' },
        { id: 'question-1', sessionID: 'session-1', questions: 'nope' },
      ])
    ).toEqual([]);
  });

  it('returns an empty list for a non-array payload', () => {
    for (const value of [null, undefined, {}, 'questions', 0]) {
      expect(normalizeInitialQuestions(value)).toEqual([]);
    }
  });
});
