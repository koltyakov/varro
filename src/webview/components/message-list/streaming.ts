import { isWorkspaceDirectoryText, shouldShowAssistantPartInline } from '../../lib/part-utils';
import type { Message, Part } from '../../types';

export function hasVisibleBlockingStreamingPart(part: Part | null, streamingText: string) {
  if (!part) return false;

  if (part.type === 'text') {
    const text = (streamingText || part.text).trim();
    return text.length > 0 && !isWorkspaceDirectoryText(text);
  }

  if (part.type === 'reasoning') {
    return false;
  }

  return shouldShowAssistantPartInline(part);
}

export function findStreamingPart(
  messages: Array<{ info: Message; parts: Part[] }>,
  streamingPartId: string | null
) {
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
  messages: Array<{ info: Message; parts: Part[] }>,
  streamingPartId: string | null,
  loadingStartedAt: number | null
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (entry.info.role !== 'assistant') return false;
    if (entry.info.error) return false;
    const completedAt = entry.info.time.completed;
    if (
      typeof completedAt === 'number' &&
      loadingStartedAt !== null &&
      loadingStartedAt > completedAt
    ) {
      return false;
    }
    for (let j = entry.parts.length - 1; j >= 0; j--) {
      const part = entry.parts[j];
      if (!shouldShowAssistantPartInline(part)) continue;
      if (part.id === streamingPartId) return false;
      if (part.type === 'text') {
        const text = part.text.trim();
        return text.length > 0 && !isWorkspaceDirectoryText(text);
      }
      return false;
    }
    return false;
  }
  return false;
}
