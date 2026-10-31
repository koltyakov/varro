import { For } from 'solid-js';

const INLINE_CODE_PATTERN = /(`[^`\n]+`)/;

/** Renders plain text with single-backtick spans as inline code, without other markdown. */
export function InlineCodeText(props: { text: string }) {
  const segments = () => props.text.split(INLINE_CODE_PATTERN).filter(Boolean);
  return (
    <For each={segments()}>
      {(segment) =>
        segment.length > 2 && segment.startsWith('`') && segment.endsWith('`') ? (
          <code class="inline-code-text">{segment.slice(1, -1)}</code>
        ) : (
          segment
        )
      }
    </For>
  );
}
