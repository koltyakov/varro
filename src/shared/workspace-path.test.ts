import { describe, expect, it } from 'vitest';
import { isSameWorkspacePath, normalizeWorkspaceIdentity } from './workspace-path';

describe('workspace path identity', () => {
  it('case-folds drive paths and normalizes separators', () => {
    expect(normalizeWorkspaceIdentity('C:\\Users\\Andrew\\Varro\\')).toBe('c:/users/andrew/varro');
    expect(isSameWorkspacePath('C:\\Users\\Andrew\\Varro', 'c:/users/andrew/VARRO/')).toBe(true);
  });

  it('case-folds UNC server, share, and directory names', () => {
    expect(normalizeWorkspaceIdentity('\\\\BuildServer\\Projects\\Varro\\')).toBe(
      '//buildserver/projects/varro'
    );
    expect(
      isSameWorkspacePath('\\\\BuildServer\\Projects\\Varro', '//buildserver/PROJECTS/varro/')
    ).toBe(true);
  });

  it('keeps POSIX path identity case-sensitive', () => {
    expect(isSameWorkspacePath('/Users/Andrew/Varro', '/Users/andrew/Varro')).toBe(false);
  });
});
