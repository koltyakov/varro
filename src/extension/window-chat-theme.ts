/* oxlint-disable anti-slop/no-runtime-typeof -- Parse installed JSONC theme files at the filesystem boundary. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import * as vscode from 'vscode';
import type { WebviewThemeKind, WindowChatTheme } from '../shared/protocol';
import { logger } from './logger';

const PAIRS = [
  ['Light 2026', 'Dark 2026', '2026-light.json', '2026-dark.json'],
  ['Light Modern', 'Dark Modern', 'light_modern.json', 'dark_modern.json'],
  ['Light+', 'Dark+', 'light_plus.json', 'dark_plus.json'],
  ['Visual Studio Light', 'Visual Studio Dark', 'light_vs.json', 'dark_vs.json'],
  ['Default High Contrast Light', 'Default High Contrast', 'hc_light.json', 'hc_black.json'],
] as const;

function readColors(path: string, seen = new Set<string>()): Record<string, string> {
  if (seen.has(path)) throw new Error(`Circular theme include: ${path}`);
  seen.add(path);
  const errors: ParseError[] = [];
  const data: unknown = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== 'object') {
    throw new Error(`Invalid theme file: ${path}`);
  }
  const colors =
    'include' in data && typeof data.include === 'string'
      ? readColors(join(dirname(path), data.include), seen)
      : {};
  if ('colors' in data && data.colors && typeof data.colors === 'object') {
    for (const [key, value] of Object.entries(data.colors)) {
      if (typeof value === 'string') colors[key] = value;
      else if (value === null) delete colors[key];
    }
  }
  return colors;
}

const cache = new Map<string, NonNullable<WindowChatTheme['counterpart']>>();

export function readWindowChatTheme(): WindowChatTheme {
  const source = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme', '');
  const pair = PAIRS.find(([light, dark]) => source === light || source === dark);
  if (!pair) return { source, counterpart: null };
  const toLight = source === pair[1];
  const name = pair[toLight ? 0 : 1];
  const kind: WebviewThemeKind =
    pair[0] === 'Default High Contrast Light'
      ? toLight
        ? 'high-contrast-light'
        : 'high-contrast'
      : toLight
        ? 'light'
        : 'dark';
  const cached = cache.get(name);
  if (cached) return { source, counterpart: cached };
  try {
    const colors = readColors(
      join(vscode.env.appRoot, 'extensions/theme-defaults/themes', pair[toLight ? 2 : 3])
    );
    const counterpart = { name, kind, colors };
    cache.set(name, counterpart);
    return { source, counterpart };
  } catch (error) {
    logger.warn(
      `Cannot load paired chat theme ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
    return { source, counterpart: null };
  }
}
