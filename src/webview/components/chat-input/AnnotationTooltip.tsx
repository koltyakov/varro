import { Show, type JSX } from 'solid-js';
import type { ChatAnnotation } from '../../../shared/chat-annotation';
import { Tooltip } from '../Tooltip';

export function AnnotationTooltip(props: {
  annotation: ChatAnnotation;
  target?: HTMLElement;
  children?: JSX.Element;
}) {
  return (
    <Tooltip
      target={props.target}
      delay={400}
      content={
        <div class="chat-annotation-tooltip">
          <div class="chat-annotation-tooltip-note">{excerpt(props.annotation.note)}</div>
          <div class="chat-annotation-tooltip-selection">
            <div class="chat-annotation-tooltip-label">Selected text</div>
            <div class="chat-annotation-tooltip-quote">
              {excerpt(props.annotation.selectedText)}
            </div>
          </div>
          <Show when={props.annotation.sourceSessionId}>
            {(sessionId) => (
              <div class="chat-annotation-tooltip-selection">Source session: {sessionId()}</div>
            )}
          </Show>
        </div>
      }
    >
      {props.children}
    </Tooltip>
  );
}

function excerpt(text: string): string {
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
}
