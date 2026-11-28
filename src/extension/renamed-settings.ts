import * as vscode from 'vscode';
import { isString } from '../shared/type-utils';

/** Released setting keys that were renamed, by current key. Both are relative to `varro`. */
const LEGACY_KEYS = {
  'permissions.approveModel': 'chat.autoApproveModel',
} as const;

export type RenamedSetting = keyof typeof LEGACY_KEYS;

/**
 * Returns the explicitly configured user-level value of a renamed setting, or `undefined` when
 * neither key is set or the configured value has another type. Workspace and folder values are
 * never read, so a repository cannot supply them. The current key wins over the released key, and
 * the first configured value decides, so an invalid current value never revives the released one.
 */
function readConfigured<T>(
  key: RenamedSetting,
  isType: <V>(value: V) => value is V & T,
  config: vscode.WorkspaceConfiguration
): T | undefined {
  for (const settingKey of [key, LEGACY_KEYS[key]]) {
    const value = config.inspect?.<unknown>(settingKey)?.globalValue;
    if (value !== undefined) return isType(value) ? value : undefined;
  }
  return undefined;
}

export function readRenamedString(
  key: RenamedSetting,
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): string | undefined {
  return readConfigured(key, isString, config);
}

/**
 * Writes a renamed setting to user settings under its current key and drops the released user
 * value, which would otherwise come back as soon as the current key is cleared.
 */
export async function writeRenamedSetting(
  key: RenamedSetting,
  value: string | undefined,
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): Promise<void> {
  await config.update(key, value, vscode.ConfigurationTarget.Global);
  const legacyKey = LEGACY_KEYS[key];
  if (config.inspect?.<unknown>(legacyKey)?.globalValue !== undefined) {
    await config.update(legacyKey, undefined, vscode.ConfigurationTarget.Global);
  }
}

/**
 * Moves released user values to their current keys, so the Settings editor shows them under the
 * new names and resetting a new setting to its default cannot leave a released value in effect.
 * An already set current key wins and the released value is dropped. Workspace and folder values
 * live in repository files and are left to the fallback reads. Best effort: a failed write is
 * reported through `warn`, and a partial move still reads correctly through the fallback.
 */
export async function migrateRenamedSettings(
  warn: (message: string) => void,
  config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('varro')
): Promise<void> {
  // A remote window's user level can include remote settings, but Global writes go to local user
  // settings, so a move could plant a remote-only value on this machine.
  if (vscode.env?.remoteName) return;
  for (const [key, legacyKey] of Object.entries(LEGACY_KEYS)) {
    const legacyValue = config.inspect?.<unknown>(legacyKey)?.globalValue;
    if (legacyValue === undefined) continue;
    try {
      if (config.inspect?.<unknown>(key)?.globalValue === undefined) {
        await config.update(key, legacyValue, vscode.ConfigurationTarget.Global);
      }
      await config.update(legacyKey, undefined, vscode.ConfigurationTarget.Global);
    } catch (error) {
      warn(
        `Could not move varro.${legacyKey} to varro.${key}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/** Whether a change touches a renamed setting under its current or released key. */
export function affectsRenamedSetting(
  event: Pick<vscode.ConfigurationChangeEvent, 'affectsConfiguration'>,
  key: RenamedSetting
): boolean {
  return (
    event.affectsConfiguration(`varro.${key}`) ||
    event.affectsConfiguration(`varro.${LEGACY_KEYS[key]}`)
  );
}
