import type { Part, ToolPart } from '../types';
import { getToolFileChange, getToolReadPath } from './tool-file-change';
import { showThinking } from './state';

export function isWorkspaceDirectoryText(text: string) {
  return text.startsWith('[Working directory:');
}

export function shouldShowAssistantPartInHighlightedCard(part: Part) {
  if (part.type === 'reasoning') return part.text.trim().length > 0;
  if (part.type === 'text') {
    return part.text.trim().length > 0 && !isWorkspaceDirectoryText(part.text);
  }
  return shouldShowAssistantPartInline(part);
}

export function isFileEditPart(part: Part): boolean {
  if (part.type !== 'tool') return false;
  return getToolFileChange((part as ToolPart).tool, (part as ToolPart).state) !== null;
}

export function isFileReadPart(part: Part): boolean {
  if (part.type !== 'tool') return false;
  return getToolReadPath((part as ToolPart).tool, (part as ToolPart).state) !== null;
}

export function isTodoToolPart(part: Extract<Part, { type: 'tool' }>) {
  const toolName = part.tool.trim().toLowerCase();
  if (
    toolName.includes('todo') ||
    toolName === 'update_plan' ||
    toolName === 'updateplan' ||
    toolName === 'todowrite'
  ) {
    return true;
  }

  const title =
    (part.state.status === 'running' || part.state.status === 'completed'
      ? part.state.title
      : undefined) || '';
  const normalizedTitle = title.trim().toLowerCase();
  return (
    normalizedTitle.includes('todo') ||
    normalizedTitle === 'update plan' ||
    normalizedTitle === 'updating plan'
  );
}

export function shouldShowAssistantPartInline(part: Part, respectThinkingToggle = true) {
  if (part.type === 'tool') return !isTodoToolPart(part);

  switch (part.type) {
    case 'text':
      return part.text.trim().length > 0;
    case 'reasoning':
      return respectThinkingToggle ? showThinking() && part.text.trim().length > 0 : true;
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

export function getFinalAssistantTextPartId(parts: Part[], isCompleted: boolean): string | null {
  if (!isCompleted) return null;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (!shouldShowAssistantPartInline(part, false)) continue;
    if (part.type !== 'text') return null;
    if (part.type === 'text' && part.text.trim().length > 0) return part.id;
  }

  return null;
}
