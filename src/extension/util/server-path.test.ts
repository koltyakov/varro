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
      'C:\\Users\\alice\\AppData\\Local\\Yarn\\bin',
      'C:\\Users\\alice\\.opencode\\bin',
      'C:\\Users\\alice\\.bun\\bin',
      'C:\\Users\\alice\\.yarn\\bin',
      'C:\\Users\\alice\\.volta\\bin',
    ]);
  });

  it('adds package-manager prefixes that are only known through the environment', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/alice',
      PNPM_HOME: '/home/alice/.pnpm-global',
      VOLTA_HOME: '/home/alice/.volta-custom',
      N_PREFIX: '/home/alice/n',
    };

    const entries = getServerPathEntries(env, 'linux');

    expect(entries).toContain('/home/alice/.pnpm-global');
    expect(entries).toContain('/home/alice/.volta-custom/bin');
    expect(entries).toContain('/home/alice/n/bin');
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
        'C:\\Users\\alice\\.yarn\\bin',
        'C:\\Users\\alice\\.volta\\bin',
      ].join(';')
    );
  });
});
