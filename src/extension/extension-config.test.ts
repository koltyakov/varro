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

import { readExtensionConfigState } from './extension-config';

describe('readExtensionConfigState', () => {
  beforeEach(() => {
    mocks.values.clear();
    vi.clearAllMocks();
  });

  it('reads built-in VS Code chat font settings', () => {
    mocks.values.set('chat.fontSize', 15.5);
    mocks.values.set('chat.fontFamily', 'Iosevka, monospace');

    expect(readExtensionConfigState()).toMatchObject({
      chatFontSize: 15.5,
      chatFontFamily: 'Iosevka, monospace',
    });
  });

  it('keeps the current chat typography defaults when settings are absent', () => {
    expect(readExtensionConfigState()).toMatchObject({
      chatFontSize: 13,
      chatFontFamily: 'default',
    });
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

  it('uses the default for a non-string chat.fontFamily', () => {
    mocks.values.set('chat.fontFamily', 42);
    expect(readExtensionConfigState().chatFontFamily).toBe('default');
  });
});
