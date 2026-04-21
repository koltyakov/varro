import { describe, expect, it } from 'vitest';
import { applyWebviewTheme, BODY_THEME_CLASSES, themeClassName } from './theme';

describe('webview theme helpers', () => {
  it('maps every theme kind to the expected VS Code body class', () => {
    expect(themeClassName('light')).toBe('vscode-light');
    expect(themeClassName('dark')).toBe('vscode-dark');
    expect(themeClassName('high-contrast')).toBe('vscode-high-contrast');
    expect(themeClassName('high-contrast-light')).toBe('vscode-high-contrast-light');
  });

  it('replaces previous theme classes and sets the body dataset', () => {
    document.body.className = BODY_THEME_CLASSES.join(' ');
    document.body.dataset.vscodeThemeKind = 'dark';

    applyWebviewTheme('high-contrast-light');

    expect(document.body.classList.contains('vscode-high-contrast-light')).toBe(true);
    expect(document.body.classList.contains('vscode-dark')).toBe(false);
    expect(document.body.classList.contains('vscode-light')).toBe(false);
    expect(document.body.classList.contains('vscode-high-contrast')).toBe(false);
    expect(document.body.dataset.vscodeThemeKind).toBe('high-contrast-light');
  });

  it('can target a provided element instead of document.body', () => {
    const el = document.createElement('div');
    el.className = 'vscode-dark custom';

    applyWebviewTheme('light', el);

    expect(el.classList.contains('custom')).toBe(true);
    expect(el.classList.contains('vscode-light')).toBe(true);
    expect(el.classList.contains('vscode-dark')).toBe(false);
    expect(el.dataset.vscodeThemeKind).toBe('light');
  });
});
