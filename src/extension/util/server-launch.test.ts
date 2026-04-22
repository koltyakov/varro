import { describe, expect, it } from 'vitest';
import { resolveServerLaunch } from './server-launch';

describe('server launch helpers', () => {
  it('spawns direct executables without a shell wrapper', () => {
    expect(
      resolveServerLaunch('/usr/local/bin/opencode', ['serve', '--port', '4096'], {}, 'darwin')
    ).toEqual({
      command: '/usr/local/bin/opencode',
      args: ['serve', '--port', '4096'],
    });
  });

  it('wraps Windows cmd shims with cmd.exe', () => {
    expect(
      resolveServerLaunch(
        'C:\\Program Files\\OpenCode\\opencode.cmd',
        ['serve', '--port', '4096'],
        { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
        'win32'
      )
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Program Files\\OpenCode\\opencode.cmd" serve --port 4096'],
      windowsVerbatimArguments: true,
    });
  });
});
