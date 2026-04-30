import type { CompactionPart } from '../../types';

export function CompactionDivider(props: { part: CompactionPart }) {
  const label = () => {
    const kind = props.part.auto ? 'auto' : 'manual';
    return props.part.overflow
      ? `Context compacted (${kind}, after overflow)`
      : `Context compacted (${kind})`;
  };
  return (
    <div class="message-compaction-divider">
      <span class="message-compaction-label">{label()}</span>
    </div>
  );
}
