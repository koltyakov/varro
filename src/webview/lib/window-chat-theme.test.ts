import { afterEach, describe, expect, it } from 'vitest';
import type { WindowChatTheme } from '../../shared/protocol';
import { theme } from './state';
import { applyWebviewTheme } from './theme';
import {
  syncWindowChatTheme,
  toggleWindowChatTheme,
  windowChatTheme,
  windowChatThemeReversed,
} from './window-chat-theme';

const pair: WindowChatTheme = {
  source: 'Dark Modern',
  counterpart: { name: 'Light Modern', kind: 'light', colors: { 'editor.background': '#ffffff' } },
};

afterEach(() => {
  syncWindowChatTheme({ theme: 'dark' });
  applyWebviewTheme('dark');
});

describe('window chat theme', () => {
  it('reverses from a newly selected light host theme to its dark counterpart', () => {
    syncWindowChatTheme({ theme: 'dark', windowChatTheme: pair });
    toggleWindowChatTheme();
    // The kind notification may arrive before the new name is available.
    expect(syncWindowChatTheme({ theme: 'light', windowChatTheme: pair })).toBe('light');
    expect(windowChatThemeReversed()).toBe(true);
    expect(
      syncWindowChatTheme({
        theme: 'light',
        windowChatTheme: {
          source: 'Light Modern',
          counterpart: {
            name: 'Dark Modern',
            kind: 'dark',
            colors: { 'editor.background': '#1f1f1f' },
          },
        },
      })
    ).toBe('dark');
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background')
    ).toBe('#1f1f1f');
    toggleWindowChatTheme();
    expect(theme()).toBe('light');
  });

  it('overrides only the local document and restores the host palette on the second click', () => {
    const sibling = document.implementation.createHTMLDocument();
    sibling.body.className = 'vscode-dark';
    const hostStyle = document.createElement('style');
    hostStyle.textContent = ':root { --vscode-editor-background: #181818; }';
    document.head.append(hostStyle);
    syncWindowChatTheme({ theme: 'dark', windowChatTheme: pair });
    toggleWindowChatTheme();
    expect(theme()).toBe('light');
    expect(document.body.classList.contains('vscode-light')).toBe(true);
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background')
    ).toBe('#ffffff');
    expect(sibling.body.className).toBe('vscode-dark');
    toggleWindowChatTheme();
    expect(theme()).toBe('dark');
    expect(windowChatThemeReversed()).toBe(false);
    expect(
      getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background')
    ).toBe('#181818');
    hostStyle.remove();
  });

  it('preserves the local override across host resyncs and class replacement', async () => {
    syncWindowChatTheme({ theme: 'dark', windowChatTheme: pair });
    toggleWindowChatTheme();
    expect(syncWindowChatTheme({ theme: 'dark', windowChatTheme: pair })).toBe('light');
    applyWebviewTheme('dark');
    await Promise.resolve();
    expect(document.body.classList.contains('vscode-light')).toBe(true);
    expect(windowChatThemeReversed()).toBe(true);
  });

  it('keeps the reverse preference while an unpaired theme temporarily disables the override', () => {
    syncWindowChatTheme({ theme: 'dark', windowChatTheme: pair });
    toggleWindowChatTheme();
    expect(
      syncWindowChatTheme({
        theme: 'dark',
        windowChatTheme: { source: 'Monokai', counterpart: null },
      })
    ).toBe('dark');
    expect(windowChatThemeReversed()).toBe(true);
    toggleWindowChatTheme();
    expect(windowChatThemeReversed()).toBe(true);
  });

  it('offers no override in a regular chat', () => {
    syncWindowChatTheme({ theme: 'dark' });
    toggleWindowChatTheme();
    expect(windowChatTheme()).toBeUndefined();
    expect(windowChatThemeReversed()).toBe(false);
  });

  it.each([true, false])(
    'restores reverse=%s against the current theme rather than an old theme name',
    (reversed) => {
      const kind = syncWindowChatTheme({
        theme: 'light',
        windowChatTheme: {
          source: 'Light+',
          reversed,
          counterpart: { name: 'Dark+', kind: 'dark', colors: { 'editor.background': '#1e1e1e' } },
        },
      });
      expect(kind).toBe(reversed ? 'dark' : 'light');
      expect(windowChatThemeReversed()).toBe(reversed);
      syncWindowChatTheme({ theme: 'light' });
      expect(windowChatTheme()).toBeUndefined();
      expect(windowChatThemeReversed()).toBe(false);
    }
  );

  it('keeps high contrast paired with high contrast', () => {
    syncWindowChatTheme({
      theme: 'high-contrast',
      windowChatTheme: {
        source: 'Default High Contrast',
        counterpart: {
          name: 'Default High Contrast Light',
          kind: 'high-contrast-light',
          colors: {},
        },
      },
    });
    toggleWindowChatTheme();
    expect(theme()).toBe('high-contrast-light');
    expect(document.body.classList.contains('vscode-high-contrast-light')).toBe(true);
    toggleWindowChatTheme();
    expect(theme()).toBe('high-contrast');
  });
});
