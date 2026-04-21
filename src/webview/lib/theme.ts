import type { WebviewThemeKind } from '../../shared/protocol';

export const BODY_THEME_CLASSES = [
  'vscode-light',
  'vscode-dark',
  'vscode-high-contrast',
  'vscode-high-contrast-light',
] as const;

export function themeClassName(theme: WebviewThemeKind): (typeof BODY_THEME_CLASSES)[number] {
  switch (theme) {
    case 'light':
      return 'vscode-light';
    case 'dark':
      return 'vscode-dark';
    case 'high-contrast':
      return 'vscode-high-contrast';
    case 'high-contrast-light':
      return 'vscode-high-contrast-light';
  }
}

export function applyWebviewTheme(theme: WebviewThemeKind, body: HTMLElement = document.body) {
  body.classList.remove(...BODY_THEME_CLASSES);
  body.classList.add(themeClassName(theme));
  body.dataset.vscodeThemeKind = theme;
}
