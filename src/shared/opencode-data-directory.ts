import { homedir } from 'node:os';
import { join } from 'node:path';

export function resolveOpenCodeDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  return join(dataHome, 'opencode');
}
