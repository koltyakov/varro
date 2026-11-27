import { isAbortedToolError } from '../../shared/error-classification';
import type { Part, ToolPart } from '../types';
import { getToolFileChange, getToolReadPath } from './tool-file-change';
import { showThinking } from './state';
import {
  getToolKind,
  isApplyPatchTool,
  isTodoToolName,
  isTodoToolTitle,
} from './tool-normalization';

export function isWorkspaceDirectoryText(text: string) {
  return text.startsWith('[Working directory:');
}

export function hasVisibleReasoningContent(text: string) {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim().length > 0;
}

export function hasExpandableReasoningContent(text: string) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let firstContentLine = 0;
  while (firstContentLine < lines.length && !lines[firstContentLine]!.trim()) {
    firstContentLine += 1;
  }

  const hasSubject = /^\*\*(.+?)\*\*$/.test(lines[firstContentLine]?.trim() ?? '');
  const body = hasSubject ? lines.slice(firstContentLine + 1).join('\n') : text;
  return hasVisibleReasoningContent(body);
}

export function shouldShowAssistantPartInHighlightedCard(part: Part) {
  if (part.type === 'reasoning') return hasVisibleReasoningContent(part.text);
  if (part.type === 'text') {
    return part.text.trim().length > 0 && !isWorkspaceDirectoryText(part.text);
  }
  return shouldShowAssistantPartInline(part);
}

export function isFileEditPart(part: Part): boolean {
  if (part.type !== 'tool') return false;
  // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
  return getToolFileChange((part as ToolPart).tool, (part as ToolPart).state) !== null;
}

/** A pending edit call whose input has not identified its file yet. */
export function isUnresolvedPendingEditPart(part: Part) {
  return (
    part.type === 'tool' &&
    part.state.status === 'pending' &&
    getToolKind(part.tool) === 'edit' &&
    !isFileEditPart(part)
  );
}

/**
 * Providers that do not stream tool input (such as the Claude agent) still publish an empty
 * pending call before its input. Directly after a file edit, that call usually resolves into
 * the same card, so a standalone placeholder would paint and collapse a frame later.
 */
export function isPendingEditAwaitingMerge(parts: readonly Part[], index: number): boolean {
  if (!isUnresolvedPendingEditPart(parts[index]!)) return false;
  let previous = index - 1;
  while (previous >= 0 && isUnresolvedPendingEditPart(parts[previous]!)) previous -= 1;
  return previous >= 0 && isFileEditPart(parts[previous]!);
}

export function isFileReadPart(part: Part): boolean {
  if (part.type !== 'tool') return false;
  // SAFETY: The surrounding shape or discriminator check establishes the ToolPart contract used below.
  return getToolReadPath((part as ToolPart).tool, (part as ToolPart).state) !== null;
}

export function isTodoToolPart(part: Extract<Part, { type: 'tool' }>) {
  if (isTodoToolName(part.tool)) return true;

  const title =
    (part.state.status === 'running' || part.state.status === 'completed'
      ? part.state.title
      : undefined) || '';
  return isTodoToolTitle(title);
}

export function shouldShowAssistantPartInline(part: Part, respectThinkingToggle = true) {
  if (part.type === 'tool') {
    if (isTodoToolPart(part)) return false;
    if (isApplyPatchTool(part.tool) && isAbortedToolError(part.state) && !isFileEditPart(part)) {
      return false;
    }
    return true;
  }

  switch (part.type) {
    case 'text':
      return part.text.trim().length > 0;
    case 'reasoning':
      return respectThinkingToggle ? showThinking() && hasVisibleReasoningContent(part.text) : true;
    case 'agent':
    case 'retry':
    case 'compaction':
    case 'subtask':
    case 'file':
      return true;
    default:
      return false;
  }
}

export function getFinalAssistantTextPartId(
  parts: Part[],
  isCompleted: boolean,
  textForPart?: (part: Part) => string | null
): string | null {
  if (!isCompleted) return null;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    const effectiveText = textForPart?.(part);
    const effectivePart =
      effectiveText !== null &&
      effectiveText !== undefined &&
      (part.type === 'text' || part.type === 'reasoning')
        ? { ...part, text: effectiveText }
        : part;
    if (!shouldShowAssistantPartInline(effectivePart, false)) continue;
    if (part.type !== 'text') return null;
    return part.id;
  }

  return null;
}
