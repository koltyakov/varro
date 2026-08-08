import { isAbortedToolError } from '../../shared/error-classification';
import type { AssistantMessage, MessageEntry, Part } from '../types';
import { isFileEditPart, isFileReadPart } from './part-utils';
import { getToolFileChanges } from './tool-file-change';

export type AssistantActivityPart = Extract<Part, { type: 'reasoning' | 'tool' }>;

export type AssistantActivityGroupInfo = {
  key: string;
  ownerMessageId: string;
  ownerPartId: string;
  parts: AssistantActivityPart[];
};

export type AssistantActivityKind =
  | 'files'
  | 'reasoning'
  | 'searches'
  | 'edits'
  | 'commands'
  | 'web'
  | 'questions'
  | 'skills'
  | 'tools';

const ACTIVITY_KIND_ORDER: readonly AssistantActivityKind[] = [
  'files',
  'reasoning',
  'searches',
  'edits',
  'commands',
  'web',
  'questions',
  'skills',
  'tools',
];
const SEARCH_TOOL_NAMES = new Set(['grep', 'glob', 'codesearch', 'search', 'websearch']);
const EDIT_TOOL_NAMES = new Set([
  'apply_patch',
  'create',
  'delete',
  'edit',
  'patch',
  'rename',
  'write',
]);
const COMMAND_TOOL_NAMES = new Set(['bash', 'command', 'exec', 'shell', 'terminal']);

function normalizeToolName(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  return normalized.split('.').at(-1) || normalized;
}

function getActivityKind(part: AssistantActivityPart): AssistantActivityKind {
  if (part.type === 'reasoning') return 'reasoning';

  const toolName = normalizeToolName(part.tool);
  if (toolName === 'read' || isFileReadPart(part)) return 'files';
  if (SEARCH_TOOL_NAMES.has(toolName)) return 'searches';
  if (EDIT_TOOL_NAMES.has(toolName) || isFileEditPart(part)) return 'edits';
  if (COMMAND_TOOL_NAMES.has(toolName)) return 'commands';
  if (toolName === 'webfetch' || toolName.includes('browser')) return 'web';
  if (toolName === 'question') return 'questions';
  if (toolName === 'skill') return 'skills';
  return 'tools';
}

function formatCount(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatActivityCount(kind: AssistantActivityKind, count: number) {
  switch (kind) {
    case 'files':
      return formatCount(count, 'file');
    case 'reasoning':
      return formatCount(count, 'thought');
    case 'searches':
      return formatCount(count, 'search', 'searches');
    case 'edits':
      return formatCount(count, 'edit');
    case 'commands':
      return formatCount(count, 'command');
    case 'web':
      return formatCount(count, 'web request');
    case 'questions':
      return formatCount(count, 'question');
    case 'skills':
      return formatCount(count, 'skill');
    case 'tools':
      return formatCount(count, 'tool call');
  }
}

export function isAssistantActivityPart(part: Part): part is AssistantActivityPart {
  if (part.type === 'reasoning') return true;
  if (part.type !== 'tool') return false;
  return !['question', 'task'].includes(normalizeToolName(part.tool));
}

export function getAssistantActivityPartKey(
  part: AssistantActivityPart
): `${string}\u0000${string}` {
  return `${part.messageID}\u0000${part.id}`;
}

export function isAssistantEditActivityPart(part: AssistantActivityPart) {
  return getActivityKind(part) === 'edits';
}

export function isAssistantActivityPartRunning(part: AssistantActivityPart) {
  if (part.type === 'reasoning') return part.time.end === undefined;
  return part.state.status === 'pending' || part.state.status === 'running';
}

export function shouldCompactAssistantActivityPart(
  part: AssistantActivityPart,
  options: { showInlineFileChanges: boolean; keepEditInline: boolean }
) {
  return (
    !options.showInlineFileChanges || !isAssistantEditActivityPart(part) || !options.keepEditInline
  );
}

export function getAssistantActivityGroupMap(
  messages: readonly MessageEntry[],
  includePart: (part: AssistantActivityPart) => boolean = () => true,
  isBoundaryPart: (part: Part) => boolean = () => true
) {
  const result = new Map<string, AssistantActivityGroupInfo[]>();
  let turnUserMessageId: string | null = null;
  let groupEntries: Array<{
    messageId: string;
    parentId: string;
    parts: AssistantActivityPart[];
  }> = [];

  const flush = () => {
    const owner = groupEntries[0];
    const ownerPart = owner?.parts[0];
    if (!owner || !ownerPart) {
      groupEntries = [];
      return;
    }

    const group: AssistantActivityGroupInfo = {
      key: `activity-segment\u0000${ownerPart.sessionID}\u0000${owner.parentId || turnUserMessageId || owner.messageId}\u0000${ownerPart.id}`,
      ownerMessageId: owner.messageId,
      ownerPartId: ownerPart.id,
      parts: groupEntries.flatMap((entry) => entry.parts),
    };
    for (const entry of groupEntries) {
      const groups = result.get(entry.messageId);
      if (groups) groups.push(group);
      else result.set(entry.messageId, [group]);
    }
    groupEntries = [];
  };

  for (const entry of messages) {
    if (entry.info.role === 'user') {
      flush();
      turnUserMessageId = entry.info.id;
      continue;
    }

    if ((entry.info as AssistantMessage).mode === 'subagent') {
      flush();
      continue;
    }
    for (const part of entry.parts) {
      if (isAssistantActivityPart(part) && includePart(part)) {
        const previous = groupEntries.at(-1);
        if (previous?.messageId === entry.info.id) previous.parts.push(part);
        else {
          groupEntries.push({
            messageId: entry.info.id,
            parentId: (entry.info as AssistantMessage).parentID,
            parts: [part],
          });
        }
        continue;
      }
      if (isBoundaryPart(part)) flush();
    }
  }

  flush();
  return result;
}

export function preserveAssistantActivityGroupKeys(
  current: ReadonlyMap<string, readonly AssistantActivityGroupInfo[]>,
  previous: ReadonlyMap<string, readonly AssistantActivityGroupInfo[]>
) {
  const previousGroupByPart = new Map<string, AssistantActivityGroupInfo>();
  for (const groups of previous.values()) {
    for (const group of groups) {
      for (const part of group.parts) {
        previousGroupByPart.set(`${part.sessionID}\u0000${part.messageID}\u0000${part.id}`, group);
      }
    }
  }

  const replacements = new Map<AssistantActivityGroupInfo, AssistantActivityGroupInfo>();
  const claimedPreviousKeys = new Set<string>();
  for (const groups of current.values()) {
    for (const group of groups) {
      if (replacements.has(group)) continue;

      const previousGroups = new Set(
        group.parts.flatMap((part) => {
          const previousGroup = previousGroupByPart.get(
            `${part.sessionID}\u0000${part.messageID}\u0000${part.id}`
          );
          return previousGroup ? [previousGroup] : [];
        })
      );
      const previousGroup = previousGroups.size === 1 ? [...previousGroups][0] : undefined;
      const preservedKey =
        previousGroup && !claimedPreviousKeys.has(previousGroup.key)
          ? previousGroup.key
          : group.key;
      claimedPreviousKeys.add(preservedKey);
      replacements.set(group, preservedKey === group.key ? group : { ...group, key: preservedKey });
    }
  }

  return new Map(
    [...current].map(([messageId, groups]) => [
      messageId,
      groups.map((group) => replacements.get(group) ?? group),
    ])
  );
}

export function formatAssistantActivityCounts(parts: readonly AssistantActivityPart[]) {
  const items = getAssistantActivityCountItems(parts);
  return `Explored: ${items.map((item) => item.label).join(', ')}`;
}

export function getAssistantActivityCountItems(parts: readonly AssistantActivityPart[]) {
  const counts = new Map<AssistantActivityKind, number>();
  for (const part of parts) {
    const kind = getActivityKind(part);
    const count =
      kind === 'edits' && part.type === 'tool'
        ? getToolFileChanges(part.tool, part.state).filter((change) => !change.isSummary).length ||
          1
        : 1;
    counts.set(kind, (counts.get(kind) || 0) + count);
  }

  return ACTIVITY_KIND_ORDER.flatMap((kind) => {
    const count = counts.get(kind);
    return count ? [{ kind, count, label: formatActivityCount(kind, count) }] : [];
  });
}

export function formatAssistantActivitySummary(parts: readonly AssistantActivityPart[]) {
  const status = getAssistantActivityStatus(parts);
  const counts = formatAssistantActivityCounts(parts);
  const statusLabels =
    status.aborted > 0 ? [formatCount(status.aborted, 'tool aborted', 'tools aborted')] : [];
  return `${counts}${statusLabels.length > 0 ? ` · ${statusLabels.join(' · ')}` : ''}`;
}

export function getAssistantActivityStatus(parts: readonly AssistantActivityPart[]) {
  let running = false;
  let failed = 0;
  let aborted = 0;

  for (const part of parts) {
    running ||= isAssistantActivityPartRunning(part);
    if (part.type === 'reasoning') continue;
    if (part.type !== 'tool') continue;
    if (part.state.status !== 'error') continue;
    if (isAbortedToolError(part.state)) aborted += 1;
    else failed += 1;
  }

  return { running, failed, aborted };
}
