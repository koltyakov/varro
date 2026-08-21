import {
  getAssistantActivityPartKey,
  isAssistantActivityPart,
  type AssistantActivityGroupInfo,
  type AssistantActivityPart,
} from '../../lib/assistant-activity';
import { isAssistantMessage } from '../../lib/message-metrics';
import {
  hasVisibleReasoningContent,
  isWorkspaceDirectoryText,
  shouldShowAssistantPartInline,
} from '../../lib/part-utils';
import { getToolInlineFileChangesLayoutSignature } from '../../lib/tool-file-change';
import { showThinking } from '../../lib/state';
import type { MessageEntry, Part } from '../../types';

export function getInlinePreviewLayoutSignatures(
  messages: readonly { info: { id: string }; parts: readonly Part[] }[],
  enabled: boolean
) {
  const signatures = new Map<string, string>();
  if (!enabled) return signatures;

  for (const message of messages) {
    const partSignatures: string[] = [];
    for (const part of message.parts) {
      if (part.type !== 'tool') continue;
      const signature = getToolInlineFileChangesLayoutSignature(part.tool, part.state);
      if (signature) {
        const cardLayout = part.state.status === 'completed' ? 'preview-only' : 'preview-with-card';
        partSignatures.push(`${part.id}:${cardLayout}:${signature}`);
      }
    }
    if (partSignatures.length > 0) {
      signatures.set(message.info.id, partSignatures.join('\u0000'));
    }
  }
  return signatures;
}

export function getCompactActivityLayoutSignatures(
  messages: readonly {
    info: { id: string; role: 'user' | 'assistant' };
    parts: readonly Part[];
  }[]
) {
  const signatures = new Map<string, string>();

  for (const message of messages) {
    if (message.info.role !== 'assistant') continue;
    const activityPartIds = message.parts.flatMap((part) =>
      isAssistantActivityPart(part) ? [part.id] : []
    );
    if (activityPartIds.length > 0) {
      signatures.set(message.info.id, activityPartIds.join('\u0000'));
    }
  }
  return signatures;
}

export function getThinkingLayoutSignatures(
  messages: readonly {
    info: { id: string; role: 'user' | 'assistant' };
    parts: readonly Part[];
  }[],
  enabled: boolean
) {
  const signatures = new Map<string, string>();
  if (!enabled) return signatures;

  for (const message of messages) {
    if (message.info.role !== 'assistant') continue;
    const reasoningPartIds = message.parts.flatMap((part) =>
      part.type === 'reasoning' && hasVisibleReasoningContent(part.text) ? [part.id] : []
    );
    if (reasoningPartIds.length > 0) {
      signatures.set(message.info.id, reasoningPartIds.join('\u0000'));
    }
  }
  return signatures;
}

export function getCompactActivityDisclosureLayoutSignatures(
  groups: ReadonlyMap<string, readonly AssistantActivityGroupInfo[]>,
  isExpanded: (key: string) => boolean,
  getPartLayoutState?: (part: AssistantActivityPart) => string
) {
  return new Map(
    [...groups].map(([messageId, messageGroups]) => [
      messageId,
      messageGroups
        .map((group) => {
          const partSignature = group.parts
            .map(
              (part) => `${part.messageID}\u0000${part.id}\u0000${getPartLayoutState?.(part) ?? ''}`
            )
            .join('\u0002');
          return `${group.key}\u0000${group.ownerMessageId}\u0000${group.ownerPartId}\u0000${isExpanded(group.key) ? 'expanded' : 'collapsed'}\u0000${partSignature}`;
        })
        .join('\u0001'),
    ])
  );
}

export function getRenderEmptyAssistantMessageIds(
  messages: readonly MessageEntry[],
  groups: ReadonlyMap<string, readonly AssistantActivityGroupInfo[]>,
  isExpanded: (key: string) => boolean,
  transitionActivityPartKeys?: {
    delayed: ReadonlySet<string>;
    visibleActive: ReadonlySet<string>;
    retained: ReadonlySet<string>;
    exiting: ReadonlySet<string>;
  },
  streaming?: { partId: string | null; text: string }
) {
  const result = new Set<string>();

  for (const message of messages) {
    if (!isAssistantMessage(message.info) || message.info.error) continue;
    const messageGroups = groups.get(message.info.id) ?? [];
    const groupByPartKey = new Map(
      messageGroups.flatMap((group) =>
        group.parts.map((part) => [`${part.messageID}\u0000${part.id}`, group] as const)
      )
    );
    let hasVisibleRowContent = false;

    for (const part of message.parts) {
      const visible =
        part.type === 'text'
          ? hasVisibleProjectedText(part, streaming)
          : part.type === 'reasoning'
            ? hasVisibleProjectedReasoning(part, streaming)
            : shouldShowAssistantPartInline(part);
      if (!visible) continue;
      // Reasoning renders standalone in its own flow instead of joining the
      // compact activity group, so it always counts as visible row content.
      if (part.type === 'reasoning') {
        hasVisibleRowContent = true;
        break;
      }
      if (!isAssistantActivityPart(part)) {
        hasVisibleRowContent = true;
        break;
      }

      const partKey = getAssistantActivityPartKey(part);
      if (transitionActivityPartKeys?.delayed.has(partKey)) continue;
      if (
        transitionActivityPartKeys?.visibleActive.has(partKey) ||
        transitionActivityPartKeys?.retained.has(partKey) ||
        transitionActivityPartKeys?.exiting.has(partKey)
      ) {
        hasVisibleRowContent = true;
        break;
      }

      const group = groupByPartKey.get(partKey);
      if (!group || group.ownerMessageId === message.info.id || isExpanded(group.key)) {
        hasVisibleRowContent = true;
        break;
      }
    }

    if (!hasVisibleRowContent) result.add(message.info.id);
  }

  return result;
}

export function hasVisibleProjectedText(
  part: { id: string; text: string },
  streaming?: { partId: string | null; text: string }
) {
  const text = part.id === streaming?.partId ? streaming.text || part.text : part.text;
  return text.trim().length > 0 && !isWorkspaceDirectoryText(text);
}

export function hasVisibleProjectedReasoning(
  part: { id: string; text: string },
  streaming?: { partId: string | null; text: string }
) {
  if (!showThinking()) return false;
  const text = part.id === streaming?.partId ? streaming.text || part.text : part.text;
  return hasVisibleReasoningContent(text);
}

export function getChangedInlinePreviewMessageIds(
  previous: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
  currentMessageIds: ReadonlySet<string>
) {
  return [...new Set([...previous.keys(), ...current.keys()])].filter(
    (messageId) =>
      currentMessageIds.has(messageId) && previous.get(messageId) !== current.get(messageId)
  );
}
