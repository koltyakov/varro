/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- These tests provide VS Code configuration boundary values. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** The levels of `WorkspaceConfiguration.inspect` these tests supply. */
type InspectedSetting = {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
};

const mocks = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const workspaceValues = new Map<string, unknown>();
  const folderValues = new Map<string, unknown>();
  return {
    /** User settings. */
    values,
    /** Repository `.vscode/settings.json` values, which win in `get` as they do in VS Code. */
    workspaceValues,
    /** Workspace folder settings, which win over workspace settings. */
    folderValues,
    getConfiguration: vi.fn((section: string) => ({
      inspect: vi.fn((key: string): InspectedSetting => ({
        globalValue: values.get(`${section}.${key}`),
        workspaceValue: workspaceValues.get(`${section}.${key}`),
        workspaceFolderValue: folderValues.get(`${section}.${key}`),
      })),
      get: vi.fn((key: string, fallback?: unknown) => {
        const fullKey = `${section}.${key}`;
        if (folderValues.has(fullKey)) return folderValues.get(fullKey);
        if (workspaceValues.has(fullKey)) return workspaceValues.get(fullKey);
        return values.has(fullKey) ? values.get(fullKey) : fallback;
      }),
    })),
  };
});

vi.mock('vscode', () => ({
  workspace: { getConfiguration: mocks.getConfiguration },
}));

import {
  hasIgnoredWorkspaceServerCommand,
  readAutoApproveDecisionModel,
  readAutoApproveModel,
  readExtensionConfigState,
  readFollowupModel,
  readFollowupsEnabled,
  readPermissionGuidance,
  readPromptCompletionModel,
  readPromptTrace,
  readServerCommand,
} from './extension-config';

describe('readExtensionConfigState', () => {
  beforeEach(() => {
    mocks.values.clear();
    mocks.workspaceValues.clear();
    mocks.folderValues.clear();
    vi.clearAllMocks();
  });

  it('reads the VS Code chat font size and font family', () => {
    mocks.values.set('chat.fontSize', 15.5);
    mocks.values.set('chat.editor.fontSize', 16);
    mocks.values.set('chat.fontFamily', 'Iosevka, monospace');

    expect(readExtensionConfigState()).toMatchObject({
      chatFontSize: 15.5,
      chatEditorFontSize: 16,
      chatFontFamily: 'Iosevka, monospace',
    });
  });

  it('uses VS Code typography defaults when settings are absent', () => {
    expect(readExtensionConfigState()).toMatchObject({
      expandThinking: false,
      showTurnTimer: true,
      groupComposerBlocks: true,
      followupsEnabled: true,
      debugShowQuotaWarning: false,
      debugResetWarningDays: 5,
      promptCacheWarningTokens: 300_000,
      autoAttachProblems: false,
      autoAttachActiveFile: true,
      desktopSessionPaneSide: 'right',
      defaultPermissionMode: 'auto',
      chatFontSize: 13,
      chatEditorFontSize: 12,
      chatFontFamily: 'default',
    });
  });

  it('reads the expand-thinking setting', () => {
    mocks.values.set('varro.chat.expandThinking', true);
    expect(readExtensionConfigState().expandThinking).toBe(true);
    mocks.values.set('varro.chat.autoExpandThinking', false);
    expect(readExtensionConfigState().expandThinking).toBe(true);
  });

  it('reads the turn-timer setting', () => {
    mocks.values.set('varro.chat.showTurnTimer', false);

    expect(readExtensionConfigState().showTurnTimer).toBe(false);
  });

  it('reads the tabbed panels opt-out and ignores the removed key', () => {
    mocks.values.set('varro.chat.groupComposerBlocks', false);
    expect(readExtensionConfigState().groupComposerBlocks).toBe(true);
    mocks.values.set('varro.chat.tabbedPanels', false);
    expect(readExtensionConfigState().groupComposerBlocks).toBe(false);
  });

  it('no longer reads the removed empty-state histogram setting', () => {
    mocks.values.set('varro.chat.showEmptyStateHistogram', true);

    expect(readExtensionConfigState()).not.toHaveProperty('showEmptyStateHistogram');
  });

  it('defaults follow-ups to enabled and respects a user-level opt-out', () => {
    expect(readExtensionConfigState().followupsEnabled).toBe(true);
    mocks.values.set('varro.followups.enabled', false);
    expect(readExtensionConfigState().followupsEnabled).toBe(false);
    mocks.values.set('varro.followups.enabled', true);
    expect(readExtensionConfigState().followupsEnabled).toBe(true);
  });

  it('no longer reads the removed follow-up keys', () => {
    mocks.values.set('varro.chat.followupsEnabled', false);
    mocks.values.set('varro.chat.followupModel', 'openai/legacy');
    expect(readFollowupsEnabled()).toBe(true);
    expect(readFollowupModel()).toBe('');
  });

  it('ignores repository follow-up settings', () => {
    mocks.workspaceValues.set('varro.followups.enabled', false);
    mocks.folderValues.set('varro.followups.enabled', false);
    expect(readFollowupsEnabled()).toBe(true);
    mocks.values.set('varro.followups.enabled', false);
    mocks.workspaceValues.set('varro.followups.enabled', true);
    expect(readFollowupsEnabled()).toBe(false);

    mocks.workspaceValues.set('varro.followups.model', 'openai/from-repository');
    mocks.folderValues.set('varro.followups.model', 'openai/from-folder');
    expect(readFollowupModel()).toBe('');
  });

  it('does not let repository settings override the follow-up opt-out', () => {
    mocks.getConfiguration.mockReturnValueOnce({
      get: vi.fn(() => true),
      inspect: vi.fn(() => ({ globalValue: false })),
    });
    expect(readExtensionConfigState().followupsEnabled).toBe(false);
  });

  it('reads follow-up model overrides only from user settings', () => {
    expect(readExtensionConfigState().followupModel).toBe('');
    mocks.values.set('varro.followups.model', ' openai/fast ');
    expect(readExtensionConfigState().followupModel).toBe('openai/fast');
    mocks.getConfiguration.mockReturnValueOnce({
      get: vi.fn(() => 'openai/from-repository'),
      inspect: vi.fn(() => ({ globalValue: undefined })),
    });
    expect(readExtensionConfigState().followupModel).toBe('');
  });

  it('defaults prompt tracing to disabled and requires an explicit user opt-in', () => {
    expect(readPromptTrace()).toBe(false);
    for (const value of [false, 'true', 1, null]) {
      mocks.values.set('varro.promptTracing.enabled', value);
      expect(readPromptTrace()).toBe(false);
    }
    mocks.values.set('varro.promptTracing.enabled', true);
    expect(readPromptTrace()).toBe(true);
  });

  it('no longer reads the removed prompt tracing key', () => {
    mocks.values.set('varro.chat.promptTrace', true);
    expect(readPromptTrace()).toBe(false);
  });

  it('does not let workspace or folder settings enable prompt tracing', () => {
    mocks.workspaceValues.set('varro.promptTracing.enabled', true);
    mocks.folderValues.set('varro.promptTracing.enabled', true);
    expect(readPromptTrace()).toBe(false);
  });

  it('does not let repository settings enable prompt tracing', () => {
    mocks.getConfiguration.mockReturnValueOnce({
      get: vi.fn(() => true),
      inspect: vi.fn(() => ({ globalValue: undefined })),
    });
    expect(readPromptTrace()).toBe(false);
  });

  it('reads permission guidance only from user settings and falls back to the default', () => {
    expect(readPermissionGuidance()).toEqual({ mode: 'default' });
    mocks.values.set('varro.permissions.onReject', 'off');
    expect(readPermissionGuidance()).toEqual({ mode: 'off' });
    mocks.values.set('varro.permissions.onReject', 'custom');
    expect(readPermissionGuidance()).toEqual({ mode: 'default' });
    mocks.values.set('varro.permissions.onRejectCustom', '  Ask first.  ');
    expect(readPermissionGuidance()).toEqual({ mode: 'custom', text: 'Ask first.' });
    mocks.values.set('varro.permissions.onReject', 'unexpected');
    expect(readPermissionGuidance()).toEqual({ mode: 'default' });
    mocks.getConfiguration.mockReturnValueOnce({
      get: vi.fn(() => 'off'),
      inspect: vi.fn(() => ({ globalValue: undefined })),
    });
    expect(readPermissionGuidance()).toEqual({ mode: 'default' });
  });

  it('no longer reads the removed permission guidance keys', () => {
    mocks.values.set('varro.chat.permissionGuidance', 'custom');
    mocks.values.set('varro.chat.permissionGuidanceText', 'Legacy policy.');
    expect(readPermissionGuidance()).toEqual({ mode: 'default' });
    mocks.values.set('varro.chat.permissionGuidance', 'off');
    expect(readPermissionGuidance()).toEqual({ mode: 'default' });
  });

  it('ignores repository permission guidance', () => {
    for (const values of [mocks.workspaceValues, mocks.folderValues]) {
      values.set('varro.permissions.onReject', 'off');
    }
    expect(readPermissionGuidance()).toEqual({ mode: 'default' });

    mocks.values.set('varro.permissions.onReject', 'custom');
    mocks.workspaceValues.set('varro.permissions.onRejectCustom', 'Repository text.');
    expect(readPermissionGuidance()).toEqual({ mode: 'default' });
  });

  it('does not silently broaden an old follow-up-only tracing opt-in', () => {
    mocks.values.set('varro.chat.followupTrace', true);
    expect(readPromptTrace()).toBe(false);
  });

  it('defaults to ask and reads automatic loading only from application settings', () => {
    expect(readExtensionConfigState().remoteImages).toBe('ask');
    mocks.values.set('varro.chat.remoteImages', 'on');
    expect(readExtensionConfigState().remoteImages).toBe('on');
    mocks.getConfiguration.mockReturnValueOnce({
      get: vi.fn(() => 'on'),
      inspect: vi.fn(() => ({ globalValue: undefined })),
    });
    expect(readExtensionConfigState().remoteImages).toBe('ask');
  });

  it('reads the quota-warning debug setting', () => {
    mocks.values.set('varro.debug.showQuotaWarning', true);
    expect(readExtensionConfigState().debugShowQuotaWarning).toBe(true);
  });

  it.each([14, 30, 5.5])('reads a custom reset warning window of %s days', (days) => {
    mocks.values.set('varro.debug.resetWarningDays', days);
    expect(readExtensionConfigState().debugResetWarningDays).toBe(days);
  });

  it.each([0, 4, -1, NaN, Infinity, '14'])('defaults invalid reset warning days %s', (days) => {
    mocks.values.set('varro.debug.resetWarningDays', days);
    expect(readExtensionConfigState().debugResetWarningDays).toBe(5);
  });

  it.each([
    [50_000, 50_000],
    [0, 0],
    [12_345.6, 12_346],
  ])('reads a prompt cache warning threshold of %s tokens', (value, expected) => {
    mocks.values.set('varro.chat.cacheWarningTokens', value);
    expect(readExtensionConfigState().promptCacheWarningTokens).toBe(expected);
  });

  it.each([-1, NaN, Infinity, '50000'])(
    'defaults an invalid prompt cache warning threshold %s',
    (value) => {
      mocks.values.set('varro.chat.cacheWarningTokens', value);
      expect(readExtensionConfigState().promptCacheWarningTokens).toBe(300_000);
    }
  );

  it('no longer reads the removed prompt cache warning threshold key', () => {
    mocks.values.set('varro.chat.promptCacheWarningTokens', 50_000);
    expect(readExtensionConfigState().promptCacheWarningTokens).toBe(300_000);
  });

  it('lets a workspace set the prompt cache warning threshold', () => {
    mocks.values.set('varro.chat.cacheWarningTokens', 80_000);
    mocks.workspaceValues.set('varro.chat.cacheWarningTokens', 10_000);
    expect(readExtensionConfigState().promptCacheWarningTokens).toBe(10_000);
  });

  it('reads the auto-approve model from user settings and falls back to the released key', () => {
    expect(readAutoApproveModel()).toBe('');
    mocks.values.set('varro.chat.autoApproveModel', 'openai/legacy');
    expect(readAutoApproveModel()).toBe('openai/legacy');
    mocks.values.set('varro.permissions.approveModel', 'openai/current');
    expect(readAutoApproveModel()).toBe('openai/current');
    // An explicit empty value turns the feature off without reviving the released key.
    mocks.values.set('varro.permissions.approveModel', '');
    expect(readAutoApproveModel()).toBe('');
    mocks.values.clear();
    mocks.workspaceValues.set('varro.permissions.approveModel', 'openai/from-repository');
    mocks.workspaceValues.set('varro.chat.autoApproveModel', 'openai/from-repository');
    expect(readAutoApproveModel()).toBe('');
  });

  it('reads the decision model only from varro.permissions.decisionModel in user settings', () => {
    expect(readAutoApproveDecisionModel()).toBe('');
    mocks.values.set('varro.chat.autoApproveDecisionModel', 'typesafe-ai/legacy');
    expect(readAutoApproveDecisionModel()).toBe('');
    mocks.values.set('varro.permissions.decisionModel', 'typesafe/jev-latest');
    expect(readAutoApproveDecisionModel()).toBe('typesafe/jev-latest');
    mocks.values.clear();
    mocks.workspaceValues.set('varro.permissions.decisionModel', 'typesafe-ai/jev');
    expect(readAutoApproveDecisionModel()).toBe('');
  });

  it('reads the OpenCode executable path only from user settings', () => {
    expect(readServerCommand()).toBe('');
    expect(hasIgnoredWorkspaceServerCommand()).toBe(false);
    mocks.values.set('varro.server.command', '/opt/opencode/bin/opencode');
    expect(readServerCommand()).toBe('/opt/opencode/bin/opencode');
    expect(hasIgnoredWorkspaceServerCommand()).toBe(false);

    mocks.workspaceValues.set('varro.server.command', './tools/opencode');
    expect(readServerCommand()).toBe('/opt/opencode/bin/opencode');
    expect(hasIgnoredWorkspaceServerCommand()).toBe(true);

    mocks.values.delete('varro.server.command');
    expect(readServerCommand()).toBe('');
  });

  it('ignores a folder executable path', () => {
    mocks.folderValues.set('varro.server.command', './tools/opencode');
    expect(readServerCommand()).toBe('');
    expect(hasIgnoredWorkspaceServerCommand()).toBe(true);
  });

  it('does not report an empty workspace executable path as ignored', () => {
    mocks.workspaceValues.set('varro.server.command', '  ');
    mocks.folderValues.set('varro.server.command', '');
    expect(hasIgnoredWorkspaceServerCommand()).toBe(false);
  });

  it('reads the prompt completion model and ignores the removed key', () => {
    expect(readPromptCompletionModel()).toBe('');
    mocks.values.set('varro.chat.promptCompletionModel', 'openai/legacy');
    expect(readPromptCompletionModel()).toBe('');
    mocks.values.set('varro.promptCompletion.model', 'openai/current');
    expect(readPromptCompletionModel()).toBe('openai/current');
    expect(readExtensionConfigState().promptCompletionModel).toBe('openai/current');
  });

  it.each(['default', 'auto', 'full'] as const)(
    'reads the %s default permission mode from user settings',
    (mode) => {
      mocks.values.set('varro.permissions.defaultMode', mode);
      expect(readExtensionConfigState().defaultPermissionMode).toBe(mode);
    }
  );

  it('falls back to the contributed default permission mode for an invalid value', () => {
    mocks.values.set('varro.permissions.defaultMode', 'everything');
    expect(readExtensionConfigState().defaultPermissionMode).toBe('auto');
  });

  it('no longer reads the removed default permission mode key', () => {
    mocks.values.set('varro.chat.defaultPermissionMode', 'full');
    mocks.workspaceValues.set('varro.chat.defaultPermissionMode', 'default');
    expect(readExtensionConfigState().defaultPermissionMode).toBe('auto');
  });

  it.each([
    // [user, workspace, effective]
    [undefined, 'full', 'auto'],
    [undefined, 'default', 'default'],
    ['default', 'auto', 'default'],
    ['default', 'full', 'default'],
    ['auto', 'full', 'auto'],
    ['full', 'auto', 'auto'],
    ['full', 'default', 'default'],
    ['full', 'everything', 'full'],
  ] as const)(
    'with user mode %s, lets a workspace mode of %s only tighten the default to %s',
    (user, workspace, expected) => {
      if (user) mocks.values.set('varro.permissions.defaultMode', user);
      mocks.workspaceValues.set('varro.permissions.defaultMode', workspace);
      expect(readExtensionConfigState().defaultPermissionMode).toBe(expected);
    }
  );

  it('lets a workspace folder tighten the default permission mode', () => {
    mocks.values.set('varro.permissions.defaultMode', 'full');
    mocks.workspaceValues.set('varro.permissions.defaultMode', 'auto');
    mocks.folderValues.set('varro.permissions.defaultMode', 'default');
    expect(readExtensionConfigState().defaultPermissionMode).toBe('default');
  });

  it('reads the sessions pane side and defaults to the contributed side', () => {
    expect(readExtensionConfigState().desktopSessionPaneSide).toBe('right');
    mocks.values.set('varro.chat.sessionsPaneSide', 'left');
    expect(readExtensionConfigState().desktopSessionPaneSide).toBe('left');
    mocks.values.set('varro.chat.sessionsPaneSide', 'bottom');
    expect(readExtensionConfigState().desktopSessionPaneSide).toBe('right');
  });

  it('no longer reads the removed sessions pane side key', () => {
    mocks.values.set('varro.chat.desktopSessionPaneSide', 'left');
    expect(readExtensionConfigState().desktopSessionPaneSide).toBe('right');
  });

  it('keeps Problems context off by default and reads the opt-in', () => {
    expect(readExtensionConfigState().autoAttachProblems).toBe(false);
    mocks.values.set('varro.chat.autoAttachProblems', true);
    expect(readExtensionConfigState().autoAttachProblems).toBe(true);
  });

  it('reads the active-file auto-attachment opt-out', () => {
    mocks.values.set('varro.chat.autoAttachActiveFile', false);
    expect(readExtensionConfigState().autoAttachActiveFile).toBe(false);
  });

  it('prefers the Varro chat font size override', () => {
    mocks.values.set('varro.chat.fontSize', 17);
    mocks.values.set('chat.fontSize', 15);

    expect(readExtensionConfigState().chatFontSize).toBe(17);
  });

  it.each([5, 101, Number.NaN, Number.POSITIVE_INFINITY, '14'])(
    'uses the default for invalid chat.fontSize %s',
    (value) => {
      mocks.values.set('chat.fontSize', value);
      expect(readExtensionConfigState().chatFontSize).toBe(13);
    }
  );

  it.each([6, 100])('accepts the chat.fontSize boundary %s', (value) => {
    mocks.values.set('chat.fontSize', value);
    expect(readExtensionConfigState().chatFontSize).toBe(value);
  });

  it.each([6, 100])('accepts the chat.editor.fontSize boundary %s', (value) => {
    mocks.values.set('chat.editor.fontSize', value);
    expect(readExtensionConfigState().chatEditorFontSize).toBe(value);
  });

  it.each([5, 101, Number.NaN, Number.POSITIVE_INFINITY, '14'])(
    'uses the default for invalid chat.editor.fontSize %s',
    (value) => {
      mocks.values.set('chat.editor.fontSize', value);
      expect(readExtensionConfigState().chatEditorFontSize).toBe(12);
    }
  );

  it.each([null, 5, 101, Number.NaN, Number.POSITIVE_INFINITY, '14'])(
    'inherits chat.fontSize for Varro override %s',
    (value) => {
      mocks.values.set('varro.chat.fontSize', value);
      mocks.values.set('chat.fontSize', 16);
      expect(readExtensionConfigState().chatFontSize).toBe(16);
    }
  );

  it('uses the default for a non-string chat.fontFamily', () => {
    mocks.values.set('chat.fontFamily', 42);
    expect(readExtensionConfigState().chatFontFamily).toBe('default');
  });
});
