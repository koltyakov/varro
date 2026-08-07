import { For } from 'solid-js';
import { formatModelName } from '../lib/format';

export function FormattedModelName(props: { name: string }) {
  return (
    <For each={formatModelName(props.name).split(/(⚡)/)}>
      {(part) => (part === '⚡' ? <span title="Fast (more expensive)">{part}</span> : part)}
    </For>
  );
}
