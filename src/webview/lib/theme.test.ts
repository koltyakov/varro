import { describe, expect, it } from 'vitest';
import {
  applyWebviewTheme,
  BODY_THEME_CLASSES,
  FLAT_DARK_CLASS,
  isFlatDarkSurface,
  parseThemeColor,
  syncSurfaceContrastClass,
  themeClassName,
} from './theme';

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

describe('surface contrast detection', () => {
  it('parses hex colors in 3, 4, 6 and 8 digit forms', () => {
    expect(parseThemeColor('#fff')).toEqual([255, 255, 255]);
    expect(parseThemeColor('#fff0')).toEqual([255, 255, 255]);
    expect(parseThemeColor('#191A1B')).toEqual([25, 26, 27]);
    expect(parseThemeColor('#2a2b2cff')).toEqual([42, 43, 44]);
  });

  it('parses rgb() colors and rejects empty or unknown values', () => {
    expect(parseThemeColor('rgb(49, 49, 49)')).toEqual([49, 49, 49]);
    expect(parseThemeColor('rgba(49, 49, 49, 0.5)')).toEqual([49, 49, 49]);
    expect(parseThemeColor('')).toBeNull();
    expect(parseThemeColor('  ')).toBeNull();
    expect(parseThemeColor('not-a-color')).toBeNull();
  });

  it('treats Dark 2026 inputs as flat and Dark Modern inputs as raised', () => {
    expect(isFlatDarkSurface('#191A1B', '#191A1B')).toBe(true);
    expect(isFlatDarkSurface('#313131', '#181818')).toBe(false);
    expect(isFlatDarkSurface('#3C3C3C', '#181818')).toBe(false);
  });

  it('rejects unparseable colors', () => {
    expect(isFlatDarkSurface('', '#191A1B')).toBe(false);
    expect(isFlatDarkSurface('#191A1B', '')).toBe(false);
  });

  it('adds the flat-dark class only for dark themes with flat input surfaces', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-input-background', '#191A1B');
    document.body.style.setProperty('--vscode-sideBar-background', '#191A1B');

    syncSurfaceContrastClass();

    expect(document.body.classList.contains(FLAT_DARK_CLASS)).toBe(true);
  });

  it('removes the flat-dark class when inputs are raised or the theme is not dark', () => {
    document.body.className = `vscode-dark ${FLAT_DARK_CLASS}`;
    document.body.style.setProperty('--vscode-input-background', '#313131');
    document.body.style.setProperty('--vscode-sideBar-background', '#181818');

    syncSurfaceContrastClass();
    expect(document.body.classList.contains(FLAT_DARK_CLASS)).toBe(false);

    document.body.className = `vscode-light ${FLAT_DARK_CLASS}`;
    document.body.style.setProperty('--vscode-input-background', '#191A1B');
    document.body.style.setProperty('--vscode-sideBar-background', '#191A1B');

    syncSurfaceContrastClass();
    expect(document.body.classList.contains(FLAT_DARK_CLASS)).toBe(false);
  });
});
