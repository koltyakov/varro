import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { recheckSessionStatus } from '../../hooks/useOpenCode';
import { useSecondClock } from '../../lib/clock';
import { openBackgroundProcessView } from '../../lib/background-process-view';
import { logError } from '../../lib/log';
import { formatMessageSentTime } from '../../lib/message-time';
import { observeSettledResize } from '../../lib/settled-resize-observer';
import { loadingLastActivityAt, loadingStartedAt, state, stopLoading } from '../../lib/state';
import {
  attachmentIcon,
  hourglassIcon,
  mediaImageIcon,
  navArrowUpIcon,
  navArrowDownIcon,
  navArrowRightIcon,
} from '../../lib/ui-icons';
import type { Part, Permission, QuestionRequest } from '../../types';
import { PermissionPrompt } from '../PermissionPrompt';
import { QuestionPrompt } from '../QuestionPrompt';
import { UiIcon } from '../UiIcon';
import { Tooltip } from '../Tooltip';
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
  promptNumber?: number | string;
  promptContinuation?: boolean;
  steering?: boolean;
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
              <span
                class="prompt-number-badge"
                classList={{ 'prompt-number-badge-continuation': props.promptContinuation }}
                aria-hidden="true"
              >
                {promptNumber()}
              </span>
            )}
          </Show>
          <div
            class={`latest-user-message-sticky${props.steering ? ' user-message-steering' : ''}${isClickable() ? ' latest-user-message-sticky-clickable' : ''}${props.loading ? ' is-loading' : ''}`}
            title={props.loading ? 'Loading message' : undefined}
            onMouseEnter={() => notifyUserMessageHoverChange(true)}
            onMouseLeave={() => notifyUserMessageHoverChange(false)}
            on:click={{
              capture: true,
              handleEvent: (event) => {
                // The preview owns navigation, including clicks on nested links and attachments.
                event.preventDefault();
                event.stopPropagation();
                if (!props.loading) props.onClick?.(props.preview);
              },
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
  visibleTurnIds?: ReadonlySet<string>;
  hoveredTurnId?: string | null;
  onTurnHoverChange?: (messageId: string, hovering: boolean) => void;
  loadingTurnId?: string | null;
  onSelect: (turn: StickyUserMessagePreview) => void;
}) {
  let rail: HTMLElement | undefined;
  const [capacity, setCapacity] = createSignal(20);
  const [start, setStart] = createSignal(0);
  const paginated = () => props.turns.length > capacity();
  const windowStart = () => Math.min(start(), Math.max(0, props.turns.length - capacity()));
  const windowTurns = createMemo(() =>
    props.turns.slice(windowStart(), windowStart() + capacity())
  );
  const turnsById = createMemo(() => new Map(props.turns.map((turn) => [turn.id, turn])));
  onMount(() => {
    if (!rail) return;
    const update = () => {
      if (rail!.clientHeight > 0)
        setCapacity(Math.max(1, Math.floor((rail!.clientHeight - 40) / 11)));
    };
    update();
    const stop = observeSettledResize(rail, update);
    const element = rail;
    let wheelRemainder = 0;
    const handleWheel = (event: WheelEvent) => {
      if (!paginated() || event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 11 : event.deltaMode === 2 ? capacity() * 11 : 1);
      if (Math.sign(delta) !== Math.sign(wheelRemainder)) wheelRemainder = 0;
      wheelRemainder += delta;
      const steps = Math.trunc(wheelRemainder / 11);
      wheelRemainder -= steps * 11;
      const next = Math.max(0, Math.min(props.turns.length - capacity(), windowStart() + steps));
      setStart(next);
      if ((next === 0 && delta < 0) || (next === props.turns.length - capacity() && delta > 0))
        wheelRemainder = 0;
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    onCleanup(() => {
      stop();
      element.removeEventListener('wheel', handleWheel);
    });
  });
  // Preview refreshes and equivalent visibility sets must not undo manual paging.
  const viewportTurns = createMemo(
    () => {
      const activeIndex = props.turns.findIndex((turn) => turn.id === props.activeTurnId);
      const visibleIndexes = props.turns.flatMap((turn, index) =>
        props.visibleTurnIds?.has(turn.id) ? [index] : []
      );
      return {
        count: props.turns.length,
        size: capacity(),
        firstVisible: visibleIndexes[0] ?? activeIndex,
        lastVisible: visibleIndexes.at(-1) ?? activeIndex,
      };
    },
    { count: 0, size: 0, firstVisible: -1, lastVisible: -1 },
    {
      equals: (previous, next) =>
        previous.count === next.count &&
        previous.size === next.size &&
        previous.firstVisible === next.firstVisible &&
        previous.lastVisible === next.lastVisible,
    }
  );
  createEffect(() => {
    const { count, size, firstVisible, lastVisible } = viewportTurns();
    setStart((previous) => {
      const bounded = Math.min(previous, Math.max(0, count - size));
      if (firstVisible < 0 || (firstVisible >= bounded && lastVisible < bounded + size))
        return bounded;
      return Math.max(
        0,
        Math.min(
          firstVisible - Math.max(0, Math.floor((size - (lastVisible - firstVisible + 1)) / 2)),
          count - size
        )
      );
    });
  });
  return (
    <nav
      ref={(element) => {
        rail = element;
      }}
      class="turn-navigation"
      aria-label="Conversation turns"
      style={{ '--turn-count': props.turns.length }}
    >
      <Show when={paginated()}>
        <button
          type="button"
          class="turn-navigation-page"
          aria-label="Earlier turns"
          disabled={windowStart() === 0}
          onClick={() => setStart(Math.max(0, windowStart() - capacity() + 1))}
        >
          <UiIcon source={navArrowUpIcon} width="12" height="12" aria-hidden="true" />
        </button>
      </Show>
      <For each={windowTurns().map((turn) => turn.id)}>
        {(id, index) => {
          const initialTurn = turnsById().get(id)!;
          const turn = () => turnsById().get(id) ?? initialTurn;
          const sentTimestamp = createMemo(() => {
            const sentAt = turn().sentAt;
            return sentAt === undefined ? null : formatMessageSentTime(sentAt);
          });
          const active = () => id === props.activeTurnId;
          const highlighted = () => props.visibleTurnIds?.has(id) || active();
          const loading = () => id === props.loadingTurnId;
          let pointerOver = false;
          let ownsHover = false;
          const notifyHover = (hovering: boolean) => {
            ownsHover = hovering;
            props.onTurnHoverChange?.(id, hovering);
          };
          onCleanup(() => {
            if (ownsHover) props.onTurnHoverChange?.(id, false);
          });
          // Highlight changes rerun the marker's attributes; keep the prompt scan out of that path.
          const label = createMemo(() => {
            const preview = turn();
            if (preview.format) {
              const format = `${preview.format.kind.toUpperCase()} content`;
              return preview.formatPrefix ? `${preview.formatPrefix} ${format}` : format;
            }
            const text = preview.text.replaceAll(/\s+/g, ' ').trim();
            return text.length > 80 ? `${text.slice(0, 77)}...` : text;
          });
          return (
            <Tooltip
              placement="right"
              delay={150}
              content={
                <>
                  <div>{`Turn ${windowStart() + index() + 1} of ${props.turns.length}`}</div>
                  <div class="turn-navigation-tooltip-prompt">{label()}</div>
                  <Show when={sentTimestamp()}>
                    {(timestamp) => <div class="turn-navigation-tooltip-time">{timestamp()}</div>}
                  </Show>
                </>
              }
            >
              <button
                type="button"
                class={`turn-navigation-marker${highlighted() ? ' is-active' : ''}${props.hoveredTurnId === id ? ' is-hovered' : ''}${
                  loading() ? ' is-loading' : ''
                }`}
                aria-label={`Go to turn ${windowStart() + index() + 1}: ${label()}`}
                aria-current={active() ? 'step' : undefined}
                onMouseEnter={() => {
                  pointerOver = true;
                  notifyHover(true);
                }}
                onMouseLeave={() => {
                  pointerOver = false;
                  notifyHover(false);
                }}
                onFocus={() => notifyHover(true)}
                onBlur={() => {
                  if (!pointerOver) notifyHover(false);
                }}
                disabled={loading()}
                onClick={() => props.onSelect(turn())}
              />
            </Tooltip>
          );
        }}
      </For>
      <Show when={paginated()}>
        <button
          type="button"
          class="turn-navigation-page"
          aria-label="Later turns"
          disabled={windowStart() + capacity() >= props.turns.length}
          onClick={() =>
            setStart(Math.min(props.turns.length - capacity(), windowStart() + capacity() - 1))
          }
        >
          <UiIcon source={navArrowDownIcon} width="12" height="12" aria-hidden="true" />
        </button>
      </Show>
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

export function LoadingRow(props: {
  compacting: boolean;
  visible: boolean;
  waiting?: boolean;
  toolsRunning?: boolean;
  waitingStartedAt?: number;
  waitingCommand?: string;
  turnStartedAt?: number;
  elapsedStartedAt?: number;
}) {
  // A reserved, hidden row shows no elapsed time or stale state.
  const now = useSecondClock(() => props.visible);
  // oxlint-disable-next-line no-unassigned-vars
  let row: HTMLDivElement | undefined;
  const [hasPrecedingToolDuration, setHasPrecedingToolDuration] = createSignal(false);
  onMount(() => {
    createEffect(() => {
      if (
        !props.visible ||
        !props.toolsRunning ||
        props.waiting ||
        props.compacting ||
        !row?.parentElement
      ) {
        setHasPrecedingToolDuration(false);
        return;
      }
      const observer = new MutationObserver(() => update());
      const update = () => {
        observer.disconnect();
        if (row?.parentElement) observer.observe(row.parentElement, { childList: true });
        let previous = row?.previousElementSibling;
        while (previous) {
          observer.observe(previous, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'title'],
          });
          if (previous.textContent?.trim()) break;
          previous = previous.previousElementSibling;
        }
        const items = previous?.querySelectorAll<HTMLElement>(
          '[data-assistant-render-key]:not(.assistant-message-flow-item-hidden)'
        );
        const item = items?.[items.length - 1];
        const activities = item?.querySelectorAll(
          '.assistant-active-activity-item, .assistant-activity-detail'
        );
        const lastContent = activities?.length ? activities[activities.length - 1] : item;
        const tools = lastContent?.querySelectorAll('.chat-tool-invocation-part');
        const tool = tools?.[tools.length - 1];
        setHasPrecedingToolDuration(
          !!tool
            ?.querySelector(
              '.tool-invocation-header .tool-invocation-duration[title="Elapsed time"]'
            )
            ?.textContent?.trim()
        );
      };
      // Read the painted tool label, including preview rotation and task activity overrides.
      update();
      onCleanup(() => observer.disconnect());
    });
  });
  const waiting = () => props.waiting && !props.compacting;
  const waitingClock = createMemo<{
    sessionId: string | null;
    startedAt: number;
    command?: string;
  } | null>((previous) => {
    if (!waiting()) return null;
    const sessionId = state.activeSessionId;
    return {
      sessionId,
      startedAt:
        props.waitingStartedAt ??
        (previous?.sessionId === sessionId ? previous.startedAt : Date.now()),
      command:
        props.waitingCommand ?? (previous?.sessionId === sessionId ? previous.command : undefined),
    };
  }, null);

  const isStale = () => {
    if (props.waiting) return false;
    const currentNow = now();
    const startedAt = loadingStartedAt();
    if (startedAt === null || currentNow - startedAt < STALE_LOADING_TOTAL_MS) return false;
    const lastActivity = loadingLastActivityAt() ?? startedAt;
    return currentNow - lastActivity >= STALE_LOADING_INACTIVITY_MS;
  };

  const totalElapsedMs = () => {
    const startedAt = waiting()
      ? (waitingClock()?.startedAt ?? null)
      : (props.elapsedStartedAt ?? loadingStartedAt());
    return startedAt === null ? 0 : Math.max(0, now() - startedAt);
  };
  const elapsedSeconds = () => Math.floor(totalElapsedMs() / 1000);
  // Completions reset the elapsed label, not the turn's verb cycle or initial delay.
  const turnElapsedSeconds = () => {
    const startedAt = props.turnStartedAt ?? loadingStartedAt() ?? props.elapsedStartedAt;
    return startedAt == null ? 0 : Math.floor(Math.max(0, now() - startedAt) / 1000);
  };
  const verb = () => LOADING_VERBS[Math.floor(turnElapsedSeconds() / 6) % LOADING_VERBS.length];
  const formatElapsed = () => {
    const seconds = elapsedSeconds();
    if (turnElapsedSeconds() < 1 && !waiting()) return null;
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
  const visibleElapsed = () =>
    props.toolsRunning && !props.compacting && hasPrecedingToolDuration() ? null : formatElapsed();

  return (
    <div
      ref={row}
      class={`interactive-item-container interactive-response interactive-loading-row${
        props.visible ? '' : ' is-reserved'
      }${waiting() ? ' is-background-waiting' : ''}`}
      aria-hidden={props.visible ? undefined : true}
    >
      <Show
        when={waiting()}
        fallback={
          <div
            class={`loading-indicator ${isStale() ? 'stale' : ''} ${props.compacting ? 'is-compacting' : ''}`}
          >
            <Show
              when={!props.compacting && isStale()}
              fallback={
                <span class="shimmer-progress loading-verb">
                  {props.compacting ? 'Compacting' : verb()}
                  <span class="chat-animated-ellipsis" />
                </span>
              }
            >
              <span>Session may be stale</span>
            </Show>
            <Show when={visibleElapsed()}>
              <span class="loading-elapsed" title="Time since the last completed event">
                {visibleElapsed()}
              </span>
            </Show>
            <Show when={isStale()}>
              <button
                class="loading-action"
                onClick={() => {
                  const sessionId = state.activeSessionId;
                  if (!sessionId) return;
                  void recheckSessionStatus(sessionId).catch((err) =>
                    logError('Failed to recheck session status', err)
                  );
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
        }
      >
        <div
          class="chat-tool-invocation-part background-process"
          role="status"
          aria-label="Background process running"
          aria-live="off"
        >
          <button
            type="button"
            class="tool-invocation-header"
            aria-label="View background process details"
            aria-haspopup="dialog"
            title="View commands, status, and output"
            onClick={() => {
              const sessionID = state.activeSessionId;
              if (sessionID)
                openBackgroundProcessView(
                  sessionID,
                  state.sessions.find((session) => session.id === sessionID)?.directory
                );
            }}
          >
            <UiIcon
              source={hourglassIcon}
              class="tool-call-icon tool-call-wait-icon tool-status-running"
              width="16"
              height="16"
              aria-hidden="true"
            />
            <span class="tool-invocation-title shimmer-progress" title={waitingClock()?.command}>
              Background process
              <Show when={waitingClock()?.command}>{(command) => <>: {command()}</>}</Show>
            </span>
            <span class="tool-invocation-duration" title="Background process elapsed time">
              {formatElapsed()}
            </span>
            <UiIcon source={navArrowRightIcon} width="14" height="14" aria-hidden="true" />
          </button>
        </div>
      </Show>
    </div>
  );
}
