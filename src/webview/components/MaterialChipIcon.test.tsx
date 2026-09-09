import { describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import {
  MaterialChipIcon,
  createMaterialChipIconElement,
  getMaterialChipIcon,
} from './MaterialChipIcon';

describe('MaterialChipIcon', () => {
  it('provides distinct Material assets for each chip kind', () => {
    const icons = (
      ['agent', 'skill', 'terminal', 'image', 'session', 'external-link'] as const
    ).map(getMaterialChipIcon);
    expect(new Set(icons).size).toBe(6);
  });

  it('renders decorative images for Solid and DOM callers', () => {
    const container = document.createElement('div');
    const cleanup = render(() => <MaterialChipIcon kind="terminal" class="chip-icon" />, container);
    const domIcon = createMaterialChipIconElement('session', 'session-reference-icon');

    expect(container.querySelector('.material-chip-icon')).toBeInstanceOf(HTMLImageElement);
    expect(domIcon.classList).toContain('session-reference-icon');
    expect(domIcon.getAttribute('aria-hidden')).toBe('true');
    const agentIcon = createMaterialChipIconElement('agent', 'completion-agent-icon');
    expect(agentIcon).toBeInstanceOf(HTMLImageElement);
    expect(agentIcon.getAttribute('src')).toBe(getMaterialChipIcon('agent'));
    cleanup();
  });
});
