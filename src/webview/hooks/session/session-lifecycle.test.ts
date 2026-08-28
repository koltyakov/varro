import { describe, expect, it } from 'vitest';
import type { Session } from '../../types';
import { isSessionInWorkspace } from './session-lifecycle';

describe('isSessionInWorkspace', () => {
  it('matches equivalent UNC path spellings', () => {
    const session: Session = {
      id: 'session-1',
      projectID: 'project-1',
      directory: '\\\\BuildServer\\Projects\\Varro',
      title: 'Session',
      version: '1',
      time: { created: 1, updated: 1 },
    };

    expect(isSessionInWorkspace(session, '//buildserver/PROJECTS/varro/')).toBe(true);
  });
});
