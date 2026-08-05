// How OpenCode was installed decides which command can actually update it.
// `opencode upgrade` picks its own strategy internally and fails in
// method-specific ways, so when it fails Varro must not recommend it again.
export type OpenCodeInstallMethod =
  | 'curl'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'brew'
  | 'custom'
  | 'unknown';

export type OpenCodeUpgradeFailureKind =
  | 'timeout'
  | 'windows-file-locked'
  | 'permission-denied'
  | 'unknown-method'
  | 'missing-package-manager'
  | 'network'
  | 'unknown';

export const OPENCODE_INSTALL_DOCS_URL = 'https://opencode.ai';

/** The command Varro offers when OpenCode is not installed at all. */
export const OPENCODE_INSTALL_COMMAND = 'npm i -g opencode-ai';

/** OpenCode's own updater, used until it has proven it cannot update this install. */
export const OPENCODE_UPGRADE_COMMAND = 'opencode upgrade';

// This module is compiled into the webview bundle too, so it must not reach
// for Node globals: callers pass the platform in.
export type InstallPlatform = string;

function normalizeBinaryPath(command: string): string {
  return command.replace(/\\/g, '/').toLowerCase();
}

const METHOD_PATH_MARKERS: Array<{ method: OpenCodeInstallMethod; markers: string[] }> = [
  { method: 'curl', markers: ['/.opencode/bin/'] },
  { method: 'bun', markers: ['/.bun/bin/', '/.bun/install/global/'] },
  { method: 'pnpm', markers: ['/pnpm/', '/.pnpm/'] },
  {
    method: 'yarn',
    markers: ['/yarn/global/', '/yarn/data/global/', '/appdata/local/yarn/bin/', '/.yarn/bin/'],
  },
  // Cellar outranks every npm marker: the homebrew/core formula runs `npm
  // install` into libexec, so a brew install really does live at
  // `.../Cellar/opencode/<version>/libexec/lib/node_modules/opencode-ai/...`.
  // Only the Cellar segment separates it from an npm global.
  { method: 'brew', markers: ['/cellar/'] },
  // npm is matched before the generic Homebrew prefixes on purpose: an npm
  // global installed under Homebrew's Node resolves inside
  // `/opt/homebrew/lib/node_modules/`, which `brew upgrade` cannot repair.
  {
    method: 'npm',
    markers: [
      '/.npm-global/',
      '/appdata/roaming/npm/',
      '/lib/node_modules/',
      // Node version managers install global bins into version-scoped trees;
      // those globals are still npm-managed.
      '/fnm/',
      '/.nvm/',
      '/.volta/',
      '/volta/bin/',
      '/.asdf/',
      '/n/versions/node/',
    ],
  },
  { method: 'brew', markers: ['/homebrew/', '/linuxbrew/'] },
];

/**
 * Infers the install method from the resolved binary path. Deliberately free:
 * no extra process spawns, and the candidate directories are the same ones
 * `getServerPathEntries` already scans.
 */
export function detectInstallMethod(options: {
  resolvedCommand: string;
  configuredCommand?: string;
}): OpenCodeInstallMethod {
  const normalized = normalizeBinaryPath(options.resolvedCommand.trim());
  if (normalized && normalized.includes('/')) {
    for (const { method, markers } of METHOD_PATH_MARKERS) {
      if (markers.some((marker) => normalized.includes(marker))) return method;
    }
  }

  if (options.configuredCommand?.trim()) return 'custom';
  return 'unknown';
}

/**
 * The command that repairs an install of this kind after `opencode upgrade`
 * has already failed. Returns null when no single command is safe to
 * recommend: guessing would risk creating a second parallel install.
 */
export function getUpgradeCommand(
  method: OpenCodeInstallMethod,
  platform: InstallPlatform
): string | null {
  switch (method) {
    case 'curl':
      // The shell installer is POSIX-only; on Windows the OpenCode docs point
      // at the package managers instead, so do not invent a command here.
      return platform === 'win32' ? null : 'curl -fsSL https://opencode.ai/install | bash';
    case 'npm':
      return 'npm install -g opencode-ai@latest';
    case 'pnpm':
      return 'pnpm add -g opencode-ai@latest';
    case 'yarn':
      return 'yarn global add opencode-ai@latest';
    case 'bun':
      return 'bun add -g opencode-ai@latest';
    case 'brew':
      // Unqualified on purpose: OpenCode now ships as the homebrew/core
      // `opencode` formula, and Homebrew resolves the bare name against
      // whichever tap actually installed it.
      return 'brew upgrade opencode';
    case 'custom':
    case 'unknown':
      return null;
  }
}

const ALL_INSTALL_METHODS: OpenCodeInstallMethod[] = [
  'curl',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'brew',
  'custom',
  'unknown',
];

/**
 * Every command Varro is willing to put in the user's terminal. The host
 * validates against this list, so a command that is not here cannot be run no
 * matter what the webview asks for.
 */
export const OPENCODE_TERMINAL_COMMANDS: readonly string[] = [
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_UPGRADE_COMMAND,
  ...ALL_INSTALL_METHODS.flatMap((method) =>
    ['darwin', 'linux', 'win32'].map((platform) => getUpgradeCommand(method, platform))
  ).filter((command): command is string => command !== null),
];

/**
 * True for the commands that replace the OpenCode binary on disk. Windows
 * cannot overwrite a running executable, so these need the managed server
 * stopped first - unlike the auth commands, which only touch config.
 */
export function replacesOpenCodeBinary(command: string): boolean {
  return OPENCODE_TERMINAL_COMMANDS.includes(command.trim());
}

export function describeInstallMethod(method: OpenCodeInstallMethod): string {
  switch (method) {
    case 'curl':
      return 'the opencode.ai install script';
    case 'npm':
      return 'npm';
    case 'pnpm':
      return 'pnpm';
    case 'yarn':
      return 'Yarn';
    case 'bun':
      return 'bun';
    case 'brew':
      return 'Homebrew';
    case 'custom':
      return 'a path configured in varro.server.command';
    case 'unknown':
      return 'an unrecognized method';
  }
}

const FAILURE_PATTERNS: Array<{ kind: OpenCodeUpgradeFailureKind; pattern: RegExp }> = [
  { kind: 'unknown-method', pattern: /unknown installation method|could not determine.*install/i },
  {
    kind: 'network',
    pattern:
      /enotfound|econnrefused|econnreset|etimedout|getaddrinfo|socket hang up|network|proxy|certificate|self[- ]signed|tunneling socket/i,
  },
  { kind: 'permission-denied', pattern: /eacces|permission denied|operation not permitted/i },
  {
    kind: 'missing-package-manager',
    pattern: /command not found|is not recognized|enoent|no such file or directory/i,
  },
];

/**
 * Maps raw `opencode upgrade` stderr onto an actionable cause. Windows file
 * locking is checked first because its errno (EPERM/EBUSY) overlaps with the
 * generic permission case but needs completely different advice.
 */
export function classifyUpgradeFailure(
  stderr: string,
  platform: InstallPlatform
): OpenCodeUpgradeFailureKind {
  const text = stderr.trim();
  if (!text) return 'unknown';

  if (/timed out/i.test(text)) return 'timeout';

  if (
    platform === 'win32' &&
    /eperm|ebusy|access is denied|being used by another process|resource busy/i.test(text)
  ) {
    return 'windows-file-locked';
  }

  for (const { kind, pattern } of FAILURE_PATTERNS) {
    if (pattern.test(text)) return kind;
  }
  return 'unknown';
}

/**
 * The command to offer as a one-click action after a failure, which is not
 * always the command that repairs the install: when the package manager itself
 * is gone, running it again is guaranteed to fail the same way, so the user is
 * left with the explanation instead of a button that cannot work.
 */
export function getRecoveryCommand(
  kind: OpenCodeUpgradeFailureKind,
  method: OpenCodeInstallMethod,
  platform: InstallPlatform
): string | null {
  if (kind === 'missing-package-manager') return null;
  return getUpgradeCommand(method, platform);
}

/**
 * The one sentence that tells the user what to do next. Never repeats
 * `opencode upgrade`, which is the command that just failed.
 */
export function describeUpgradeFailure(
  kind: OpenCodeUpgradeFailureKind,
  method: OpenCodeInstallMethod,
  platform: InstallPlatform
): string {
  const command = getUpgradeCommand(method, platform);
  const fallback = command
    ? `Update it manually with: ${command}`
    : `Reinstall OpenCode using the method you originally used (${describeInstallMethod(method)}), then restart the server.`;

  switch (kind) {
    case 'timeout':
      return `The update did not finish in time. It may still be downloading, so running it in a terminal shows progress. ${fallback}`;
    case 'windows-file-locked':
      return `Windows could not replace opencode.exe because it is still running. Close the OpenCode TUI and any other VS Code window using Varro, then retry. ${fallback}`;
    case 'permission-denied':
      return command?.startsWith('npm')
        ? `The update was denied write access to the global install directory. Either re-run it with elevated permissions or switch to a user-owned prefix. ${fallback}`
        : `The update was denied write access to the install directory. ${fallback}`;
    case 'unknown-method':
      return `OpenCode could not determine how it was installed, so it cannot update itself. ${fallback}`;
    case 'missing-package-manager':
      return `The package manager that installed OpenCode (${describeInstallMethod(method)}) is no longer available on PATH. Reinstall it, or install OpenCode with a different method.`;
    case 'network':
      return `The update could not reach the download server. Check your connection or proxy settings, then retry. ${fallback}`;
    case 'unknown':
      return fallback;
  }
}
