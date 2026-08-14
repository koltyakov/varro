import { formatAgentLabel } from '../../lib/format';
import type { AgentPart } from '../../types';

function AgentIcon(props: { class: string }) {
  return (
    <svg class={props.class} viewBox="0 0 16 16" fill="none" width="12" height="12">
      <path
        d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
      <circle cx="8" cy="8" r="2.75" stroke="currentColor" stroke-width="1.3" />
    </svg>
  );
}

export function AgentChip(props: { part: AgentPart; inline?: boolean; marker?: string }) {
  const label = () => formatAgentLabel(props.part.name);
  const marker = () => props.marker || props.part.source?.value || `@${props.part.name}`;
  return (
    <span
      class={props.inline ? 'inline-chip' : 'message-attachment-chip'}
      data-copy-marker={marker()}
      title={`Agent: ${label()}`}
    >
      <AgentIcon class={props.inline ? 'inline-chip-icon' : 'chip-icon'} />
      <span class={props.inline ? 'inline-chip-label' : 'chip-label'}>{label()}</span>
    </span>
  );
}
