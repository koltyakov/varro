import { For, Show } from 'solid-js';
import type { Permission, QuestionRequest } from '../../types';
import { PermissionPrompt } from '../PermissionPrompt';
import { QuestionPrompt } from '../QuestionPrompt';

export type StickyUserMessagePreview = {
  id: string;
  index: number;
  text: string;
  attachmentCount: number;
  imageCount: number;
};

export function StickyUserMessagePreviewCard(props: {
  preview: StickyUserMessagePreview;
  onEdit?: (preview: StickyUserMessagePreview) => void;
  onClick?: (preview: StickyUserMessagePreview) => void;
  title?: string;
}) {
  const onClick = () => props.onClick ?? props.onEdit;
  const title = () => props.title ?? (props.onEdit ? 'Click to edit message' : undefined);

  return (
    <div class="latest-user-message-sticky-wrap" aria-hidden="true">
      <div class="latest-user-message-sticky-overlay">
        <div class="latest-user-message-sticky-top" />
        <div class="latest-user-message-sticky-shell">
          <div
            class={`latest-user-message-sticky${onClick() ? ' latest-user-message-sticky-clickable' : ''}`}
            title={title()}
            onClick={() => onClick()?.(props.preview)}
          >
            <div class="latest-user-message-sticky-text">{props.preview.text}</div>
            <Show
              when={props.preview.attachmentCount > 0 || props.preview.imageCount > 0}
            >
              <div class="latest-user-message-sticky-meta" aria-hidden="true">
                <Show when={props.preview.imageCount > 0}>
                  <span class="latest-user-message-sticky-meta-item" title="Images">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <rect x="2" y="3" width="12" height="10" rx="1.5" />
                      <circle cx="5.5" cy="6.5" r="1" />
                      <path d="M3 11l3-3 2.5 2.5L11 7l2 2" />
                    </svg>
                    <span>{props.preview.imageCount}</span>
                  </span>
                </Show>
                <Show when={props.preview.attachmentCount > 0}>
                  <span class="latest-user-message-sticky-meta-item" title="Attachments">
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="M10.5 5.5l-4.24 4.24a2 2 0 102.83 2.83l4.6-4.59a3 3 0 00-4.24-4.24L4.5 8.69a4 4 0 105.66 5.66l4.1-4.1" />
                    </svg>
                    <span>{props.preview.attachmentCount}</span>
                  </span>
                </Show>
              </div>
            </Show>
          </div>
        </div>
        <div class="latest-user-message-sticky-bottom-solid" />
        <div class="latest-user-message-sticky-bottom-fade" />
      </div>
    </div>
  );
}

export function ChatContentBottomFade() {
  return (
    <div class="interactive-list-bottom-fade-wrap" aria-hidden="true">
      <div class="interactive-list-bottom-fade-overlay">
        <div class="interactive-list-bottom-fade-gradient" />
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
