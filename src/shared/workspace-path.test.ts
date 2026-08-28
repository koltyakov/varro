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

  it('canonicalizes extended drive and UNC paths', () => {
    expect(normalizeWorkspaceIdentity('\\\\?\\C:\\Users\\Andrew\\Varro\\')).toBe(
      'c:/users/andrew/varro'
    );
    expect(isSameWorkspacePath('\\\\?\\C:\\Users\\Andrew\\Varro', 'c:/users/andrew/VARRO')).toBe(
      true
    );
    expect(normalizeWorkspaceIdentity('\\\\?\\UNC\\BuildServer\\Projects\\Varro\\')).toBe(
      '//buildserver/projects/varro'
    );
    expect(
      isSameWorkspacePath(
        '\\\\?\\UNC\\BuildServer\\Projects\\Varro',
        '\\\\buildserver\\projects\\VARRO'
      )
    ).toBe(true);
  });

  it('canonicalizes extended volume paths without dropping workspace identity', () => {
    expect(normalizeWorkspaceIdentity('\\\\?\\Volume{ABC-123}\\Repo\\Source\\')).toBe(
      '//?/volume{abc-123}/repo/source'
    );
    expect(
      isSameWorkspacePath(
        '\\\\?\\Volume{ABC-123}\\Repo\\Source',
        '\\\\?\\volume{abc-123}\\repo\\source\\'
      )
    ).toBe(true);
  });

  it('rejects unsupported Windows device namespaces', () => {
    expect(normalizeWorkspaceIdentity('\\\\.\\PhysicalDrive0')).toBeNull();
    expect(normalizeWorkspaceIdentity('\\??\\C:\\repo')).toBeNull();
    expect(isSameWorkspacePath('\\\\?\\GLOBALROOT\\Device', '\\\\?\\GLOBALROOT\\Device')).toBe(
      false
    );
  });

  it('keeps POSIX path identity case-sensitive', () => {
    expect(isSameWorkspacePath('/Users/Andrew/Varro', '/Users/andrew/Varro')).toBe(false);
    expect(isSameWorkspacePath('src/Feature.ts', 'src/feature.ts')).toBe(false);
  });

  it('keeps backslashes literal in POSIX paths', () => {
    expect(normalizeWorkspaceIdentity('/srv/Repo\\Feature/')).toBe('/srv/Repo\\Feature');
    expect(isSameWorkspacePath('/srv/repo\\feature', '/srv/repo/feature')).toBe(false);
    expect(isSameWorkspacePath('/srv/Repo\\Feature', '/srv/repo\\feature')).toBe(false);
  });

  it('does not case-fold an incomplete UNC-like POSIX path', () => {
    expect(isSameWorkspacePath('//BuildServer', '//buildserver')).toBe(false);
  });
});
