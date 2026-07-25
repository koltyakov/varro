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

function channelLuminance(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

export function contrastRatio(a: RgbColor, b: RgbColor): number {
  const lumA =
    0.2126 * channelLuminance(a[0]) +
    0.7152 * channelLuminance(a[1]) +
    0.0722 * channelLuminance(a[2]);
  const lumB =
    0.2126 * channelLuminance(b[0]) +
    0.7152 * channelLuminance(b[1]) +
    0.0722 * channelLuminance(b[2]);
  const [hi, lo] = lumA >= lumB ? [lumA, lumB] : [lumB, lumA];
  return (hi + 0.05) / (lo + 0.05);
}

export function mixRgb(a: RgbColor, b: RgbColor, ratio: number): RgbColor {
  return [
    Math.round(a[0] * ratio + b[0] * (1 - ratio)),
    Math.round(a[1] * ratio + b[1] * (1 - ratio)),
    Math.round(a[2] * ratio + b[2] * (1 - ratio)),
  ];
}

function compositeOver(fg: RgbColor, alpha: number, bg: RgbColor): RgbColor {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

function parseThemeColorAlpha(value: string): { color: RgbColor; alpha: number } | null {
  const text = value.trim();
  const hexDigits = /^#([0-9a-f]{4}|[0-9a-f]{8})$/i.exec(text)?.[1];
  if (hexDigits) {
    const digits =
      hexDigits.length === 4
        ? hexDigits
            .split('')
            .map((char) => char + char)
            .join('')
        : hexDigits;
    const color = parseThemeColor(`#${digits.slice(0, 6)}`);
    return color ? { color, alpha: parseInt(digits.slice(6, 8), 16) / 255 } : null;
  }
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/i.exec(text);
  if (rgba) {
    return { color: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], alpha: Number(rgba[4]) };
  }
  const color = parseThemeColor(text);
  return color ? { color, alpha: 1 } : null;
}

const READABLE_TEXT_MIN_CONTRAST = 6;
const READABLE_MUTED_MIN_CONTRAST = 4;

const READABLE_TEXT_PROPS = [
  '--color-vscode-fg',
  '--color-vscode-fg-soft',
  '--color-vscode-fg-muted',
  '--color-vscode-muted',
] as const;

export function readableTextColor(
  fg: RgbColor,
  bg: RgbColor,
  minContrast: number,
  direction: 'lighter' | 'darker'
): RgbColor {
  if (contrastRatio(fg, bg) >= minContrast) return fg;
  const extreme: RgbColor = direction === 'lighter' ? [255, 255, 255] : [0, 0, 0];
  for (let step = 2; step <= 100; step += 2) {
    const mixed = mixRgb(extreme, fg, step / 100);
    if (contrastRatio(mixed, bg) >= minContrast) return mixed;
  }
  return extreme;
}

function setStyleProp(body: HTMLElement, name: string, value: string) {
  if (body.style.getPropertyValue(name) !== value) body.style.setProperty(name, value);
}

function rgbString([r, g, b]: RgbColor): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function clearStyleProp(body: HTMLElement, name: string) {
  if (body.style.getPropertyValue(name)) body.style.removeProperty(name);
}

export function syncReadableTextColors(body: HTMLElement = document.body) {
  const styles = getComputedStyle(body);
  const fg = parseThemeColor(styles.getPropertyValue('--vscode-editor-foreground'));
  const bg = parseThemeColor(styles.getPropertyValue('--vscode-sideBar-background'));
  const clear = () => {
    for (const prop of READABLE_TEXT_PROPS) clearStyleProp(body, prop);
  };
  if (!fg || !bg) {
    clear();
    return;
  }
  const direction =
    body.classList.contains('vscode-light') || body.classList.contains('vscode-high-contrast-light')
      ? 'darker'
      : 'lighter';
  const readable = readableTextColor(fg, bg, READABLE_TEXT_MIN_CONTRAST, direction);
  if (readable === fg) {
    clear();
    return;
  }
  setStyleProp(body, '--color-vscode-fg', rgbString(readable));
  setStyleProp(body, '--color-vscode-fg-soft', rgbString(mixRgb(readable, bg, 0.88)));
  setStyleProp(body, '--color-vscode-fg-muted', rgbString(mixRgb(readable, bg, 0.76)));
  const mutedParsed = parseThemeColorAlpha(
    styles.getPropertyValue('--vscode-descriptionForeground')
  );
  const mutedBase = mutedParsed
    ? compositeOver(mutedParsed.color, mutedParsed.alpha, bg)
    : mixRgb(readable, bg, 0.72);
  setStyleProp(
    body,
    '--color-vscode-muted',
    rgbString(readableTextColor(mutedBase, bg, READABLE_MUTED_MIN_CONTRAST, direction))
  );
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
  const sync = () => {
    syncSurfaceContrastClass(body);
    syncReadableTextColors(body);
  };
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      sync();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  observer.observe(body, { attributes: true, attributeFilter: ['class', 'style'] });
  observer.observe(document.head, { childList: true, characterData: true, subtree: true });
  sync();
  return () => observer.disconnect();
}
