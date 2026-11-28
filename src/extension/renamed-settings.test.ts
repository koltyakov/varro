/* oxlint-disable anti-slop/no-module-mocking -- VS Code settings are substituted so no user settings are read or written. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SettingValue = string | number | boolean | undefined;
type Level = 'globalValue' | 'workspaceValue' | 'workspaceFolderValue' | 'defaultValue';
type SettingLevels = Partial<Record<Level, SettingValue>>;
/** The part of `vscode.env` the migration reads. */
type ExtensionHostEnv = { remoteName?: string };

const mocks = vi.hoisted(() => {
  const levels = new Map<string, SettingLevels>();
  const config = {
    inspect: vi.fn((key: string) => levels.get(key)),
    update: vi.fn(async (key: string, value: SettingValue) => {
      levels.set(key, { ...levels.get(key), globalValue: value });
    }),
  };
  const env: ExtensionHostEnv = {};
  return { levels, config, env };
});

vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  env: mocks.env,
  workspace: { getConfiguration: () => mocks.config },
}));

import {
  affectsRenamedSetting,
  migrateRenamedSettings,
  readRenamedString,
  writeRenamedSetting,
  type RenamedSetting,
} from './renamed-settings';

/** The only rename that keeps backward compatibility. */
const RENAMES: [RenamedSetting, string][] = [['permissions.approveModel', 'chat.autoApproveModel']];

function set(key: string, level: Level, value: SettingValue) {
  mocks.levels.set(key, { ...mocks.levels.get(key), [level]: value });
}

beforeEach(() => {
  mocks.levels.clear();
  delete mocks.env.remoteName;
  vi.clearAllMocks();
});

describe.each(RENAMES)('%s (released as %s)', (key, legacyKey) => {
  it('falls back to the released key until the current key is set', () => {
    expect(readRenamedString(key)).toBeUndefined();

    set(legacyKey, 'globalValue', 'legacy');
    expect(readRenamedString(key)).toBe('legacy');

    set(key, 'globalValue', 'current');
    expect(readRenamedString(key)).toBe('current');
  });

  it('reads only explicitly configured values, never a contributed default', () => {
    set(key, 'defaultValue', 'contributed');
    set(legacyKey, 'defaultValue', 'legacy-default');

    expect(readRenamedString(key)).toBeUndefined();
  });

  it('does not revive the released value when the current value has the wrong type', () => {
    set(key, 'globalValue', 42);
    set(legacyKey, 'globalValue', 'legacy');

    expect(readRenamedString(key)).toBeUndefined();
  });

  it('ignores workspace and folder values under both keys', () => {
    set(key, 'workspaceValue', 'repository');
    set(legacyKey, 'workspaceFolderValue', 'repository-folder');
    expect(readRenamedString(key)).toBeUndefined();

    set(legacyKey, 'globalValue', 'legacy');
    expect(readRenamedString(key)).toBe('legacy');
  });

  it('drops the released user value on write', async () => {
    set(legacyKey, 'globalValue', 'legacy');

    await writeRenamedSetting(key, 'next');

    expect(mocks.config.update.mock.calls).toEqual([
      [key, 'next', 1],
      [legacyKey, undefined, 1],
    ]);
    expect(readRenamedString(key)).toBe('next');
  });

  it('does not revive the released value when the current key is cleared', async () => {
    set(key, 'globalValue', 'current');
    set(legacyKey, 'globalValue', 'legacy');

    await writeRenamedSetting(key, undefined);

    expect(readRenamedString(key)).toBeUndefined();
  });

  it('leaves the released key untouched when it was never set', async () => {
    await writeRenamedSetting(key, 'next');

    expect(mocks.config.update.mock.calls).toEqual([[key, 'next', 1]]);
  });

  it('moves a released user value to the current key on startup', async () => {
    set(legacyKey, 'globalValue', 'legacy');
    const warn = vi.fn();

    await migrateRenamedSettings(warn);

    expect(mocks.config.update.mock.calls).toEqual([
      [key, 'legacy', 1],
      [legacyKey, undefined, 1],
    ]);
    expect(readRenamedString(key)).toBe('legacy');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the current value and drops the released one when both are set', async () => {
    set(key, 'globalValue', 'current');
    set(legacyKey, 'globalValue', 'legacy');

    await migrateRenamedSettings(vi.fn());

    expect(mocks.config.update.mock.calls).toEqual([[legacyKey, undefined, 1]]);
    expect(readRenamedString(key)).toBe('current');
  });

  it('leaves workspace and folder values under both keys alone on startup', async () => {
    set(legacyKey, 'workspaceValue', 'repository');
    set(legacyKey, 'workspaceFolderValue', 'repository-folder');
    set(key, 'workspaceValue', 'repository');

    await migrateRenamedSettings(vi.fn());

    expect(mocks.config.update).not.toHaveBeenCalled();
  });

  it('reports changes to either key', () => {
    for (const changed of [`varro.${key}`, `varro.${legacyKey}`]) {
      expect(
        affectsRenamedSetting({ affectsConfiguration: (section) => section === changed }, key)
      ).toBe(true);
    }
    expect(
      affectsRenamedSetting(
        { affectsConfiguration: (section) => section === 'varro.chat.fontSize' },
        key
      )
    ).toBe(false);
  });
});

describe('migrateRenamedSettings', () => {
  it('writes nothing when no released user value is set', async () => {
    set('permissions.approveModel', 'globalValue', 'openai/judge');
    set('chat.autoApproveModel', 'defaultValue', '');

    await migrateRenamedSettings(vi.fn());

    expect(mocks.config.update).not.toHaveBeenCalled();
  });

  it('moves the value unchanged, leaving validation to the readers', async () => {
    set('chat.autoApproveModel', 'globalValue', 'not a model');

    await migrateRenamedSettings(vi.fn());

    expect(mocks.levels.get('permissions.approveModel')?.globalValue).toBe('not a model');
  });

  it('moves an explicit empty value, which the Settings editor could not set on the new key', async () => {
    set('chat.autoApproveModel', 'globalValue', '');

    await migrateRenamedSettings(vi.fn());

    expect(mocks.config.update.mock.calls).toEqual([
      ['permissions.approveModel', '', 1],
      ['chat.autoApproveModel', undefined, 1],
    ]);
  });

  it('is idempotent', async () => {
    set('chat.autoApproveModel', 'globalValue', 'openai/judge');

    await migrateRenamedSettings(vi.fn());
    const firstRun = mocks.config.update.mock.calls.length;
    await migrateRenamedSettings(vi.fn());

    expect(firstRun).toBe(2);
    expect(mocks.config.update).toHaveBeenCalledTimes(firstRun);
    expect(readRenamedString('permissions.approveModel')).toBe('openai/judge');
  });

  it('does nothing in a remote window, whose user level can include remote settings', async () => {
    mocks.env.remoteName = 'ssh-remote';
    set('chat.autoApproveModel', 'globalValue', 'remote/judge');

    await migrateRenamedSettings(vi.fn());

    expect(mocks.config.update).not.toHaveBeenCalled();
    expect(readRenamedString('permissions.approveModel')).toBe('remote/judge');
  });

  it('logs a rejected write and still reads the partial state', async () => {
    set('chat.autoApproveModel', 'globalValue', 'openai/judge');
    mocks.config.update.mockImplementationOnce(async () => {
      throw new Error('settings file is read-only');
    });
    const warn = vi.fn();

    await expect(migrateRenamedSettings(warn)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'Could not move varro.chat.autoApproveModel to varro.permissions.approveModel: settings file is read-only'
    );
    expect(readRenamedString('permissions.approveModel')).toBe('openai/judge');
  });

  it.each([
    ['chat.desktopSessionPaneSide', 'left'],
    ['chat.autoRenameUntitledSessions', true],
    ['chat.promptCacheWarningTokens', 1234],
    ['chat.permissionGuidance', 'off'],
    ['chat.permissionGuidanceText', 'Ask first.'],
    ['chat.promptCompletionModel', 'openai/fast'],
    ['chat.promptTrace', true],
    ['providerLimits.statusBarDisplay', 'all'],
    ['review.model', 'openai/review'],
    ['chat.defaultPermissionMode', 'full'],
    ['chat.autoApproveDecisionModel', 'typesafe-ai/jev'],
    ['chat.followupsEnabled', false],
    ['chat.followupModel', 'openai/fast'],
    ['chat.groupComposerBlocks', false],
    ['debug.showNativeDecisionModels', true],
    ['chat.showEmptyStateHistogram', true],
    ['decisions.jev.autoApprove', true],
    ['chat.promptCacheWarming', 'all'],
    ['chat.promptCacheWarmingMinutes', 120],
  ] as const)('neither reads nor moves the removed %s setting', async (removedKey, value) => {
    set(removedKey, 'globalValue', value);

    await migrateRenamedSettings(vi.fn());

    expect(mocks.config.update).not.toHaveBeenCalled();
  });
});
