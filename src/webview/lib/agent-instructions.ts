import type { MessageEntry, Part, TextPart, ToolPart } from '../types';

function isAgentInstructionPart(part: Part): part is TextPart {
  return (
    part.type === 'text' &&
    part.synthetic === true &&
    part.text.trimStart().startsWith('Instructions from:')
  );
}

export function getAgentInstructionTool(part: Part): ToolPart | null {
  if (!isAgentInstructionPart(part)) return null;
  const text = part.text.trim();
  const newline = text.indexOf('\n');
  const path = text.slice('Instructions from:'.length, newline < 0 ? undefined : newline).trim();
  return {
    id: part.id,
    messageID: part.messageID,
    sessionID: part.sessionID,
    type: 'tool',
    callID: part.id,
    tool: 'agent_instructions',
    state: {
      status: 'completed',
      input: path ? { path } : {},
      title: path ? `Loaded agent instructions: ${path}` : 'Loaded agent instructions',
      output: newline < 0 ? '' : text.slice(newline + 1).trim(),
      metadata: {},
      time: { start: 0, end: 0 },
    },
  };
}

export function isAgentInstructionMessage(message: MessageEntry): boolean {
  return (
    message.info.role === 'user' &&
    message.parts.length > 0 &&
    message.parts.every(isAgentInstructionPart)
  );
}
