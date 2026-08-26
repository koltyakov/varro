import type { MessageEntry, ToolPart } from '../types';
import { getToolKind } from './tool-normalization';
import { isString, type UnknownRecord } from './runtime-values';

export type TaskSessionInfo = {
  id: string;
  parentID?: string;
  title: string;
  time: { created: number };
  tokens?: {
    input: number;
    output: number;
    reasoning?: number;
    cache?: { read: number; write: number };
  };
};

function getTaskSessionIdFromMetadata(metadata: UnknownRecord | undefined) {
  if (isString(metadata?.sessionId)) return metadata.sessionId;
  if (isString(metadata?.sessionID)) return metadata.sessionID;
  return null;
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
  createdBefore?: number
) {
  if (getToolKind(tool.tool) !== 'task' || tool.state.status === 'pending') return null;

  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const metadata = tool.state.metadata as UnknownRecord | undefined;
  const metadataSessionId = getTaskSessionIdFromMetadata(metadata);
  if (metadataSessionId) {
    const metadataSession = sessions.find((session) => session.id === metadataSessionId);
    if (
      metadataSession &&
      createdBefore !== undefined &&
      metadataSession.time.created >= createdBefore
    ) {
      return null;
    }
    return metadataSessionId;
  }

  const parent = messages.find((entry) => entry.info.id === tool.messageID);
  const parentCreated = parent?.info.time.created || 0;
  const candidates = sessions
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
