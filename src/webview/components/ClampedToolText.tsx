import { createEffect, createMemo, createSignal, Show } from 'solid-js';
import { type JSX } from '@solidjs/web';
import { postMessage } from '../lib/bridge';
import { codeHighlighter, highlightCode, resolveCodeLanguage } from '../lib/code-highlighter';

/** Logical lines shown before a value is clamped. Deliberately short: the
 *  preview is a glance at the shape of the output, not a place to read it. */
export const CLAMP_LINES = 5;
/** Character ceiling, so one enormous unbroken line still clamps. */
export const CLAMP_CHARS = 1200;

export function countLines(content: string) {
  if (!content) return 0;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return lines.length - (lines.at(-1) === '' ? 1 : 0);
}

/**
 * Drops blank lines from the top and bottom, keeping each remaining line's own
 * indentation. Command output routinely opens and closes with blank lines; if
 * one of those lands on the last visible row the bottom fade has nothing to
 * fade over and the preview looks like it simply stopped.
 */
function trimBlankEdges(text: string) {
  const lines = text.split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === '') start += 1;
  while (end > start && lines[end - 1]?.trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

export function clampToolText(content: string) {
  const normalized = trimBlankEdges(content.replace(/\r\n/g, '\n'));
  const lines = normalized === '' ? [] : normalized.split('\n');
  const lineCount = lines.length;
  const clamped = lineCount > CLAMP_LINES || normalized.length > CLAMP_CHARS;
  if (!clamped) return { clamped: false as const, preview: normalized, lineCount };

  const byLines = lines.slice(0, CLAMP_LINES).join('\n');
  const capped = byLines.length > CLAMP_CHARS ? byLines.slice(0, CLAMP_CHARS) : byLines;
  // Trim again: the slice itself can end on a blank line.
  return { clamped: true as const, preview: trimBlankEdges(capped), lineCount };
}

function openToolText(payload: {
  content: string;
  title: string;
  language?: string;
  view?: 'markdown-preview';
}) {
  postMessage({ type: 'vscode/open-text', payload });
}

/**
 * Renders tool text clamped to a fixed number of lines instead of inside a
 * fixed-height scroll box. Nested scrollers inside the transcript capture the
 * wheel and hide how much content there is; clamping keeps the transcript
 * scrollable in one axis and sends the full text to an editor tab on demand.
 */
export function ClampedToolText(props: {
  id?: string;
  content: string;
  /** Names the editor tab when the full text is opened. */
  title: string;
  language?: string;
  /** Syntax-highlights the preview in `language`. Plain text renders until highlighting lands. */
  highlight?: boolean;
  view?: 'markdown-preview';
  class?: string;
  role?: JSX.HTMLAttributes<HTMLPreElement>['role'];
  'aria-label'?: string;
}) {
  const result = createMemo(() => clampToolText(props.content));
  const highlightLanguage = () => {
    if (!props.highlight) return undefined;
    const language = resolveCodeLanguage(props.language);
    return language === 'plaintext' ? undefined : language;
  };

  // Slicing by logical lines is not enough on its own: one 2000-character line
  // wraps into far more rendered rows than the clamp promises. CSS caps the
  // rendered rows, and this measures whether that cap actually bit.
  const [wrapped, setWrapped] = createSignal(false);
  let preRef: HTMLPreElement | undefined;
  const measure = () => {
    if (preRef) setWrapped(preRef.scrollHeight > preRef.clientHeight + 1);
  };

  createEffect(
    () => props.content,
    () => {
      const cleanups: Array<() => void> = [];

      // Re-measure when the text changes, e.g. streaming output.
      if (!preRef)
        return () => {
          for (const cleanup of cleanups.toReversed()) cleanup();
        };
      measure();
      queueMicrotask(measure);
      if (globalThis.ResizeObserver === undefined)
        return () => {
          for (const cleanup of cleanups.toReversed()) cleanup();
        };
      const observer = new ResizeObserver(measure);
      observer.observe(preRef);
      cleanups.push(() => observer.disconnect());

      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };
    }
  );

  const truncated = () => result().clamped || wrapped();

  const openFull = () => {
    openToolText({
      content: props.content,
      title: props.title,
      language: props.language,
      view: props.view,
    });
  };

  // A click that ends a text selection is the user copying, not asking to open.
  const openUnlessSelecting = () => {
    if (!truncated() || window.getSelection()?.toString()) return;
    openFull();
  };

  // No expand affordance: the bottom fade shows there is more, and the whole
  // block is the click target. A "Show more" line under every clamped value
  // added a row of chrome to say what the fade already says.
  return (
    <pre
      id={props.id}
      ref={(el) => (preRef = el)}

      class={[`${props.class ?? ''} tool-text-clamped`, { 'is-truncated': truncated() }]}
      onClick={openUnlessSelecting}
      title={
        truncated()
          ? props.view === 'markdown-preview'
            ? 'Open full text in Markdown preview'
            : 'Open full text in an editor tab'
          : undefined
      }
      role={props.role}
      aria-label={props['aria-label']}
    >
      <Show when={highlightLanguage()} fallback={result().preview}>
        {(language) => <HighlightedCode text={result().preview} language={language()} />}
      </Show>
    </pre>
  );
}

function HighlightedCode(props: { text: string; language: string }) {
  // oxlint-disable-next-line no-unassigned-vars -- Solid assigns the JSX ref before effects run.
  let element!: HTMLElement;
  createEffect(
    () => ({ text: props.text, language: props.language }),
    ({ text, language }) => {
      const cached = highlightCode(text, language);
      if (cached !== null) {
        element.innerHTML = cached;
        return;
      }
      element.textContent = text;
      // The element and text together own the result, so a stale highlight never lands.
      return codeHighlighter.request(
        text,
        language,
        (html) => {
          if (html !== null && element.isConnected && element.textContent === text)
            element.innerHTML = html;
        },
        1
      );
    }
  );
  return <code ref={element} class="tool-text-highlighted hljs" />;
}
