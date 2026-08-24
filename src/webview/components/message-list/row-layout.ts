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
import type { MessageEntry, Part } from '../../types';

export type MessageBlockBoundary = {
  startsBordered: boolean;
  endsBordered: boolean;
  signature: string;
};

type MessageBlockBoundaryOptions = {
  expandedActivityGroup: (key: string) => boolean;
  renderEmptyMessageIds: ReadonlySet<string>;
  showThinking: boolean;
  streaming?: { partId: string | null; text: string };
  visibleActiveActivityPartKeys?: ReadonlySet<string>;
  retainedActivityPartKeys?: ReadonlySet<string>;
  exitingActivityPartKeys?: ReadonlySet<string>;
  modelChangeMessageIds?: ReadonlySet<string>;
  dialogSummaryMessageIds?: ReadonlySet<string>;
};

export function getMessageBlockBoundaryMap(
  messages: readonly MessageEntry[],
  groups: ReadonlyMap<string, readonly AssistantActivityGroupInfo[]>,
  options: MessageBlockBoundaryOptions
) {
  const boundaries = new Map<string, MessageBlockBoundary>();

  for (const message of messages) {
    const messageId = message.info.id;
    if (options.renderEmptyMessageIds.has(messageId)) {
      boundaries.set(messageId, {
        startsBordered: false,
        endsBordered: false,
        signature: 'empty',
      });
      continue;
    }

    if (message.info.role === 'user') {
      const interruptedStart = options.modelChangeMessageIds?.has(messageId) ?? false;
      const interruptedEnd = options.dialogSummaryMessageIds?.has(messageId) ?? false;
      boundaries.set(messageId, {
        startsBordered: !interruptedStart,
        endsBordered: !interruptedEnd,
        signature: `user:${interruptedStart ? 'u' : 'b'}:${interruptedEnd ? 'u' : 'b'}`,
      });
      continue;
    }

    const messageGroups = groups.get(messageId) ?? [];
    const groupByPartKey = new Map(
      messageGroups.flatMap((group) =>
        group.parts.map((part) => [getAssistantActivityPartKey(part), group] as const)
      )
    );
    const blocks: boolean[] = [];
    const renderedGroupKeys = new Set<string>();
    const renderedActiveSummaryKeys = new Set<string>();

    for (const part of message.parts) {
      if (part.type === 'text') {
        if (hasVisibleProjectedText(part, options.streaming)) blocks.push(false);
        continue;
      }
      if (part.type === 'reasoning' && !options.showThinking) continue;
      if (!shouldShowAssistantPartInline(part, false)) continue;

      if (!isAssistantActivityPart(part)) {
        blocks.push(isBorderedAssistantPart(part));
        continue;
      }

      const partKey = getAssistantActivityPartKey(part);
      if (
        options.visibleActiveActivityPartKeys?.has(partKey) ||
        options.retainedActivityPartKeys?.has(partKey) ||
        options.exitingActivityPartKeys?.has(partKey)
      ) {
        const activeGroup = groupByPartKey.get(partKey);
        if (
          activeGroup?.ownerMessageId === messageId &&
          !renderedActiveSummaryKeys.has(activeGroup.key)
        ) {
          renderedActiveSummaryKeys.add(activeGroup.key);
          blocks.push(false);
        }
        blocks.push(true);
        continue;
      }

      const group = groupByPartKey.get(partKey);
      if (!group) {
        blocks.push(true);
        continue;
      }
      if (renderedGroupKeys.has(group.key)) continue;
      renderedGroupKeys.add(group.key);
      if (group.ownerMessageId === messageId) blocks.push(false);
      if (options.expandedActivityGroup(group.key)) blocks.push(true);
    }

    if (message.info.error) blocks.push(true);
    if (options.modelChangeMessageIds?.has(messageId)) blocks.unshift(false);
    if (options.dialogSummaryMessageIds?.has(messageId)) blocks.push(false);
    let borderedPairCount = 0;
    for (let index = 1; index < blocks.length; index += 1) {
      if (blocks[index - 1] && blocks[index]) borderedPairCount += 1;
    }

    boundaries.set(messageId, {
      startsBordered: blocks[0] === true,
      endsBordered: blocks.at(-1) === true,
      signature: `${blocks[0] ? 'b' : 'u'}:${blocks.at(-1) ? 'b' : 'u'}:${borderedPairCount}`,
    });
  }

  return boundaries;
}

export function getBorderedAdjacencyLayoutSignatures(
  messages: readonly { info: { id: string } }[],
  boundaries: ReadonlyMap<string, MessageBlockBoundary>,
  renderEmptyMessageIds: ReadonlySet<string>
) {
  const signatures = new Map<string, string>();
  let previousVisibleMessageId: string | null = null;

  for (const message of messages) {
    const messageId = message.info.id;
    const boundary = boundaries.get(messageId);
    if (!boundary) continue;
    const previousBoundary = previousVisibleMessageId
      ? boundaries.get(previousVisibleMessageId)
      : undefined;
    const followsBordered =
      !!previousBoundary?.endsBordered &&
      boundary.startsBordered &&
      !renderEmptyMessageIds.has(messageId);
    signatures.set(
      messageId,
      `${boundary.signature}\u0000${previousVisibleMessageId ?? ''}\u0000${followsBordered ? 'tight' : 'normal'}`
    );
    if (!renderEmptyMessageIds.has(messageId)) previousVisibleMessageId = messageId;
  }

  return signatures;
}

function isBorderedAssistantPart(part: Part) {
  return (
    part.type === 'tool' ||
    part.type === 'reasoning' ||
    part.type === 'file' ||
    part.type === 'agent'
  );
}

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
          : shouldShowAssistantPartInline(part);
      if (!visible) continue;
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
