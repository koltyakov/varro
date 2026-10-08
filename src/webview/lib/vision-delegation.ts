import type { Agent, Provider } from '../types';
import { modelSupportsVision } from './model-capabilities';

export const VISION_AGENT_NAME = 'vision';

export function canDelegateVision(agents: Agent[], providers: Provider[]): boolean {
  const agent = agents.find(
    (item) =>
      item.name === VISION_AGENT_NAME &&
      !item.hidden &&
      (item.mode === 'subagent' || item.mode === 'all')
  );
  if (!agent?.model) return false;
  return modelSupportsVision(agent.model.providerID, agent.model.modelID, providers);
}
