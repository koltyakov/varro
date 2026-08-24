import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyWebviewTheme,
  BODY_THEME_CLASSES,
  contrastRatio,
  FLAT_DARK_CLASS,
  isFlatDarkSurface,
  mixRgb,
  parseThemeColor,
  readableTextColor,
  syncReadableTextColors,
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

describe('readable text colors', () => {
  const TEXT_PROPS = [
    '--color-vscode-fg',
    '--color-vscode-fg-soft',
    '--color-vscode-fg-muted',
    '--color-vscode-muted',
    '--color-vscode-input-fg',
    '--color-vscode-input-placeholder',
  ];

  beforeEach(() => {
    document.body.removeAttribute('style');
    document.body.className = '';
  });

  function clearTextProps() {
    for (const prop of TEXT_PROPS) document.body.style.removeProperty(prop);
  }

  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 1);
    expect(contrastRatio([100, 100, 100], [100, 100, 100])).toBeCloseTo(1, 5);
    expect(contrastRatio([0x65, 0x7b, 0x83], [0xee, 0xe8, 0xd5])).toBeCloseTo(3.63, 1);
  });

  it('mixes colors by ratio', () => {
    expect(mixRgb([255, 255, 255], [0, 0, 0], 0.5)).toEqual([128, 128, 128]);
    expect(mixRgb([10, 20, 30], [0, 0, 0], 1)).toEqual([10, 20, 30]);
  });

  it('keeps the foreground unchanged when contrast is sufficient', () => {
    const fg: [number, number, number] = [0xd4, 0xd4, 0xd4];
    expect(readableTextColor(fg, [0x25, 0x25, 0x26], 6, 'lighter')).toBe(fg);
  });

  it('blends a dim foreground toward the extreme until it reaches the threshold', () => {
    const abyssFg: [number, number, number] = [0x66, 0x88, 0xcc];
    const abyssBg: [number, number, number] = [0x06, 0x06, 0x21];
    const readable = readableTextColor(abyssFg, abyssBg, 6, 'lighter');
    expect(readable).not.toEqual(abyssFg);
    expect(contrastRatio(readable, abyssBg)).toBeGreaterThanOrEqual(6);
  });

  it('darkens dim foregrounds on light themes', () => {
    const solarFg: [number, number, number] = [0x65, 0x7b, 0x83];
    const solarBg: [number, number, number] = [0xee, 0xe8, 0xd5];
    const readable = readableTextColor(solarFg, solarBg, 6, 'darker');
    expect(contrastRatio(readable, solarBg)).toBeGreaterThanOrEqual(6);
    expect(readable[0]).toBeLessThan(solarFg[0]);
    expect(readable[1]).toBeLessThan(solarFg[1]);
    expect(readable[2]).toBeLessThan(solarFg[2]);
  });

  it('overrides text colors for dim dark themes and keeps the contrast floor', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-editor-foreground', '#6688cc');
    document.body.style.setProperty('--vscode-sideBar-background', '#060621');
    clearTextProps();

    syncReadableTextColors();

    const fg = document.body.style.getPropertyValue('--color-vscode-fg');
    expect(fg).toBeTruthy();
    expect(parseThemeColor(fg)).not.toEqual([0x66, 0x88, 0xcc]);
    const parsed = parseThemeColor(fg);
    expect(parsed && contrastRatio(parsed, [0x06, 0x06, 0x21])).toBeGreaterThanOrEqual(6);
  });

  it('leaves readable themes untouched', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-editor-foreground', '#D4D4D4');
    document.body.style.setProperty('--vscode-sideBar-background', '#252526');
    clearTextProps();

    syncReadableTextColors();

    for (const prop of TEXT_PROPS) {
      expect(document.body.style.getPropertyValue(prop)).toBe('');
    }
  });

  it('darkens text for dim light themes', () => {
    document.body.className = 'vscode-light';
    document.body.style.setProperty('--vscode-editor-foreground', '#657B83');
    document.body.style.setProperty('--vscode-sideBar-background', '#EEE8D5');
    clearTextProps();

    syncReadableTextColors();

    const parsed = parseThemeColor(document.body.style.getPropertyValue('--color-vscode-fg'));
    expect(parsed && contrastRatio(parsed, [0xee, 0xe8, 0xd5])).toBeGreaterThanOrEqual(6);
  });

  it('clears overrides when the theme becomes readable again', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-editor-foreground', '#6688cc');
    document.body.style.setProperty('--vscode-sideBar-background', '#060621');
    clearTextProps();
    syncReadableTextColors();
    expect(document.body.style.getPropertyValue('--color-vscode-fg')).toBeTruthy();

    document.body.style.setProperty('--vscode-editor-foreground', '#D4D4D4');
    syncReadableTextColors();

    for (const prop of TEXT_PROPS) {
      expect(document.body.style.getPropertyValue(prop)).toBe('');
    }
  });

  it('prefers the interactive session foreground over the editor foreground', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-interactive-session-foreground', '#cccccc');
    document.body.style.setProperty('--vscode-editor-foreground', '#555555');
    document.body.style.setProperty('--vscode-sideBar-background', '#252526');

    syncReadableTextColors();

    expect(document.body.style.getPropertyValue('--color-vscode-fg')).toBe('');
  });

  it('repairs muted text independently when primary text is readable', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-sideBar-foreground', '#d4d4d4');
    document.body.style.setProperty('--vscode-descriptionForeground', '#666666');
    document.body.style.setProperty('--vscode-sideBar-background', '#252526');

    syncReadableTextColors();

    const muted = parseThemeColor(document.body.style.getPropertyValue('--color-vscode-muted'));
    expect(muted && contrastRatio(muted, [0x25, 0x25, 0x26])).toBeGreaterThanOrEqual(4.5);
    expect(document.body.style.getPropertyValue('--color-vscode-fg-muted')).toBe(
      document.body.style.getPropertyValue('--color-vscode-muted')
    );
  });

  it('repairs input foreground and placeholder against the input surface', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-sideBar-foreground', '#d4d4d4');
    document.body.style.setProperty('--vscode-sideBar-background', '#252526');
    document.body.style.setProperty('--vscode-input-background', '#3c3c3c');
    document.body.style.setProperty('--vscode-input-foreground', '#777777');
    document.body.style.setProperty('--vscode-input-placeholderForeground', '#747474');

    syncReadableTextColors();

    const input = parseThemeColor(document.body.style.getPropertyValue('--color-vscode-input-fg'));
    const placeholder = parseThemeColor(
      document.body.style.getPropertyValue('--color-vscode-input-placeholder')
    );
    expect(input && contrastRatio(input, [0x3c, 0x3c, 0x3c])).toBeGreaterThanOrEqual(6);
    expect(placeholder && contrastRatio(placeholder, [0x3c, 0x3c, 0x3c])).toBeGreaterThanOrEqual(
      4.5
    );
  });

  it('repairs a light input surface independently of a dark theme', () => {
    document.body.className = 'vscode-dark';
    document.body.style.setProperty('--vscode-sideBar-foreground', '#d4d4d4');
    document.body.style.setProperty('--vscode-sideBar-background', '#252526');
    document.body.style.setProperty('--vscode-input-background', '#eeeeee');
    document.body.style.setProperty('--vscode-input-foreground', '#777777');
    document.body.style.setProperty('--vscode-input-placeholderForeground', '#777777');

    syncReadableTextColors();

    const input = parseThemeColor(document.body.style.getPropertyValue('--color-vscode-input-fg'));
    const placeholder = parseThemeColor(
      document.body.style.getPropertyValue('--color-vscode-input-placeholder')
    );
    expect(input && contrastRatio(input, [0xee, 0xee, 0xee])).toBeGreaterThanOrEqual(6);
    expect(placeholder && contrastRatio(placeholder, [0xee, 0xee, 0xee])).toBeGreaterThanOrEqual(
      4.5
    );
  });
});
