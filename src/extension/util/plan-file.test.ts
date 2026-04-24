import { describe, expect, it } from 'vitest';
import {
  getOpenCodeConfigDir,
  getOpenCodePlansDirectory,
  getPlanFileName,
  getPlanFilePath,
  getPlanHash,
  normalizePlanMarkdown,
} from './plan-file';

describe('plan file helpers', () => {
  it('normalizes markdown before hashing', () => {
    expect(normalizePlanMarkdown('\n# Plan\r\n\r\nStep 1\r\n')).toBe('# Plan\n\nStep 1');
  });

  it('resolves the config directory from XDG config home', () => {
    expect(
      getOpenCodeConfigDir({ XDG_CONFIG_HOME: '/tmp/config' } as NodeJS.ProcessEnv, '/Users/test')
    ).toBe('/tmp/config');
  });

  it('falls back to the standard config directory on non-Windows platforms', () => {
    expect(getOpenCodePlansDirectory({} as NodeJS.ProcessEnv, '/Users/test')).toBe(
      '/Users/test/.config/opencode/plans'
    );
  });

  it('uses AppData on Windows', () => {
    expect(
      getOpenCodePlansDirectory(
        { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' } as NodeJS.ProcessEnv,
        'C:\\Users\\alice',
        'win32'
      )
    ).toBe('C:\\Users\\alice\\AppData\\Roaming\\opencode\\plans');
  });

  it('creates a stable short hash-based file name', () => {
    const content = '# Plan\n\n1. Ship it';

    expect(getPlanHash(content)).toHaveLength(10);
    expect(getPlanFileName(content)).toBe(`plan-${getPlanHash(content)}.md`);
  });

  it('builds the full plan file path from the content hash', () => {
    const content = '# Plan\n\n1. Ship it';

    expect(getPlanFilePath(content, {} as NodeJS.ProcessEnv, '/Users/test')).toBe(
      `/Users/test/.config/opencode/plans/${getPlanFileName(content)}`
    );
  });
});
