import { describe, expect, it } from 'vitest';
import {
  classifyUpgradeFailure,
  describeUpgradeFailure,
  detectInstallMethod,
  getRecoveryCommand,
  getUpgradeCommand,
  OPENCODE_TERMINAL_COMMANDS,
} from './opencode-install';

describe('detectInstallMethod', () => {
  it('reports an unrecognized configured command as custom', () => {
    expect(
      detectInstallMethod({
        resolvedCommand: '/opt/custom/bin/opencode',
        configuredCommand: '/custom/opencode',
      })
    ).toBe('custom');
  });

  it('preserves a recognized install method for a configured executable', () => {
    expect(
      detectInstallMethod({
        resolvedCommand:
          '/Users/me/.nvm/versions/node/v22/lib/node_modules/opencode-ai/bin/opencode',
        configuredCommand: '/Users/me/.nvm/versions/node/v22/bin/opencode',
      })
    ).toBe('npm');
  });

  it('ignores a blank configured command', () => {
    expect(
      detectInstallMethod({
        resolvedCommand: '/Users/me/.opencode/bin/opencode',
        configuredCommand: '   ',
      })
    ).toBe('curl');
  });

  it.each([
    ['/Users/me/.opencode/bin/opencode', 'curl'],
    ['/Users/me/.bun/bin/opencode', 'bun'],
    ['/Users/me/Library/pnpm/opencode', 'pnpm'],
    ['/Users/me/.config/yarn/global/node_modules/opencode-ai/bin/opencode', 'yarn'],
    ['/home/me/.local/share/yarn/global/node_modules/opencode-ai/bin/opencode', 'yarn'],
    ['/opt/homebrew/bin/opencode', 'brew'],
    ['/home/linuxbrew/.linuxbrew/bin/opencode', 'brew'],
    ['/Users/me/.npm-global/bin/opencode', 'npm'],
    ['/usr/lib/node_modules/opencode-ai/bin/opencode', 'npm'],
    ['/Users/me/.nvm/versions/node/v22.12.0/bin/opencode', 'npm'],
    ['/Users/me/.local/share/fnm/node-versions/v22.12.0/installation/bin/opencode', 'npm'],
    ['/Users/me/.volta/bin/opencode', 'npm'],
  ] as const)('detects %s as %s', (resolvedCommand, expected) => {
    expect(detectInstallMethod({ resolvedCommand })).toBe(expected);
  });

  it.each([
    ['C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd', 'npm'],
    ['C:\\Users\\me\\.bun\\bin\\opencode.exe', 'bun'],
    ['C:\\Users\\me\\AppData\\Local\\pnpm\\opencode.exe', 'pnpm'],
    ['C:\\Users\\me\\AppData\\Local\\Yarn\\bin\\opencode.cmd', 'yarn'],
    [
      'C:\\Users\\me\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\opencode-ai\\bin\\opencode',
      'yarn',
    ],
    ['C:\\Users\\me\\.opencode\\bin\\opencode.exe', 'curl'],
  ] as const)('detects windows path %s as %s', (resolvedCommand, expected) => {
    expect(detectInstallMethod({ resolvedCommand })).toBe(expected);
  });

  it('reports unknown for a bare command name that was never resolved', () => {
    expect(detectInstallMethod({ resolvedCommand: 'opencode' })).toBe('unknown');
    expect(detectInstallMethod({ resolvedCommand: 'opencode.cmd' })).toBe('unknown');
  });

  it('reads an npm global under Homebrew node as npm, not brew', () => {
    // Both installs surface at /opt/homebrew/bin/opencode; only the link target
    // separates them, and `brew upgrade` cannot repair an npm install.
    expect(
      detectInstallMethod({
        resolvedCommand: '/opt/homebrew/lib/node_modules/opencode-ai/bin/opencode',
      })
    ).toBe('npm');
    // The real homebrew/core layout: the formula runs `npm install` into
    // libexec, so a brew install carries a node_modules segment too and only
    // the Cellar prefix tells the two apart.
    expect(
      detectInstallMethod({
        resolvedCommand:
          '/opt/homebrew/Cellar/opencode/1.18.5/libexec/lib/node_modules/opencode-ai/bin/opencode',
      })
    ).toBe('brew');
    expect(
      detectInstallMethod({
        resolvedCommand:
          '/home/linuxbrew/.linuxbrew/Cellar/opencode/1.18.5/libexec/lib/node_modules/opencode-ai/bin/opencode',
      })
    ).toBe('brew');
  });

  it('keeps package-manager globals ahead of their node_modules segment', () => {
    expect(
      detectInstallMethod({
        resolvedCommand: '/home/me/.bun/install/global/node_modules/opencode-ai/bin/opencode',
      })
    ).toBe('bun');
    expect(
      detectInstallMethod({
        resolvedCommand: '/home/me/Library/pnpm/global/5/node_modules/opencode-ai/bin/opencode',
      })
    ).toBe('pnpm');
  });

  it('reports unknown for an ambiguous shared prefix', () => {
    // /usr/local/bin is used by both Intel Homebrew and system-node npm globals,
    // so recommending either upgrade command could create a second install.
    expect(detectInstallMethod({ resolvedCommand: '/usr/local/bin/opencode' })).toBe('unknown');
  });

  it('does not treat a project-local dependency as a global npm install', () => {
    expect(
      detectInstallMethod({
        resolvedCommand: '/project/node_modules/opencode-ai/bin/opencode',
      })
    ).toBe('unknown');
  });
});

describe('getUpgradeCommand', () => {
  it.each([
    ['npm', 'npm install -g opencode-ai@latest'],
    ['pnpm', 'pnpm add -g opencode-ai@latest'],
    ['yarn', 'yarn global add opencode-ai@latest'],
    ['bun', 'bun add -g opencode-ai@latest'],
    // Unqualified: OpenCode is in homebrew/core now, and a tap-qualified name
    // fails outright against a core install.
    ['brew', 'brew upgrade opencode'],
    ['curl', 'curl -fsSL https://opencode.ai/install | bash'],
  ] as const)('maps %s to its own upgrade command', (method, expected) => {
    expect(getUpgradeCommand(method, 'darwin')).toBe(expected);
  });

  it('never recommends the shell installer on windows', () => {
    expect(getUpgradeCommand('curl', 'win32')).toBeNull();
  });

  it('recommends nothing for custom or unknown installs', () => {
    expect(getUpgradeCommand('custom', 'darwin')).toBeNull();
    expect(getUpgradeCommand('unknown', 'darwin')).toBeNull();
  });

  it('never recommends the command that just failed', () => {
    for (const method of [
      'curl',
      'npm',
      'pnpm',
      'yarn',
      'bun',
      'brew',
      'custom',
      'unknown',
    ] as const) {
      expect(getUpgradeCommand(method, 'darwin')).not.toBe('opencode upgrade');
    }
  });
});

describe('classifyUpgradeFailure', () => {
  it('classifies our own timeout message', () => {
    expect(classifyUpgradeFailure('OpenCode CLI command timed out', 'darwin')).toBe('timeout');
  });

  it('classifies a locked executable on windows', () => {
    expect(
      classifyUpgradeFailure('EPERM: operation not permitted, rename opencode.exe', 'win32')
    ).toBe('windows-file-locked');
    expect(classifyUpgradeFailure('Access is denied.', 'win32')).toBe('windows-file-locked');
    expect(
      classifyUpgradeFailure('EBUSY: resource busy or locked, unlink opencode.exe', 'win32')
    ).toBe('windows-file-locked');
  });

  it('does not treat posix permission errors as windows locking', () => {
    expect(
      classifyUpgradeFailure(
        "EACCES: permission denied, mkdir '/usr/local/lib/node_modules'",
        'darwin'
      )
    ).toBe('permission-denied');
  });

  it('classifies an undetectable install method', () => {
    expect(classifyUpgradeFailure('Error: unknown installation method', 'darwin')).toBe(
      'unknown-method'
    );
  });

  it('classifies a missing package manager', () => {
    expect(classifyUpgradeFailure('bun: command not found', 'darwin')).toBe(
      'missing-package-manager'
    );
    expect(
      classifyUpgradeFailure("'pnpm' is not recognized as an internal or external command", 'win32')
    ).toBe('missing-package-manager');
  });

  it('classifies network and proxy failures', () => {
    expect(
      classifyUpgradeFailure(
        'request to https://registry.npmjs.org failed, reason: getaddrinfo ENOTFOUND',
        'darwin'
      )
    ).toBe('network');
    expect(classifyUpgradeFailure('self-signed certificate in certificate chain', 'darwin')).toBe(
      'network'
    );
  });

  it('falls back to unknown for unrecognized output', () => {
    expect(classifyUpgradeFailure('something went sideways', 'darwin')).toBe('unknown');
    expect(classifyUpgradeFailure('   ', 'darwin')).toBe('unknown');
  });
});

describe('describeUpgradeFailure', () => {
  it('tells windows users to close the running binary', () => {
    const message = describeUpgradeFailure('windows-file-locked', 'npm', 'win32');
    expect(message).toContain('Close the OpenCode TUI');
    expect(message).toContain('npm install -g opencode-ai@latest');
  });

  it('falls back to reinstall guidance when no command is safe to suggest', () => {
    const message = describeUpgradeFailure('unknown-method', 'unknown', 'darwin');
    expect(message).toContain('could not determine how it was installed');
    expect(message).toContain('Reinstall OpenCode');
  });

  it('never repeats the failed command', () => {
    const kinds = [
      'timeout',
      'windows-file-locked',
      'permission-denied',
      'unknown-method',
      'missing-package-manager',
      'network',
      'unknown',
    ] as const;
    for (const kind of kinds) {
      for (const method of ['curl', 'npm', 'yarn', 'bun', 'brew', 'unknown'] as const) {
        expect(describeUpgradeFailure(kind, method, 'darwin')).not.toContain('opencode upgrade');
      }
    }
  });
});

describe('getRecoveryCommand', () => {
  it('offers nothing when the package manager itself is gone', () => {
    // `bun add -g ...` cannot fix "bun: command not found"; the explanation is
    // the whole recovery here, and a button that must fail is worse than none.
    expect(getRecoveryCommand('missing-package-manager', 'bun', 'darwin')).toBeNull();
    expect(getRecoveryCommand('missing-package-manager', 'npm', 'win32')).toBeNull();
  });

  it('matches the install command for every other failure', () => {
    for (const kind of ['timeout', 'permission-denied', 'network', 'unknown'] as const) {
      expect(getRecoveryCommand(kind, 'npm', 'darwin')).toBe(getUpgradeCommand('npm', 'darwin'));
    }
  });
});

describe('OPENCODE_TERMINAL_COMMANDS', () => {
  // The host validates terminal requests against this list, so a command the
  // UI can produce but the list omits is a button that silently does nothing.
  it('covers every command the recovery states can offer', () => {
    const methods = ['curl', 'npm', 'pnpm', 'yarn', 'bun', 'brew', 'custom', 'unknown'] as const;
    for (const method of methods) {
      for (const platform of ['darwin', 'linux', 'win32']) {
        const command = getUpgradeCommand(method, platform);
        if (command) expect(OPENCODE_TERMINAL_COMMANDS).toContain(command);
      }
    }
    expect(OPENCODE_TERMINAL_COMMANDS).toContain('npm i -g opencode-ai');
    expect(OPENCODE_TERMINAL_COMMANDS).toContain('opencode upgrade');
  });
});
