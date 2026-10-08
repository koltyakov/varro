import type { Agent } from './opencode-types';

export const VISION_AGENT_NAME = 'vision';
export const VARRO_VISION_AGENT_DESCRIPTION = 'Inspects images for text-only parent agents';
export const VARRO_VISION_AGENT_PROMPT =
  "Analyze every supplied image carefully. Return a concise textual description, including visible text, UI state, diagrams, errors, and details relevant to the parent agent's request. Do not modify files or run shell commands.";

export function isVarroVisionAgent(agent: Agent): boolean {
  return (
    agent.name === VISION_AGENT_NAME &&
    agent.mode === 'subagent' &&
    agent.description === VARRO_VISION_AGENT_DESCRIPTION &&
    agent.prompt === VARRO_VISION_AGENT_PROMPT
  );
}
