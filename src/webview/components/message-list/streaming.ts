import { isWorkspaceDirectoryText, shouldShowAssistantPartInline } from '../../lib/part-utils';
import type { MessageEntry, Part } from '../../types';

export function hasVisibleBlockingStreamingPart(part: Part | null, streamingText: string) {
  if (!part) return false;

  if (part.type === 'text') {
    const text = (streamingText || part.text).trim();
    return text.length > 0 && !isWorkspaceDirectoryText(text);
  }

  if (part.type === 'reasoning') {
    return false;
  }

  if (part.type === 'tool') {
    const normalizedTool = part.tool.trim().toLowerCase();
    if ((normalizedTool.split('.').at(-1) || normalizedTool) === 'task') return false;
  }

  return shouldShowAssistantPartInline(part);
}

export function findStreamingPart(messages: MessageEntry[], streamingPartId: string | null) {
  if (!streamingPartId) return null;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.id !== streamingPartId) continue;
      return part;
    }
  }

  return null;
}

export function hasCommittedVisibleTextAsLastPart(
  messages: MessageEntry[],
  streamingPartId: string | null,
  loadingStartedAt: number | null
): boolean {
  const entry = messages.at(-1);
  if (!entry || entry.info.role !== 'assistant' || entry.info.error) return false;
  const completedAt = entry.info.time.completed;
  if (
    typeof completedAt === 'number' &&
    loadingStartedAt !== null &&
    loadingStartedAt > completedAt
  ) {
    return false;
  }

  for (let index = entry.parts.length - 1; index >= 0; index -= 1) {
    const part = entry.parts[index]!;
    if (!shouldShowAssistantPartInline(part)) continue;
    if (part.id === streamingPartId || part.type !== 'text') return false;
    const text = part.text.trim();
    return text.length > 0 && !isWorkspaceDirectoryText(text);
  }

  return false;
}
