import { lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, realpath, symlink } from 'node:fs/promises';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'node:path';
import { asRecord } from '../shared/type-utils';
import { getVarroTestStateDirectory, type VarroStateKind } from './varro-test-state';

/** Shared across editor distributions, profiles, workspaces, and extension versions. */
export function getVarroStateDirectory(kind: VarroStateKind): string {
  const isolated = getVarroTestStateDirectory(kind);
  if (isolated) return isolated;
  const home = homedir();
  const root =
    process.platform === 'win32'
      ? join(absoluteEnvironmentPath('LOCALAPPDATA') || join(home, 'AppData', 'Local'), 'Varro')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support', 'Varro')
        : join(absoluteEnvironmentPath('XDG_STATE_HOME') || join(home, '.local', 'state'), 'varro');
  return join(root, kind);
}

export function getLegacyVarroStateDirectory(
  kind: 'opencode-v2' | 'provider-quota-v2'
): string | undefined {
  if (getVarroTestStateDirectory(kind)) return undefined;
  const home = homedir();
  // Preserve the old interpretation of XDG_STATE_HOME for compatibility, even if relative.
  const legacy =
    kind === 'opencode-v2'
      ? join(process.env.XDG_STATE_HOME || join(home, '.local', 'state'), 'varro', kind)
      : join(home, '.varro-provider-quota-v2');
  return legacy === getVarroStateDirectory(kind) ? undefined : legacy;
}

/** Usage workers remain read-only, including before a compatibility link exists. */
export function getVarroStateReadDirectory(kind: 'opencode-v2'): string {
  const directory = getVarroStateDirectory(kind);
  const legacy = getLegacyVarroStateDirectory(kind);
  if (!legacy || !pathExistsSync(legacy)) return directory;
  if (!pathExistsSync(directory)) return legacy;
  if (realpathSync(directory) !== realpathSync(legacy))
    throw conflictingDirectories(directory, legacy);
  return directory;
}

/** Keep legacy writers on the same files, including locks and atomic replacements. */
export async function prepareVarroStateDirectory(
  directory: string,
  legacyDirectory?: string
): Promise<string> {
  if (legacyDirectory && (await pathExists(legacyDirectory))) {
    const legacyInfo = await lstat(legacyDirectory);
    if (!legacyInfo.isDirectory()) {
      // An offline relocation may leave the reverse compatibility link behind.
      if (
        legacyInfo.isSymbolicLink() &&
        (await pathExists(directory)) &&
        (await realpath(directory)) === (await realpath(legacyDirectory))
      )
        return realpath(directory);
      throw new Error(`Expected a real Varro state directory: ${legacyDirectory}`);
    }
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
    try {
      // Junctions work without Windows' symbolic-link privilege. Absolute targets
      // also keep the link valid when the state root is reached through another path.
      await symlink(
        await realpath(legacyDirectory),
        directory,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      if (asRecord(error)?.code !== 'EEXIST') throw error;
    }
    const target = await realpath(directory);
    if (target !== (await realpath(legacyDirectory)))
      throw conflictingDirectories(directory, legacyDirectory);
    return target;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function conflictingDirectories(directory: string, legacyDirectory: string): Error {
  return new Error(
    `Conflicting Varro state directories: ${directory} and ${legacyDirectory}. Close all editors and reconcile them before continuing.`
  );
}

function pathExistsSync(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') return false;
    throw error;
  }
}

function absoluteEnvironmentPath(name: 'LOCALAPPDATA' | 'XDG_STATE_HOME'): string | undefined {
  const value = process.env[name];
  return value && isAbsolute(value) ? value : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (asRecord(error)?.code === 'ENOENT') return false;
    throw error;
  }
}
