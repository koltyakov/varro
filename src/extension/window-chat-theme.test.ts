/* oxlint-disable anti-slop/no-module-mocking -- VS Code and its installed theme files are host boundaries unavailable in unit tests. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
const mocks = vi.hoisted(() => ({ source: 'Dark Modern', readFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    readFileSync: mocks.readFileSync,
    default: { ...fs, readFileSync: mocks.readFileSync },
  };
});
vi.mock('vscode', () => ({
  workspace: { getConfiguration: () => ({ get: () => mocks.source }) },
  env: { appRoot: '/vscode' },
}));
vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));
import { readWindowChatTheme } from './window-chat-theme';

beforeEach(() => {
  mocks.readFileSync.mockReset();
  mocks.readFileSync.mockReturnValue('{"colors":{"editor.background":"#ffffff"}}');
});

describe('paired window themes', () => {
  it.each([
    ['Dark 2026', 'Light 2026', 'light'],
    ['Light 2026', 'Dark 2026', 'dark'],
    ['Dark Modern', 'Light Modern', 'light'],
    ['Light Modern', 'Dark Modern', 'dark'],
    ['Dark+', 'Light+', 'light'],
    ['Light+', 'Dark+', 'dark'],
    ['Visual Studio Dark', 'Visual Studio Light', 'light'],
    ['Visual Studio Light', 'Visual Studio Dark', 'dark'],
    ['Default High Contrast', 'Default High Contrast Light', 'high-contrast-light'],
    ['Default High Contrast Light', 'Default High Contrast', 'high-contrast'],
  ])('pairs %s only with %s', (source, name, kind) => {
    mocks.source = source;
    expect(readWindowChatTheme()).toEqual({
      source,
      counterpart: {
        name,
        kind,
        colors: { 'editor.background': '#ffffff' },
      },
    });
  });

  it('leaves unpaired themes unavailable without reading a substitute', () => {
    mocks.source = 'Monokai';
    expect(readWindowChatTheme()).toEqual({ source: 'Monokai', counterpart: null });
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });
});
