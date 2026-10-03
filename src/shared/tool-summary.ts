import type { ToolState } from './opencode-types';
import { getToolKind, normalizeToolName } from './tool-normalization';
import { isNumber, isString } from './type-utils';

export function parseIntLike<T>(value: T): number | null {
  if (isNumber(value) && Number.isFinite(value)) return Math.trunc(value);
  if (isString(value) && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

export function getSearchResultCount(
  toolName: string,
  state: ToolState
): { count: number; truncated: boolean } | null {
  if (getToolKind(toolName) !== 'search' || state.status !== 'completed') return null;
  const output = state.output || '';
  const truncated =
    state.metadata.truncated === true ||
    /\bmore matches available\b|\bresults (?:are )?truncated\b/i.test(output);
  const metadataCount = parseIntLike(state.metadata.matches) ?? parseIntLike(state.metadata.count);
  if (metadataCount !== null && metadataCount >= 0) return { count: metadataCount, truncated };
  const found = output.match(/^\s*Found\s+(\d+)\s+(?:matches|files|results)\b/im);
  if (found?.[1]) return { count: Number.parseInt(found[1], 10), truncated };
  if (/^\s*No (?:files|matches|search results?) found\b/im.test(output))
    return { count: 0, truncated: false };
  if (normalizeToolName(toolName) !== 'glob') return null;
  const files = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('(Results are truncated'));
  return files.length > 0 ? { count: files.length, truncated } : null;
}
