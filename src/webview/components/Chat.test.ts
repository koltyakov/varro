import { describe, expect, it } from 'vitest';
import type { Session } from '../types';
import { groupSessions } from './Chat';

function session(id: string, updated: number, overrides: Partial<Session> = {}): Session {
  return {
    id,
    projectID: 'project-1',
    directory: '/repo',
    title: id,
    version: '1',
    time: { created: updated - 1_000, updated },
    ...overrides,
  };
}

describe('groupSessions', () => {
  it('separates sub-agent sessions from primary session groups', () => {
    const sessions = [
      session('running-primary', 500),
      session('attention-primary', 400),
      session('other-primary', 300),
      session('subagent-newer', 600, { parentID: 'parent-1' }),
      session('subagent-older', 200, { parentID: 'parent-2' }),
    ];

    const groups = groupSessions(
      sessions,
      (sessionId) => sessionId === 'running-primary',
      (sessionId) => sessionId === 'attention-primary',
      10
    );

    expect(groups.running.map((item) => item.id)).toEqual(['running-primary']);
    expect(groups.attention.map((item) => item.id)).toEqual(['attention-primary']);
    expect(groups.surfacedOther.map((item) => item.id)).toEqual(['other-primary']);
    expect(groups.overflowOther).toEqual([]);
    expect(groups.subagents.map((item) => item.id)).toEqual(['subagent-newer', 'subagent-older']);
  });

  it('caps surfaced primary others without affecting sub-agent ordering', () => {
    const sessions = [
      session('other-1', 500),
      session('subagent-1', 490, { parentID: 'parent-1' }),
      session('other-2', 480),
      session('subagent-2', 470, { parentID: 'parent-2' }),
      session('other-3', 460),
    ];

    const groups = groupSessions(sessions, () => false, () => false, 2);

    expect(groups.surfacedOther.map((item) => item.id)).toEqual(['other-1', 'other-2']);
    expect(groups.overflowOther.map((item) => item.id)).toEqual(['other-3']);
    expect(groups.subagents.map((item) => item.id)).toEqual(['subagent-1', 'subagent-2']);
  });
});
