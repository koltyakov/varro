import { For, Show, createMemo } from 'solid-js';
import type { JSX } from 'solid-js';
import { parseIssueAttachment } from '../lib/editor-problems';
import { Tooltip } from './Tooltip';

export function ProblemsTooltip(props: {
  text: string | null;
  action: string;
  children?: JSX.Element;
  target?: HTMLElement;
}) {
  const highlights = createMemo(() => getHighlights(props.text ?? ''));
  return (
    <Tooltip
      target={props.target}
      delay={400}
      content={
        <div class="problems-tooltip-content">
          <strong>{highlights().summary}</strong>
          <For each={highlights().items}>
            {(item) => (
              <div class="problems-tooltip-item">
                <div class="problems-tooltip-location">
                  <span class={`problems-tooltip-severity ${item.severity.toLowerCase()}`}>
                    {item.severity}
                  </span>
                  <Show when={item.selected}>
                    <span>In selection</span>
                  </Show>
                </div>
                <div class="problems-tooltip-location">{item.location}</div>
                <div class="problems-tooltip-message">{item.message}</div>
              </div>
            )}
          </For>
          <Show when={highlights().omitted > 0}>
            <div class="problems-tooltip-note">{highlights().omitted} more problems</div>
          </Show>
          <div class="problems-tooltip-note">{props.action}</div>
        </div>
      }
    >
      {props.children}
    </Tooltip>
  );
}

/** Read the same bounded snapshot that is sent, including older explicit attachments. */
function getHighlights(text: string) {
  const counts = text.match(/^\[VS Code problems for [^\n]+: (\d+) errors, (\d+) warnings\]\n/);
  const total = parseIssueAttachment(text)?.count ?? 0;
  const summary = counts
    ? `${counts[1]} ${counts[1] === '1' ? 'error' : 'errors'}, ${counts[2]} ${counts[2] === '1' ? 'warning' : 'warnings'}`
    : `Problems ${total}`;
  const items = text
    .split(/\n(?=(?:ERROR|WARNING|INFO) )/)
    .slice(1, 4)
    .map((block) => {
      const [heading = '', ...lines] = block.split('\n');
      const severity = heading.split(' ')[0]!;
      const inlineMessage = heading.indexOf(' - ');
      const selected = heading.endsWith(' [intersects selection]');
      const location = (inlineMessage >= 0 ? heading.slice(0, inlineMessage) : heading)
        .slice(severity.length + 1)
        .replace(/ \[intersects selection\]$/, '');
      const message =
        inlineMessage >= 0
          ? heading.slice(inlineMessage + 3)
          : lines
              .join('\n')
              .split('\n  Related:')[0]!
              .replace(/\n\d+ additional problems omitted\.$/, '')
              .trim();
      return {
        severity,
        selected,
        location: shorten(location, 180),
        message: shorten(message, 300),
      };
    });
  return { summary, items, omitted: Math.max(0, total - items.length) };
}

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
