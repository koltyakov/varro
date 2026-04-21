import { delimiter as defaultDelimiter, join as defaultJoin, win32 } from 'path';

function getPathTools(platform = process.platform) {
  return platform === 'win32'
    ? { delimiter: ';', join: win32.join }
    : { delimiter: defaultDelimiter, join: defaultJoin };
}

export function getPathVariableKey(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): string {
  if (platform !== 'win32') {
    return 'PATH';
  }

  const existingKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  return existingKey || 'Path';
}

function getPathVariableValue(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  return env[getPathVariableKey(env, platform)] || '';
}

export function getServerPathEntries(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): string[] {
  const { delimiter, join } = getPathTools(platform);
  const home = env.HOME || env.USERPROFILE;
  const pathEntries = getPathVariableValue(env, platform).split(delimiter).filter(Boolean);
  const extras =
    platform === 'win32'
      ? [
          ...(env.PNPM_HOME ? [env.PNPM_HOME] : []),
          ...(env.APPDATA ? [join(env.APPDATA, 'npm')] : []),
          ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'pnpm')] : []),
          ...(home ? [join(home, '.opencode', 'bin')] : []),
          ...(home ? [join(home, '.bun', 'bin')] : []),
        ]
      : [
          ...(home ? [join(home, '.opencode', 'bin')] : []),
          ...(home ? [join(home, '.npm-global', 'bin')] : []),
          ...(home ? [join(home, '.local', 'bin')] : []),
          ...(home ? [join(home, '.bun', 'bin')] : []),
          ...(home ? [join(home, 'Library', 'pnpm')] : []),
          '/opt/homebrew/bin',
          '/usr/local/bin',
        ];

  return [...new Set([...pathEntries, ...extras].filter(Boolean))];
}

export function buildServerEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform
): NodeJS.ProcessEnv {
  const { delimiter } = getPathTools(platform);
  const nextEnv = { ...env };
  for (const key of Object.keys(nextEnv)) {
    if (key.toLowerCase() === 'path') {
      delete nextEnv[key];
    }
  }

  nextEnv[getPathVariableKey(env, platform)] = getServerPathEntries(env, platform).join(delimiter);
  return nextEnv;
}
