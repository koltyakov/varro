import type { Agent, Provider } from '../types';
import { modelSupportsVision } from './model-capabilities';
import { isString } from './runtime-values';

export const VISION_AGENT_NAME = 'vision';

export function canDelegateVision(
  text: string | readonly string[],
  agents: Agent[],
  providers: Provider[]
): boolean {
  const texts = isString(text) ? [text] : text;
  if (!texts.some((value) => mentionsAgent(value, VISION_AGENT_NAME))) return false;
  const agent = agents.find(
    (item) =>
      item.name === VISION_AGENT_NAME &&
      !item.hidden &&
      (item.mode === 'subagent' || item.mode === 'all')
  );
  if (!agent?.model) return false;
  return modelSupportsVision(agent.model.providerID, agent.model.modelID, providers);
}

function mentionsAgent(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)@${escaped}(?=$|\\s|[.,!?;:()[\\]{}])`).test(text);
}
