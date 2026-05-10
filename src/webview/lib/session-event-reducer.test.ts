import { describe, expect, it } from 'vitest';
import { isNormalizedPermission, normalizePermissionEvent } from './session-event-reducer';

describe('isNormalizedPermission', () => {
  it('accepts a fully normalized permission', () => {
    expect(
      isNormalizedPermission({
        id: 'perm-1',
        sessionID: 'session-1',
        type: 'bash',
        messageID: 'msg-1',
        time: { created: 1 },
      })
    ).toBe(true);
  });

  it('rejects raw server payloads missing a normalized field', () => {
    expect(
      isNormalizedPermission({
        id: 'perm-1',
        sessionID: 'session-1',
        permission: 'bash',
        patterns: ['ls'],
      })
    ).toBe(false);
  });
});

describe('normalizePermissionEvent', () => {
  it('returns a normalized permission unchanged', () => {
    const already = {
      id: 'perm-1',
      sessionID: 'session-1',
      type: 'bash',
      messageID: 'msg-1',
      time: { created: 1 },
    };
    expect(normalizePermissionEvent(already)).toBe(already);
  });

  it('normalizes a raw permission.asked payload', () => {
    const out = normalizePermissionEvent({
      id: 'perm-1',
      sessionID: 'session-1',
      permission: 'bash',
      patterns: ['ls', 'pwd'],
      title: 'Allow running ls?',
      tool: { messageID: 'msg-42', callID: 'call-1' },
      metadata: { origin: 'tool' },
    });

    expect(out).not.toBeNull();
    expect(out?.id).toBe('perm-1');
    expect(out?.type).toBe('bash');
    expect(out?.sessionID).toBe('session-1');
    expect(out?.messageID).toBe('msg-42');
    expect(out?.callID).toBe('call-1');
    expect(out?.pattern).toEqual(['ls', 'pwd']);
    expect(out?.title).toBe('Allow running ls?');
    expect(out?.metadata).toEqual({ origin: 'tool' });
  });

  it('accepts top-level tool linkage fields from live permission events', () => {
    const out = normalizePermissionEvent({
      id: 'perm-1',
      sessionID: 'session-1',
      permission: 'bash',
      pattern: 'opencode --version',
      messageID: 'msg-42',
      callID: 'call-1',
    });

    expect(out).not.toBeNull();
    expect(out?.messageID).toBe('msg-42');
    expect(out?.callID).toBe('call-1');
    expect(out?.pattern).toBe('opencode --version');
    expect(out?.title).toBe('bash opencode --version');
  });

  it('accepts permission events wrapped in info', () => {
    const out = normalizePermissionEvent({
      info: {
        id: 'perm-1',
        sessionID: 'session-1',
        permission: 'bash',
        title: 'Allow running opencode --version?',
      },
    });

    expect(out).not.toBeNull();
    expect(out?.id).toBe('perm-1');
    expect(out?.sessionID).toBe('session-1');
    expect(out?.title).toBe('Allow running opencode --version?');
  });

  it('accepts permissionID when the live event omits id', () => {
    const out = normalizePermissionEvent({
      permissionID: 'perm-2',
      sessionID: 'session-1',
      permission: 'apply_patch',
      tool: { messageID: 'msg-42', callID: 'call-1' },
    });

    expect(out).not.toBeNull();
    expect(out?.id).toBe('perm-2');
    expect(out?.type).toBe('apply_patch');
    expect(out?.sessionID).toBe('session-1');
    expect(out?.messageID).toBe('msg-42');
    expect(out?.callID).toBe('call-1');
  });

  it('accepts requestID when the live event omits id', () => {
    const out = normalizePermissionEvent({
      requestID: 'perm-3',
      sessionID: 'session-1',
      permission: 'bash',
    });

    expect(out).not.toBeNull();
    expect(out?.id).toBe('perm-3');
    expect(out?.type).toBe('bash');
    expect(out?.sessionID).toBe('session-1');
  });

  it('returns null without an id or session id', () => {
    expect(normalizePermissionEvent({ sessionID: 'session-1' })).toBeNull();
    expect(normalizePermissionEvent({ id: 'perm-1' })).toBeNull();
  });

  it('filters non-string patterns', () => {
    const out = normalizePermissionEvent({
      id: 'perm-1',
      sessionID: 'session-1',
      permission: 'bash',
      patterns: ['ls', 42, null],
    });
    expect(out?.pattern).toEqual(['ls']);
  });

  it('preserves an incoming permission event timestamp', () => {
    const out = normalizePermissionEvent({
      id: 'perm-1',
      sessionID: 'session-1',
      permission: 'bash',
      time: { created: 123 },
    });

    expect(out?.time.created).toBe(123);
  });
});
