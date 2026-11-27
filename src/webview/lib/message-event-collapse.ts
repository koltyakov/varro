import type { Part, ToolPart, ToolStateCompleted } from '../types';
import { isUnresolvedPendingEditPart } from './part-utils';
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
  let start =
    firstPart && getFileEditVisualSignature(firstPart) === previousTrailingSignature ? 1 : 0;
  // A call published before its input usually resolves into the collapsed edit above. Holding
  // it back avoids a placeholder row that would paint and then collapse.
  while (start < parts.length && isUnresolvedPendingEditPart(parts[start]!)) start += 1;
  return start === 0 ? parts : parts.slice(start);
}

/**
 * Applies the leading-event collapse to messages in transcript order, matching the rendered
 * projection. `initialSignature` is the trailing signature before the first entry.
 */
export function collapseLeadingFileEventsInOrder(
  entries: readonly { info: { role: string }; parts: Part[] }[],
  initialSignature: string | null
) {
  const parts: Part[][] = [];
  let previousTrailingSignature = initialSignature;
  for (const entry of entries) {
    if (entry.info.role !== 'assistant') {
      parts.push(entry.parts);
      previousTrailingSignature = null;
      continue;
    }
    parts.push(collapseLeadingDuplicateFileEvents(entry.parts, previousTrailingSignature));
    previousTrailingSignature = getTrailingFileEventSignature(entry.parts);
  }
  return { parts, trailingSignature: previousTrailingSignature };
}

export function getTrailingFileEventSignature(parts: Part[]): string | null {
  for (let index = parts.length - 1; index >= 0; index--) {
    const signature = getFileEditVisualSignature(parts[index]!);
    if (signature) return signature;
    if (parts[index]!.type !== 'step-finish') return null;
  }
  return null;
}
