import { describe, expect, it } from 'vitest';
import { buildServerEnv, getPathVariableKey, getServerPathEntries } from './server-path';

describe('server path helpers', () => {
  it('reads the Windows Path variable and adds common global install locations', () => {
    const env = {
      Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\alice',
      PNPM_HOME: 'C:\\Users\\alice\\.pnpm',
    };

    expect(getPathVariableKey(env, 'win32')).toBe('Path');
    expect(getServerPathEntries(env, 'win32')).toEqual([
      'C:\\Windows\\System32',
      'C:\\Program Files\\nodejs',
      'C:\\Users\\alice\\.pnpm',
      'C:\\Users\\alice\\AppData\\Roaming\\npm',
      'C:\\Users\\alice\\AppData\\Local\\pnpm',
      'C:\\Users\\alice\\.opencode\\bin',
      'C:\\Users\\alice\\.bun\\bin',
    ]);
  });

  it('writes a single Windows PATH key for child processes', () => {
    const env = {
      PATH: 'C:\\Windows\\System32',
      Path: 'C:\\Program Files\\nodejs',
      APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      USERPROFILE: 'C:\\Users\\alice',
    };

    const nextEnv = buildServerEnv(env, 'win32');
    const pathKeys = Object.keys(nextEnv).filter((key) => key.toLowerCase() === 'path');

    expect(pathKeys).toEqual(['PATH']);
    expect(nextEnv.PATH).toBe(
      [
        'C:\\Windows\\System32',
        'C:\\Users\\alice\\AppData\\Roaming\\npm',
        'C:\\Users\\alice\\.opencode\\bin',
        'C:\\Users\\alice\\.bun\\bin',
      ].join(';')
    );
  });
});
