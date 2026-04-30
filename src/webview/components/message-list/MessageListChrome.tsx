import { For } from 'solid-js';
import type { Permission, QuestionRequest } from '../../types';
import { PermissionPrompt } from '../PermissionPrompt';
import { QuestionPrompt } from '../QuestionPrompt';

export type StickyUserMessagePreview = {
  id: string;
  index: number;
  text: string;
};

export function StickyUserMessagePreviewCard(props: { preview: StickyUserMessagePreview }) {
  return (
    <div class="latest-user-message-sticky-wrap" aria-hidden="true">
      <div class="latest-user-message-sticky-overlay">
        <div class="latest-user-message-sticky-top" />
        <div class="latest-user-message-sticky-shell">
          <div class="latest-user-message-sticky">
            <div class="latest-user-message-sticky-text">{props.preview.text}</div>
          </div>
        </div>
        <div class="latest-user-message-sticky-bottom-solid" />
        <div class="latest-user-message-sticky-bottom-fade" />
      </div>
    </div>
  );
}

export function PendingActionRows(props: {
  questions: QuestionRequest[];
  permissions: Permission[];
}) {
  return (
    <>
      <For each={props.questions}>
        {(question) => (
          <div class="interactive-item-container interactive-response">
            <QuestionPrompt request={question} />
          </div>
        )}
      </For>
      <For each={props.permissions}>
        {(permission) => (
          <div class="interactive-item-container interactive-response">
            <PermissionPrompt permission={permission} />
          </div>
        )}
      </For>
    </>
  );
}
