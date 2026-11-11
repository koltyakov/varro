/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- These tests provide VS Code configuration boundary values. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    getConfiguration: vi.fn((section: string) => ({
      inspect: vi.fn((key: string) => ({ globalValue: values.get(`${section}.${key}`) })),
      get: vi.fn((key: string, fallback?: unknown) => {
        const fullKey = `${section}.${key}`;
        return values.has(fullKey) ? values.get(fullKey) : fallback;
      }),
    })),
  };
});

vi.mock('vscode', () => ({
  workspace: { getConfiguration: mocks.getConfiguration },
}));

import { readExtensionConfigState, readPromptTrace } from './extension-config';

describe('readExtensionConfigState', () => {
  beforeEach(() => {
    mocks.values.clear();
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
      showEmptyStateHistogram: false,
      followupsEnabled: true,
      debugShowQuotaWarning: false,
      debugResetWarningDays: 5,
      autoAttachProblems: true,
      autoAttachActiveFile: true,
      chatFontSize: 13,
      chatEditorFontSize: 12,
      chatFontFamily: 'default',
    });
  });

  it('reads the expand-thinking setting', () => {
    mocks.values.set('varro.chat.expandThinking', true);

    expect(readExtensionConfigState().expandThinking).toBe(true);
  });

  it('reads the turn-timer setting', () => {
    mocks.values.set('varro.chat.showTurnTimer', false);

    expect(readExtensionConfigState().showTurnTimer).toBe(false);
  });

  it('reads the empty-state histogram opt-in', () => {
    mocks.values.set('varro.chat.showEmptyStateHistogram', true);

    expect(readExtensionConfigState().showEmptyStateHistogram).toBe(true);
  });

  it('defaults follow-ups to enabled and respects a user-level opt-out', () => {
    expect(readExtensionConfigState().followupsEnabled).toBe(true);
    mocks.values.set('varro.chat.followupsEnabled', false);
    expect(readExtensionConfigState().followupsEnabled).toBe(false);
    mocks.values.set('varro.chat.followupsEnabled', true);
    expect(readExtensionConfigState().followupsEnabled).toBe(true);
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
    mocks.values.set('varro.chat.followupModel', 'openai/fast');
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
      mocks.values.set('varro.chat.promptTrace', value);
      expect(readPromptTrace()).toBe(false);
    }
    mocks.values.set('varro.chat.promptTrace', true);
    expect(readPromptTrace()).toBe(true);
  });

  it('does not let repository settings enable prompt tracing', () => {
    mocks.getConfiguration.mockReturnValueOnce({
      get: vi.fn(() => true),
      inspect: vi.fn(() => ({ globalValue: undefined })),
    });
    expect(readPromptTrace()).toBe(false);
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

  it('reads the Problems context opt-out', () => {
    mocks.values.set('varro.chat.autoAttachProblems', false);
    expect(readExtensionConfigState().autoAttachProblems).toBe(false);
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
