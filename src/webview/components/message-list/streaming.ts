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
