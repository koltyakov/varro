/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type -- Path aliases rewrite raw OpenCode JSON before endpoint-specific consumers validate it. */
import { realpathSync } from 'node:fs';

type PathAlias = { logical: string; physical: string };

const DIRECTORY_QUERY_KEYS = ['directory', 'location[directory]'];
const MAX_RESOLVED_DIRECTORIES = 256;

/**
 * Terminal OpenCode clients scope work to the physical working directory, while VS Code
 * keeps the symlinked spelling of a workspace. Send OpenCode physical directories so both
 * share one session history, and restore the editor spelling in everything OpenCode returns.
 */
export class OpenCodePathAliases {
  private readonly physicalDirectories = new Map<string, string | null>();
  private aliases: PathAlias[] = [];

  constructor(private readonly isEnabled: () => boolean = () => true) {}

  toServerDirectory(directory: string): string;
  toServerDirectory(directory: string | undefined): string | undefined;
  toServerDirectory(directory: string | undefined) {
    if (!directory || !this.enabled()) return directory;
    const root = trimTrailingSeparators(directory);
    if (!root.startsWith('/')) return directory;
    let physical = this.physicalDirectories.get(root);
    if (physical === undefined) {
      physical = resolvePhysicalDirectory(root);
      if (this.physicalDirectories.size >= MAX_RESOLVED_DIRECTORIES) {
        this.physicalDirectories.clear();
      }
      this.physicalDirectories.set(root, physical);
      if (physical && physical !== root) this.addAlias({ logical: root, physical });
    }
    // A missing directory can still sit below a known symlinked root.
    return physical ?? this.replaceRoot(directory, true);
  }

  toServerRequestPath(path: string): string {
    if (!this.enabled()) return path;
    const url = new URL(path, 'http://localhost');
    let changed = false;
    for (const key of DIRECTORY_QUERY_KEYS) {
      const directory = url.searchParams.get(key);
      if (!directory) continue;
      const physical = this.toServerDirectory(directory);
      if (physical === directory) continue;
      url.searchParams.set(key, physical);
      changed = true;
    }
    return changed ? `${url.pathname}${url.search}` : path;
  }

  toServer(value: unknown): unknown {
    if (!this.enabled()) return value;
    return mapStrings(value, (text, key) =>
      key === 'directory' ? this.toServerDirectory(text) : this.replaceRoot(text, true)
    );
  }

  fromServer(value: unknown): unknown {
    if (this.aliases.length === 0 || !this.enabled()) return value;
    return mapStrings(value, (text) => this.replaceRoot(text, false));
  }

  private enabled() {
    return process.platform !== 'win32' && this.isEnabled();
  }

  private addAlias(alias: PathAlias) {
    if (this.aliases.some((item) => item.logical === alias.logical)) return;
    this.aliases = [...this.aliases, alias];
  }

  private replaceRoot(text: string, toServer: boolean): string {
    // Only whole path values; multi-line text such as tool output is left as reported.
    if (this.aliases.length === 0 || !text.startsWith('/') || text.includes('\n')) return text;
    let match: PathAlias | undefined;
    let matchLength = 0;
    for (const alias of this.aliases) {
      const from = toServer ? alias.logical : alias.physical;
      if (from.length <= matchLength) continue;
      if (text === from || text.startsWith(`${from}/`)) {
        match = alias;
        matchLength = from.length;
      }
    }
    if (!match) return text;
    return (toServer ? match.physical : match.logical) + text.slice(matchLength);
  }
}

function resolvePhysicalDirectory(directory: string): string | null {
  try {
    return realpathSync(directory);
  } catch {
    // Missing or unreadable directories keep their requested spelling.
    return null;
  }
}

function trimTrailingSeparators(path: string) {
  return path.replace(/\/+$/, '') || path;
}

function mapStrings(
  value: unknown,
  map: (text: string, key: string | undefined) => string,
  key?: string
): unknown {
  if (typeof value === 'string') return map(value, key);
  if (Array.isArray(value)) {
    let mapped: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      const next = mapStrings(item, map);
      if (next === item) continue;
      mapped ??= [...value];
      mapped[index] = next;
    }
    return mapped ?? value;
  }
  if (!value || typeof value !== 'object') return value;
  let mapped: Record<string, unknown> | undefined;
  for (const [name, item] of Object.entries(value)) {
    const next = mapStrings(item, map, name);
    if (next === item) continue;
    mapped ??= { ...value };
    mapped[name] = next;
  }
  return mapped ?? value;
}
