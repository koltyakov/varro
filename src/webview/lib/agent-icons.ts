import cubeIcon from 'iconoir/icons/cube.svg';
import { isString } from '../../shared/type-utils';
import type { Agent } from '../types';
import { calendarCheckIcon, chatBubbleQuestionIcon, toolsIcon } from './ui-icons';

// Keep the full catalog as local assets rather than embedding every SVG in the JS bundle.
const icons = new Map(
  Object.entries(
    import.meta.glob<string>('/node_modules/iconoir/icons/{regular,solid}/*.svg', {
      eager: true,
      exhaustive: true,
      query: '?url&no-inline',
      import: 'default',
    })
  ).map(([path, url]) => {
    const name = path.slice(path.lastIndexOf('/') + 1, -4);
    return [path.includes('/solid/') ? `${name}-solid` : name, url];
  })
);

export function getAgentIcon(agent: Pick<Agent, 'name' | 'options'>): string {
  const icon = agent.options?.icon;
  if (isString(icon) && icon.trim()) {
    return icons.get(icon.trim()) ?? cubeIcon;
  }
  if (agent.name.toLowerCase() === 'build') return toolsIcon;
  if (agent.name.toLowerCase() === 'ask') return chatBubbleQuestionIcon;
  if (agent.name.toLowerCase() === 'plan') return calendarCheckIcon;
  return cubeIcon;
}
