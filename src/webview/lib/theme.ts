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

export const FLAT_DARK_CLASS = 'varro-flat-dark';

const FLAT_SURFACE_LUMINANCE_DELTA = 12;

type RgbColor = [number, number, number];

export function parseThemeColor(value: string): RgbColor | null {
  const text = value.trim();
  const hexDigits = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (hexDigits) {
    const digits =
      hexDigits.length <= 4
        ? hexDigits
            .split('')
            .map((char) => char + char)
            .join('')
        : hexDigits;
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16),
    ];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(text);
  const [, r, g, b] = rgb ?? [];
  if (r && g && b) return [Number(r), Number(g), Number(b)];
  return null;
}

function luminance([r, g, b]: RgbColor): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function isFlatDarkSurface(inputBackground: string, sideBarBackground: string): boolean {
  const input = parseThemeColor(inputBackground);
  const sidebar = parseThemeColor(sideBarBackground);
  if (!input || !sidebar) return false;
  return Math.abs(luminance(input) - luminance(sidebar)) < FLAT_SURFACE_LUMINANCE_DELTA;
}

export function syncSurfaceContrastClass(body: HTMLElement = document.body) {
  const styles = getComputedStyle(body);
  const flat =
    body.classList.contains('vscode-dark') &&
    isFlatDarkSurface(
      styles.getPropertyValue('--vscode-input-background'),
      styles.getPropertyValue('--vscode-sideBar-background')
    );
  body.classList.toggle(FLAT_DARK_CLASS, flat);
}

export function observeSurfaceContrast(body: HTMLElement = document.body): () => void {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      syncSurfaceContrastClass(body);
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  observer.observe(body, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(document.head, { childList: true, characterData: true, subtree: true });
  syncSurfaceContrastClass(body);
  return () => observer.disconnect();
}
