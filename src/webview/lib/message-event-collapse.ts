import type { Part, ToolPart, ToolStateCompleted } from '../types';
import { getToolFileChangeSignature } from './tool-file-change';

function getDiffStatsSignature(part: ToolPart): string {
  if (part.state.status !== 'completed') return '';
  const metadata = (part.state as ToolStateCompleted).metadata || {};
  const additions =
    typeof metadata.additions === 'number'
      ? (metadata.additions as number)
      : typeof metadata.linesAdded === 'number'
        ? (metadata.linesAdded as number)
        : null;
  const deletions =
    typeof metadata.deletions === 'number'
      ? (metadata.deletions as number)
      : typeof metadata.linesRemoved === 'number'
        ? (metadata.linesRemoved as number)
        : null;

  if (additions === null && deletions === null) return '';
  return `:${additions || 0},${deletions || 0}`;
}

export function getFileEditVisualSignature(part: Part): string | null {
  if (part.type !== 'tool') return null;
  const signature = getToolFileChangeSignature(part.tool, part.state);
  if (!signature) return null;
  return `${signature}${getDiffStatsSignature(part)}`;
}

export function collapseLeadingDuplicateFileEvents(
  parts: Part[],
  previousTrailingSignature: string | null
): Part[] {
  if (!previousTrailingSignature) return parts;
  const firstPart = parts[0];
  if (!firstPart || getFileEditVisualSignature(firstPart) !== previousTrailingSignature)
    return parts;
  return parts.slice(1);
}

export function getTrailingFileEventSignature(parts: Part[]): string | null {
  for (let index = parts.length - 1; index >= 0; index--) {
    const signature = getFileEditVisualSignature(parts[index]!);
    if (signature) return signature;
    if (parts[index]!.type !== 'step-finish') return null;
  }
  return null;
}
