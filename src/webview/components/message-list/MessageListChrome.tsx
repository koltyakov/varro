import { For, Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import { recheckSessionStatus } from '../../hooks/useOpenCode';
import { formatMessageSentTime } from '../../lib/message-time';
import { observeSettledResize } from '../../lib/settled-resize-observer';
import { loadingLastActivityAt, loadingStartedAt, state, stopLoading } from '../../lib/state';
import { attachmentIcon, mediaImageIcon } from '../../lib/ui-icons';
import type { Part, Permission, QuestionRequest } from '../../types';
import { PermissionPrompt } from '../PermissionPrompt';
import { QuestionPrompt } from '../QuestionPrompt';
import { UiIcon } from '../UiIcon';
import {
  UserMessagePreviewContent,
  formatUserMessageMarkupSize,
} from '../message/UserMessageContent';
import type { StickyUserMessagePreview } from './sticky-preview';

const STALE_LOADING_TOTAL_MS = 90_000;
const STALE_LOADING_INACTIVITY_MS = 60_000;
const HOVER_INTENT_DELAY_MS = 300;
const LOADING_VERBS = [
  'Thinking',
  'Analyzing',
  'Considering',
  'Pondering',
  'Musing',
  'Reasoning',
  'Evaluating',
  'Deliberating',
  'Reflecting',
  'Processing',
  'Synthesizing',
  'Formulating',
  'Examining',
  'Interpreting',
  'Inferring',
  'Deducing',
  'Contemplating',
  'Investigating',
  'Deciphering',
  'Integrating',
  'Discerning',
  'Ideating',
  'Refining',
  'Cogitating',
  'Computing',
  'Brainstorming',
  'Percolating',
  'Unraveling',
  'Calculating',
];

function bindStickyTextOverflowFade(
  text: HTMLElement,
  trackText: () => string,
  onGeometryChange?: () => void
) {
  const update = () => {
    const hasMoreBelow = text.scrollTop + text.clientHeight < text.scrollHeight - 1;
    text.parentElement?.classList.toggle('has-more-below', hasMoreBelow);
  };
  const updateAfterResize = () => {
    update();
    onGeometryChange?.();
  };

  text.addEventListener('scroll', update, { passive: true });
  const stopObservingResize = observeSettledResize(text, updateAfterResize);
  createEffect(() => {
    trackText();
    queueMicrotask(update);
  });
  onCleanup(() => {
    text.removeEventListener('scroll', update);
    stopObservingResize();
  });
}

export function StickyUserMessagePreviewCard(props: {
  preview: StickyUserMessagePreview;
  parts?: Part[];
  promptNumber?: number;
  sentAt?: number;
  showSentTimestamp?: boolean;
  suppressTimestampAnimation?: boolean;
  onClick?: (preview: StickyUserMessagePreview) => void;
  loading?: boolean;
  onGeometryChange?: () => void;
  onUserMessageHoverChange?: (messageId: string, hovering: boolean) => void;
}) {
  const isClickable = () => !!props.onClick;
  const onUserMessageHoverChange = props.onUserMessageHoverChange;
  let hoveredMessageId: string | null = null;
  let hoverIntentTimer: ReturnType<typeof setTimeout> | undefined;
  const [isHoverIntentActive, setIsHoverIntentActive] = createSignal(false);
  const timestampVisible = () => !!props.showSentTimestamp || isHoverIntentActive();
  const notifyUserMessageHoverChange = (hovering: boolean) => {
    if (hoverIntentTimer) {
      clearTimeout(hoverIntentTimer);
      hoverIntentTimer = undefined;
    }
    if (!hovering) {
      setIsHoverIntentActive(false);
      if (hoveredMessageId) {
        onUserMessageHoverChange?.(hoveredMessageId, false);
        hoveredMessageId = null;
      }
      return;
    }
    const messageId = props.preview.id;
    hoverIntentTimer = setTimeout(() => {
      hoverIntentTimer = undefined;
      hoveredMessageId = messageId;
      setIsHoverIntentActive(true);
      onUserMessageHoverChange?.(messageId, true);
    }, HOVER_INTENT_DELAY_MS);
  };
  onCleanup(() => {
    if (hoverIntentTimer) clearTimeout(hoverIntentTimer);
    if (hoveredMessageId) onUserMessageHoverChange?.(hoveredMessageId, false);
  });
  const sentTimestamp = createMemo(() =>
    props.sentAt === undefined ? null : formatMessageSentTime(props.sentAt)
  );

  return (
    <div class="latest-user-message-sticky-wrap" aria-hidden="true">
      <div class="latest-user-message-sticky-overlay" data-sticky-msg-id={props.preview.id}>
        <div class="latest-user-message-sticky-top" />
        <div class="latest-user-message-sticky-shell">
          <Show when={props.promptNumber}>
            {(promptNumber) => (
              <span class="prompt-number-badge" aria-hidden="true">
                {promptNumber()}
              </span>
            )}
          </Show>
          <div
            class={`latest-user-message-sticky${isClickable() ? ' latest-user-message-sticky-clickable' : ''}${props.loading ? ' is-loading' : ''}`}
            title={props.loading ? 'Loading message' : undefined}
            onMouseEnter={() => notifyUserMessageHoverChange(true)}
            onMouseLeave={() => notifyUserMessageHoverChange(false)}
            onClick={(event) => {
              event.preventDefault();
              if (!props.loading) props.onClick?.(props.preview);
            }}
          >
            <div class="latest-user-message-sticky-text-clip">
              <div
                class={`latest-user-message-sticky-text${props.parts ? ' rendered-markdown' : ''}`}
                ref={(text) =>
                  bindStickyTextOverflowFade(text, () => props.preview.text, props.onGeometryChange)
                }
              >
                <Show
                  when={props.parts}
                  fallback={
                    <Show when={props.preview.format} fallback={props.preview.text}>
                      {(format) => (
                        <>
                          <Show when={props.preview.formatPrefix}>
                            {(prefix) => <span>{prefix()} </span>}
                          </Show>
                          <span
                            class="latest-user-message-format-chip"
                            title={`${format().kind.toUpperCase()} content`}
                          >
                            <span>{format().kind.toUpperCase()}</span>
                            <span class="latest-user-message-format-detail">
                              {formatUserMessageMarkupSize(format().byteSize)}
                            </span>
                          </span>
                        </>
                      )}
                    </Show>
                  }
                >
                  {(parts) => (
                    <UserMessagePreviewContent
                      parts={parts()}
                      fallback={props.preview.text}
                      onOpenImagePreview={() => {
                        if (!props.loading) props.onClick?.(props.preview);
                      }}
                    />
                  )}
                </Show>
              </div>
            </div>
            <Show when={props.loading}>
              <div class="latest-user-message-sticky-loading">
                <span class="latest-user-message-sticky-spinner" aria-hidden="true" />
              </div>
            </Show>
            <Show when={props.preview.attachmentCount > 0 || props.preview.imageCount > 0}>
              <div class="latest-user-message-sticky-meta" aria-hidden="true">
                <Show when={props.preview.imageCount > 0}>
                  <span class="latest-user-message-sticky-meta-item" title="Images">
                    <UiIcon source={mediaImageIcon} width="12" height="12" />
                    <span>{props.preview.imageCount}</span>
                  </span>
                </Show>
                <Show when={props.preview.attachmentCount > 0}>
                  <span class="latest-user-message-sticky-meta-item" title="Attachments">
                    <UiIcon source={attachmentIcon} width="12" height="12" />
                    <span>{props.preview.attachmentCount}</span>
                  </span>
                </Show>
              </div>
            </Show>
          </div>
          <Show when={sentTimestamp()}>
            {(timestamp) => (
              <time
                class={`message-sent-time latest-user-message-sticky-time${timestampVisible() ? ' is-visible' : ''}${props.suppressTimestampAnimation ? ' is-animation-suppressed' : ''}`}
                dateTime={new Date(props.sentAt!).toISOString()}
              >
                {timestamp()}
              </time>
            )}
          </Show>
        </div>
        <div class="latest-user-message-sticky-bottom-solid" />
        <div class="latest-user-message-sticky-bottom-fade" />
      </div>
    </div>
  );
}

export function TurnNavigationRail(props: {
  turns: readonly StickyUserMessagePreview[];
  activeTurnId: string | null;
  loadingTurnId?: string | null;
  onSelect: (turn: StickyUserMessagePreview) => void;
}) {
  return (
    <nav class="turn-navigation" aria-label="Conversation turns">
      <For each={props.turns}>
        {(turn, index) => {
          const active = () => turn.id === props.activeTurnId;
          const loading = () => turn.id === props.loadingTurnId;
          const label = () => {
            if (turn.format) {
              const format = `${turn.format.kind.toUpperCase()} content`;
              return turn.formatPrefix ? `${turn.formatPrefix} ${format}` : format;
            }
            const text = turn.text.replaceAll(/\s+/g, ' ').trim();
            return text.length > 80 ? `${text.slice(0, 77)}...` : text;
          };
          return (
            <button
              type="button"
              class={`turn-navigation-marker${active() ? ' is-active' : ''}${
                loading() ? ' is-loading' : ''
              }`}
              aria-label={`Go to turn ${index() + 1}: ${label()}`}
              aria-current={active() ? 'step' : undefined}
              title={`Turn ${index() + 1}: ${label()}`}
              disabled={loading()}
              onClick={() => props.onSelect(turn)}
            />
          );
        }}
      </For>
    </nav>
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
  permissionPosition?: number;
  permissionTotal?: number;
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
      <Show when={props.permissions[0]}>
        {(permission) => (
          <div class="interactive-item-container interactive-response">
            <PermissionPrompt
              permission={permission()}
              queuePosition={props.permissionPosition}
              queueTotal={props.permissionTotal}
            />
          </div>
        )}
      </Show>
    </>
  );
}

export function LoadingRow(props: { compacting: boolean; visible: boolean }) {
  const [now, setNow] = createSignal(Date.now());

  const isStale = () => {
    const currentNow = now();
    const startedAt = loadingStartedAt();
    if (startedAt === null || currentNow - startedAt < STALE_LOADING_TOTAL_MS) return false;
    const lastActivity = loadingLastActivityAt() ?? startedAt;
    return currentNow - lastActivity >= STALE_LOADING_INACTIVITY_MS;
  };

  const timer = setInterval(() => {
    setNow(Date.now());
  }, 1000);
  onCleanup(() => clearInterval(timer));

  const totalElapsedMs = () => {
    const startedAt = loadingStartedAt();
    return startedAt === null ? 0 : Math.max(0, now() - startedAt);
  };
  const elapsedSeconds = () => Math.floor(totalElapsedMs() / 1000);
  const verb = () => LOADING_VERBS[Math.floor(elapsedSeconds() / 6) % LOADING_VERBS.length];
  const formatElapsed = () => {
    const seconds = elapsedSeconds();
    if (seconds < 10) return null;
    if (seconds < 60) return `${seconds}s`;
    if (seconds >= 60 * 60) {
      const hours = Math.floor(seconds / (60 * 60));
      const minutes = Math.floor((seconds % (60 * 60)) / 60);
      return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}m ${remainder.toString().padStart(2, '0')}s`;
  };

  return (
    <div
      class={`interactive-item-container interactive-response interactive-loading-row${
        props.visible ? '' : ' is-reserved'
      }`}
      aria-hidden={props.visible ? undefined : true}
    >
      <div
        class={`loading-indicator ${isStale() ? 'stale' : ''} ${props.compacting ? 'is-compacting' : ''}`}
      >
        <Show
          when={!props.compacting && isStale()}
          fallback={
            <Show
              when={props.compacting}
              fallback={
                <span class="shimmer-progress loading-verb">
                  {verb()}
                  <span class="chat-animated-ellipsis" />
                </span>
              }
            >
              <span class="loading-verb">Compacting conversation context…</span>
            </Show>
          }
        >
          <span>Session may be stale</span>
        </Show>
        <Show when={formatElapsed()}>
          <span class="loading-elapsed">{formatElapsed()}</span>
        </Show>
        <Show when={isStale()}>
          <button
            class="loading-action"
            onClick={() => {
              if (state.activeSessionId) recheckSessionStatus(state.activeSessionId);
            }}
            title="Check if session is still running"
          >
            Recheck
          </button>
          <button
            class="loading-action"
            onClick={() => stopLoading()}
            title="Dismiss loading indicator"
          >
            Dismiss
          </button>
        </Show>
      </div>
    </div>
  );
}
