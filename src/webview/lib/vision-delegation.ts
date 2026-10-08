import type { Agent, Provider } from '../types';
import { modelSupportsVision } from './model-capabilities';
import { VISION_AGENT_NAME } from '../../shared/vision-agent';

export { VISION_AGENT_NAME } from '../../shared/vision-agent';

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
