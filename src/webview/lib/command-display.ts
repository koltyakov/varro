import { isSamePath, normalizePath } from './path-display';

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, '');
}

function unquote(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function shouldStripWorkspacePrefix(path: string, workspacePath: string | null | undefined) {
  const normalizedPath = trimTrailingSlashes(normalizePath(unquote(path).trim()));
  if (!normalizedPath) return false;
  if (normalizedPath === '/project/path') return true;
  if (!workspacePath) return false;
  return isSamePath(normalizedPath, trimTrailingSlashes(normalizePath(workspacePath)));
}

const REDUNDANT_CD_PREFIX_RE = /^(\s*)cd\s+("[^"]+"|'[^']+'|\S+)\s*&&\s*/;

export function stripRedundantWorkspaceCdPrefix(
  value: string,
  workspacePath: string | null | undefined
) {
  return value
    .split('\n')
    .map((line) => {
      const match = line.match(REDUNDANT_CD_PREFIX_RE);
      if (!match) return line;
      if (!shouldStripWorkspacePrefix(match[2], workspacePath)) return line;
      return `${match[1]}${line.slice(match[0].length)}`;
    })
    .join('\n');
}

export function formatCommandDisplay(value: string, workspacePath: string | null | undefined) {
  return stripRedundantWorkspaceCdPrefix(value, workspacePath);
}
