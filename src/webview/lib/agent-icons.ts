import cubeIcon from 'iconoir/icons/cube.svg';
import { createSignal } from 'solid-js';
import { isString } from '../../shared/type-utils';
import type { Agent } from '../types';
import type * as AgentIconCatalog from './agent-icon-catalog';
import { calendarCheckIcon, chatBubbleQuestionIcon, toolsIcon } from './ui-icons';

const [catalog, setCatalog] = createSignal<typeof AgentIconCatalog>();
let catalogRequested = false;

async function loadCatalog(): Promise<void> {
  try {
    setCatalog(await import('./agent-icon-catalog'));
  } catch (error) {
    // oxlint-disable-next-line no-console
    console.warn('Failed to load agent icons', error);
  }
}

export function getAgentIcon(agent: Pick<Agent, 'name' | 'options'>): string {
  const icon = agent.options?.icon;
  if (isString(icon) && icon.trim()) {
    if (!catalogRequested) {
      catalogRequested = true;
      void loadCatalog();
    }
    return catalog()?.getCatalogIcon(icon.trim()) ?? cubeIcon;
  }
  if (agent.name.toLowerCase() === 'build') return toolsIcon;
  if (agent.name.toLowerCase() === 'ask') return chatBubbleQuestionIcon;
  if (agent.name.toLowerCase() === 'plan') return calendarCheckIcon;
  return cubeIcon;
}
