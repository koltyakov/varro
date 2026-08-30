/* oxlint-disable anti-slop/no-module-mocking, anti-slop/no-unknown-parameters -- These tests provide VS Code configuration boundary values. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  return {
    values,
    getConfiguration: vi.fn((section: string) => ({
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

import { readExtensionConfigState, readSessionHistoryScope } from './extension-config';

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
      chatFontSize: 13,
      chatEditorFontSize: 12,
      chatFontFamily: 'default',
    });
  });

  it('reads the expand-thinking setting', () => {
    mocks.values.set('varro.chat.expandThinking', true);

    expect(readExtensionConfigState().expandThinking).toBe(true);
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

describe('readSessionHistoryScope', () => {
  beforeEach(() => {
    mocks.values.clear();
    vi.clearAllMocks();
  });

  it.each(['directory', 'descendants', 'project'] as const)('reads %s scope', (scope) => {
    mocks.values.set('varro.chat.sessionHistoryScope', scope);
    expect(readSessionHistoryScope()).toBe(scope);
  });

  it.each([undefined, null, '', 'workspace', 1])(
    'defaults invalid value %s to directory',
    (value) => {
      mocks.values.set('varro.chat.sessionHistoryScope', value);
      expect(readSessionHistoryScope()).toBe('directory');
    }
  );

  it('reads the setting for a specific workspace folder resource', () => {
    // SAFETY: The reader only forwards this controlled URI-shaped test value to the VS Code mock.
    const resource = { fsPath: '/repo-b' } as never;
    mocks.values.set('varro.chat.sessionHistoryScope', 'project');

    expect(readSessionHistoryScope(resource)).toBe('project');
    expect(mocks.getConfiguration).toHaveBeenCalledWith('varro', resource);
  });
});
