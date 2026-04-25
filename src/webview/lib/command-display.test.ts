import { describe, expect, it } from 'vitest';
import { formatCommandDisplay, stripRedundantWorkspaceCdPrefix } from './command-display';

describe('command display helpers', () => {
  it('strips redundant workspace cd prefixes', () => {
    expect(stripRedundantWorkspaceCdPrefix('cd /repo && npm test', '/repo')).toBe('npm test');
    expect(stripRedundantWorkspaceCdPrefix('  cd "C:\\repo" && pnpm lint', 'C:/repo')).toBe(
      '  pnpm lint'
    );
    expect(stripRedundantWorkspaceCdPrefix('cd "C:\\Repo" && pnpm lint', 'c:/repo')).toBe(
      'pnpm lint'
    );
    expect(stripRedundantWorkspaceCdPrefix("cd '/project/path' && yarn build", null)).toBe(
      'yarn build'
    );
  });

  it('keeps non-redundant prefixes intact', () => {
    expect(stripRedundantWorkspaceCdPrefix('cd /other && npm test', '/repo')).toBe(
      'cd /other && npm test'
    );
    expect(stripRedundantWorkspaceCdPrefix('npm test', '/repo')).toBe('npm test');
  });

  it('formats multiline command displays line by line', () => {
    const value = 'cd /repo && npm test\ncd /other && npm run build';
    expect(formatCommandDisplay(value, '/repo')).toBe('npm test\ncd /other && npm run build');
  });
});
