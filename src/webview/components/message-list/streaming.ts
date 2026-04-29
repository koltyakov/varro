import { isWorkspaceDirectoryText, shouldShowAssistantPartInline } from '../../lib/part-utils';
import type { Message, Part } from '../../types';

export function hasVisibleBlockingStreamingPart(
  messages: Array<{ info: Message; parts: Part[] }>,
  streamingPartId: string | null,
  streamingText: string
) {
  if (!streamingPartId) return false;

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.id !== streamingPartId) continue;

      if (part.type === 'text') {
        const text = (streamingText || part.text).trim();
        return text.length > 0 && !isWorkspaceDirectoryText(text);
      }

      if (part.type === 'reasoning') {
        return false;
      }

      return shouldShowAssistantPartInline(part);
    }
  }

  return false;
}
