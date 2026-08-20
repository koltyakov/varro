import type { Part, ToolPart, ToolStateCompleted } from '../types';
import { getToolFileChangeSignature } from './tool-file-change';
import { isNumber } from './runtime-values';

function getDiffStatsSignature(part: ToolPart): string {
  if (part.state.status !== 'completed') return '';
  // SAFETY: The surrounding shape or discriminator check establishes the ToolStateCompleted contract used below.
  const metadata = (part.state as ToolStateCompleted).metadata || {};
  const additions =
    // SAFETY: The surrounding shape or discriminator check establishes the number contract used below.
    // SAFETY: The surrounding shape or discriminator check establishes the number contract used below.
    isNumber(metadata.additions)
      ? (metadata.additions as number)
      : isNumber(metadata.linesAdded)
        ? (metadata.linesAdded as number)
        : null;
  const deletions =
    // SAFETY: The surrounding shape or discriminator check establishes the number contract used below.
    // SAFETY: The surrounding shape or discriminator check establishes the number contract used below.
    isNumber(metadata.deletions)
      ? (metadata.deletions as number)
      : isNumber(metadata.linesRemoved)
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
