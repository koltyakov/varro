import type { CompactionPart } from '../../types';

export function CompactionDivider(props: { part: CompactionPart }) {
  const label = () => {
    const kind = props.part.auto ? 'auto' : 'manual';
    return props.part.overflow
      ? `Context compacted (${kind}, after overflow)`
      : `Context compacted (${kind})`;
  };
  return (
    <div class="model-change-indicator assistant-dialog-summary message-compaction-divider">
      <div class="assistant-dialog-summary-content">
        <span class="model-change-label">{label()}</span>
      </div>
    </div>
  );
}
