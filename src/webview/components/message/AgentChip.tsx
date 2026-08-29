import { formatAgentLabel } from '../../lib/format';
import type { AgentPart } from '../../types';
import { MaterialChipIcon } from '../MaterialChipIcon';

export function AgentChip(props: { part: AgentPart; inline?: boolean; marker?: string }) {
  const label = () => formatAgentLabel(props.part.name);
  const marker = () => props.marker || props.part.source?.value || `@${props.part.name}`;
  return (
    <span
      class={
        props.inline
          ? 'inline-chip'
          : 'chat-attachment-chip message-attachment-chip agent-attachment-chip'
      }
      data-copy-marker={marker()}
      title={`Agent: ${label()}`}
    >
      <MaterialChipIcon kind="agent" class={props.inline ? 'inline-chip-icon' : 'chip-icon'} />
      <span class={props.inline ? 'inline-chip-label' : 'chip-label'}>{label()}</span>
    </span>
  );
}
