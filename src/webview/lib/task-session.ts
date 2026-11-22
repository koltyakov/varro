import type { MessageEntry, ToolPart } from '../types';
import { getToolKind } from './tool-normalization';
import { isString, type UnknownRecord } from './runtime-values';

export type TaskSessionInfo = {
  id: string;
  parentID?: string;
  title: string;
  time: { created: number };
  cost?: number;
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
    cache?: { read: number; write: number };
  };
};

export type TaskSessionLookup = {
  messagesById: ReadonlyMap<string, MessageEntry>;
  sessionsById: ReadonlyMap<string, TaskSessionInfo>;
  sessionsByParentId: ReadonlyMap<string, readonly TaskSessionInfo[]>;
};

function getTaskSessionIdFromMetadata(metadata: UnknownRecord | undefined) {
  if (isString(metadata?.sessionId)) return metadata.sessionId;
  if (isString(metadata?.sessionID)) return metadata.sessionID;
  return null;
}

function getTaskSessionIdFromInput(input: UnknownRecord | undefined) {
  if (isString(input?.sessionID)) return input.sessionID;
  return isString(input?.task_id) ? input.task_id : null;
}

/** The child session named by the call itself, never one inferred from titles or position. */
export function getExplicitTaskSessionId(tool: ToolPart) {
  if (getToolKind(tool.tool) !== 'task' || tool.state.status === 'pending') return null;
  return (
    getTaskSessionIdFromMetadata(tool.state.metadata) ?? getTaskSessionIdFromInput(tool.state.input)
  );
}

// A resumed child keeps its session ID. Only the newest call owns its live
// status, and each call owns notices up to the next launch for that child.
export function nextTaskLaunchStart(
  tool: ToolPart,
  childID: string,
  entries: readonly MessageEntry[]
) {
  if (tool.state.status === 'pending') return Infinity;
  const start = tool.state.time.start;
  let passedTool = false;
  let end = Infinity;
  for (const entry of entries) {
    if (entry.info.role !== 'assistant') continue;
    for (const part of entry.parts) {
      if (part.type !== 'tool' || getToolKind(part.tool) !== 'task') continue;
      if (part.messageID === tool.messageID && part.callID === tool.callID) {
        passedTool = true;
        continue;
      }
      if (part.state.status === 'pending') continue;
      const time = part.state.time.start;
      if (time < start || (time === start && !passedTool) || time >= end) continue;
      const id =
        getTaskSessionIdFromMetadata(part.state.metadata) ??
        getTaskSessionIdFromInput(part.state.input);
      if (id === childID) end = time;
    }
  }
  return end;
}

function normalizeTaskMatchLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sessionMatchesTaskLabel(session: TaskSessionInfo, taskLabel: string) {
  if (!taskLabel) return false;
  const title = normalizeTaskMatchLabel(session.title);
  return title === taskLabel || title.startsWith(`${taskLabel} (`);
}

export function resolveTaskSessionId(
  tool: ToolPart,
  messages: MessageEntry[],
  sessions: readonly TaskSessionInfo[],
  createdBefore?: number,
  lookup?: TaskSessionLookup
) {
  if (getToolKind(tool.tool) !== 'task' || tool.state.status === 'pending') return null;

  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const metadata = tool.state.metadata as UnknownRecord | undefined;
  const metadataSessionId = getTaskSessionIdFromMetadata(metadata);
  if (metadataSessionId) {
    const metadataSession =
      lookup?.sessionsById.get(metadataSessionId) ??
      sessions.find((session) => session.id === metadataSessionId);
    if (
      metadataSession &&
      createdBefore !== undefined &&
      metadataSession.time.created >= createdBefore
    ) {
      return null;
    }
    return metadataSessionId;
  }

  const inputSessionId = getTaskSessionIdFromInput(tool.state.input);
  if (inputSessionId) return inputSessionId;

  const parent =
    lookup?.messagesById.get(tool.messageID) ??
    messages.find((entry) => entry.info.id === tool.messageID);
  const parentCreated = parent?.info.time.created || 0;
  const candidateSessions = lookup
    ? [
        ...(lookup.sessionsByParentId.get(tool.sessionID) || []),
        ...(tool.messageID === tool.sessionID
          ? []
          : lookup.sessionsByParentId.get(tool.messageID) || []),
      ]
    : sessions;
  const candidates = candidateSessions
    .filter((session) => {
      if (session.parentID !== tool.sessionID && session.parentID !== tool.messageID) return false;
      if (parentCreated > 0 && session.time.created < parentCreated) return false;
      return createdBefore === undefined || session.time.created < createdBefore;
    })
    .toSorted((a, b) => a.time.created - b.time.created);
  if (candidates.length === 0) return null;

  const description = tool.state.input?.description;
  const title =
    tool.state.status === 'running' || tool.state.status === 'completed' ? tool.state.title : '';
  const taskLabel = normalizeTaskMatchLabel(
    isString(description) && description.trim() ? description : title || tool.tool
  );
  const byTitle = candidates.find((session) => sessionMatchesTaskLabel(session, taskLabel));
  if (byTitle) return byTitle.id;

  const taskParts =
    parent?.parts.filter(
      (part): part is ToolPart => part.type === 'tool' && getToolKind(part.tool) === 'task'
    ) || [];
  const taskIndex = taskParts.findIndex((part) => part.callID === tool.callID);
  return taskIndex >= 0 ? (candidates[taskIndex]?.id ?? null) : null;
}
