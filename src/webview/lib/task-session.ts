import type { Message, Part, ToolPart } from '../types';

export type TaskSessionInfo = {
  id: string;
  parentID?: string;
  title: string;
  time: { created: number };
  tokens?: { input: number; output: number };
};

type MessageEntry = { info: Message; parts: Part[] };

function normalizeToolName(toolName: string) {
  const normalized = toolName.trim().toLowerCase();
  const parts = normalized.split('.');
  return parts[parts.length - 1] || normalized;
}

function getTaskSessionIdFromMetadata(metadata: Record<string, unknown> | undefined) {
  if (typeof metadata?.sessionId === 'string') return metadata.sessionId;
  if (typeof metadata?.sessionID === 'string') return metadata.sessionID;
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
  sessions: readonly TaskSessionInfo[]
) {
  if (normalizeToolName(tool.tool) !== 'task' || tool.state.status === 'pending') return null;

  const metadata = tool.state.metadata as Record<string, unknown> | undefined;
  const metadataSessionId = getTaskSessionIdFromMetadata(metadata);
  if (metadataSessionId) return metadataSessionId;

  const parent = messages.find((entry) => entry.info.id === tool.messageID);
  const parentCreated = parent?.info.time.created || 0;
  const candidates = sessions
    .filter((session) => {
      if (session.parentID !== tool.sessionID && session.parentID !== tool.messageID) return false;
      return parentCreated <= 0 || session.time.created >= parentCreated;
    })
    .toSorted((a, b) => a.time.created - b.time.created);
  if (candidates.length === 0) return null;

  const description = tool.state.input?.description;
  const title =
    tool.state.status === 'running' || tool.state.status === 'completed' ? tool.state.title : '';
  const taskLabel = normalizeTaskMatchLabel(
    typeof description === 'string' && description.trim() ? description : title || tool.tool
  );
  const byTitle = candidates.find((session) => sessionMatchesTaskLabel(session, taskLabel));
  if (byTitle) return byTitle.id;

  const taskParts =
    parent?.parts.filter(
      (part): part is ToolPart => part.type === 'tool' && normalizeToolName(part.tool) === 'task'
    ) || [];
  const taskIndex = taskParts.findIndex((part) => part.callID === tool.callID);
  return taskIndex >= 0 ? (candidates[taskIndex]?.id ?? null) : null;
}
