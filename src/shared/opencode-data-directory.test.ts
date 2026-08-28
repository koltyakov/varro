import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveOpenCodeDataDirectory } from './opencode-data-directory';

describe('OpenCode data directory', () => {
  it('uses XDG_DATA_HOME when set', () => {
    const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: ' /custom/data ' };
    expect(resolveOpenCodeDataDirectory(env, '/Users/test')).toBe(join('/custom/data', 'opencode'));
  });

  it('uses home local share on every platform instead of LOCALAPPDATA', () => {
    const env: NodeJS.ProcessEnv = { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' };
    expect(resolveOpenCodeDataDirectory(env, '/Users/test')).toBe(
      join('/Users/test', '.local', 'share', 'opencode')
    );
  });

  it('ignores an empty XDG_DATA_HOME', () => {
    const env: NodeJS.ProcessEnv = { XDG_DATA_HOME: '   ' };
    expect(resolveOpenCodeDataDirectory(env, '/home/test')).toBe(
      join('/home/test', '.local', 'share', 'opencode')
    );
  });
});
