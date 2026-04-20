import type { Part, ToolPart } from '../types';
import { getToolFileChange, getToolReadPath } from './tool-file-change';
import { showThinking } from './state';

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
      return respectThinkingToggle ? showThinking() : true;
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
