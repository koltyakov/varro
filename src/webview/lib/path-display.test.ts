import { describe, expect, it } from 'vitest';
import {
  formatDisplayPath,
  getDroppedFileLabel,
  getLeafPathName,
  getWorkspaceRelativePath,
  isSamePath,
  isAbsolutePath,
  normalizePath,
} from './path-display';

describe('path display helpers', () => {
  it('normalizes separators and trailing slashes', () => {
    expect(normalizePath('C:\\work\\repo\\src\\')).toBe('C:/work/repo/src');
    expect(normalizePath('/tmp///')).toBe('/tmp');
    expect(normalizePath('')).toBe('');
  });

  it('detects absolute paths on unix and windows', () => {
    expect(isAbsolutePath('/repo/file.ts')).toBe(true);
    expect(isAbsolutePath('C:\\repo\\file.ts')).toBe(true);
    expect(isAbsolutePath('src/file.ts')).toBe(false);
  });

  it('extracts leaf names from normalized paths', () => {
    expect(getLeafPathName('/repo/src/index.ts')).toBe('index.ts');
    expect(getLeafPathName('nested/path/')).toBe('path');
    expect(getLeafPathName('')).toBe('');
  });

  it('resolves workspace-relative paths only when nested', () => {
    expect(getWorkspaceRelativePath('/repo/src/index.ts', '/repo')).toBe('src/index.ts');
    expect(getWorkspaceRelativePath('/repo/src/index.ts', '/repo/')).toBe('src/index.ts');
    expect(getWorkspaceRelativePath('/repo', '/repo')).toBe('.');
    expect(getWorkspaceRelativePath('/other/src/index.ts', '/repo')).toBeNull();
    expect(getWorkspaceRelativePath('/repo/src/index.ts', null)).toBeNull();
  });

  it('formats display paths based on workspace and absoluteness', () => {
    expect(formatDisplayPath('/repo/src/index.ts', '/repo')).toBe('src/index.ts');
    expect(formatDisplayPath('C:\\repo\\src\\index.ts', '/workspace')).toBe('index.ts');
    expect(formatDisplayPath('/outside/file.ts', '/repo')).toBe('file.ts');
    expect(formatDisplayPath('relative/file.ts', '/repo')).toBe('relative/file.ts');
  });

  it('labels dropped files from relative paths when available', () => {
    expect(getDroppedFileLabel({ path: '/repo/src/index.ts', relativePath: 'src/index.ts' })).toBe(
      'index.ts'
    );
    expect(getDroppedFileLabel({ path: '/repo/src/index.ts', relativePath: '.' })).toBe('index.ts');
  });

  it('compares normalized paths for overlap checks', () => {
    expect(isSamePath('/repo/src/index.ts', '/repo/src/index.ts')).toBe(true);
    expect(isSamePath('/repo/src/index.ts/', '/repo/src/index.ts')).toBe(true);
    expect(isSamePath('C:\\repo\\src\\index.ts', 'C:/repo/src/index.ts')).toBe(true);
    expect(isSamePath('/repo/src/index.ts', '/repo/src/other.ts')).toBe(false);
    expect(isSamePath('/repo/src/index.ts', null)).toBe(false);
  });
});
