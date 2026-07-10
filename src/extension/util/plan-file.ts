import { createHash } from 'crypto';
import { homedir } from 'os';
import { posix, win32 } from 'path';

function getJoin(platform = process.platform) {
  return platform === 'win32' ? win32.join : posix.join;
}

export function normalizePlanMarkdown(content: string) {
  return content.replace(/\r\n?/g, '\n').trim();
}

export function getOpenCodeConfigDir(
  env = process.env,
  home = homedir(),
  platform = process.platform
) {
  const join = getJoin(platform);
  return env.XDG_CONFIG_HOME?.trim() || join(home, '.config');
}

export function getOpenCodePlansDirectory(
  env = process.env,
  home = homedir(),
  platform = process.platform
) {
  const join = getJoin(platform);
  return join(getOpenCodeConfigDir(env, home, platform), 'opencode', 'plans');
}

export function getPlanHash(content: string) {
  return createHash('sha256').update(normalizePlanMarkdown(content)).digest('hex').slice(0, 16);
}

export function getPlanFileName(content: string) {
  return `plan-${getPlanHash(content)}.md`;
}

export function getPlanFilePath(
  content: string,
  env = process.env,
  home = homedir(),
  platform = process.platform
) {
  const join = getJoin(platform);
  return join(getOpenCodePlansDirectory(env, home, platform), getPlanFileName(content));
}
