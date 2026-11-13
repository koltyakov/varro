import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import type {
  FollowupAction,
  FollowupSource,
  FollowupSuggestionSet,
} from '../../../shared/followups';
import {
  parseFollowupSuggestions,
  parseFollowupSource,
  readFollowupText,
} from '../../../shared/followups';
import { client } from '../../lib/client';
import type { ChatModelSelection } from '../../../shared/protocol';
import { logWarn } from '../../lib/log';
import {
  enqueueMessage,
  getSelectedModelForSession,
  isSessionStatusWorking,
  state,
} from '../../lib/state';
import { deriveSelectedModelFromSession } from '../../hooks/routing-state';
import { prepareForMessageBlockRemoval } from '../../lib/message-list-layout';
import { writeClipboard } from '../../lib/write-clipboard';
import { rememberDirectSessionReturn } from '../../lib/session-navigation';
import { forkSession, renameSession, selectSession, sendMessage } from '../../hooks/useOpenCode';
import { checkIcon, xmarkIcon } from '../../lib/ui-icons';
import { InlineCodeText } from '../InlineCodeText';
import { UiIcon } from '../UiIcon';
import { Tooltip } from '../Tooltip';
import { FollowupActionsMenu } from './FollowupActionsMenu';

type ReadyFollowups = FollowupSuggestionSet & {
  key: string;
  source: FollowupSource;
  sessionId: string;
  directory?: string;
};

const INITIAL_CACHE_LOOKUP_TIMEOUT_MS = 2_000;

/** One observer for the latest live turn, outside virtualized message rows. */
export function FollowupSuggestions(props: {
  finalMessageId: string | null;
  turnId: string | null;
  working: boolean;
  blocked: boolean;
  onRestoreStart?: () => (() => void) | undefined;
}) {
  const [ready, setReady] = createSignal<ReadyFollowups | null>(null);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [menu, setMenu] = createSignal<{
    action: FollowupAction;
    x: number;
    y: number;
  } | null>(null);
  // oxlint-disable-next-line no-unassigned-vars -- Assigned by Solid's ref binding.
  let element: HTMLDivElement | undefined;
  let previousScope = '';
  let armedTurn: string | null = null;
  let historicalAssistantIds = new Set<string>();
  let historicalUserIds = new Set<string>();
  let sendPending = false;
  const attempted = new Set<string>();
  // The parent turn projection also changes for unrelated assistant metadata updates.
  const turnId = createMemo(() => props.turnId);
  const sessionModel = createMemo<ChatModelSelection | null>(() => {
    if (state.followupModel) return null;
    const model =
      getSelectedModelForSession(state.activeSessionId) ??
      state.selectedModel ??
      deriveSelectedModelFromSession(
        state.sessions.find((session) => session.id === state.activeSessionId)
      );
    return model
      ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
      : null;
  });
  const scope = createMemo(() =>
    JSON.stringify([
      state.activeSessionId,
      state.editorContext.workspacePath,
      state.sessions.find((session) => session.id === state.activeSessionId)?.directory,
      state.serverStatus.state,
      state.serverStatus.state === 'running' ? state.serverStatus.url : null,
      state.followupModel,
      state.followupsEnabled,
      sessionModel(),
    ])
  );
  const sourceKey = createMemo(() => {
    if (
      !state.followupsEnabled ||
      (!state.followupModel && !sessionModel()) ||
      state.serverStatus.state !== 'running' ||
      state.serverStatus.apiVersion !== 2 ||
      props.blocked ||
      props.working ||
      !props.finalMessageId ||
      state.messagesLoading
    )
      return '';
    const answer = state.messages.find((entry) => entry.info.id === props.finalMessageId);
    if (
      !answer ||
      answer.info.role !== 'assistant' ||
      answer.info.error ||
      answer.info.retry ||
      (answer.info.agent || answer.info.mode) !== 'build' ||
      answer.info.sessionID !== state.activeSessionId
    )
      return '';
    const userMessageId = answer.info.parentID;
    const user = state.messages.find((entry) => entry.info.id === userMessageId);
    if (!user || user.info.role !== 'user') return '';
    const source = parseFollowupSource({
      assistantMessageId: answer.info.id,
      userMessageId: user.info.id,
      userPrompt: readFollowupText(user.parts),
      answer: readFollowupText(answer.parts),
    });
    return source ? JSON.stringify(source) : '';
  });
  const observedMessages = createMemo(() => {
    if (!props.working && !state.messagesLoading) return '';
    return JSON.stringify(
      state.messages.map(({ info }) =>
        info.role === 'assistant'
          ? [info.id, info.parentID, info.time.completed, info.finish]
          : [info.id]
      )
    );
  });

  function clear() {
    if (element?.isConnected) prepareForMessageBlockRemoval(element);
    setError('');
    setMenu(null);
    setReady(null);
  }

  function persistDismissal(value: ReadyFollowups) {
    void client.varro.dismissFollowups(value.sessionId, value.source, value.directory).catch(() => {
      logWarn('Could not persist follow-up dismissal');
    });
  }

  function dismiss() {
    const value = ready();
    if (value) persistDismissal(value);
    clear();
  }

  async function send(
    action: FollowupAction,
    destination: 'current' | 'queue' | 'new-session' = 'current'
  ) {
    const value = current();
    if (sendPending || !value || !value.actions.includes(action) || action.sessionId) return;
    sendPending = true;
    setMenu(null);
    setSending(true);
    setError('');
    const sendScope = scope();
    const model = untrack(sessionModel);
    let optimisticPublished = false;
    const showSendError = () => {
      if (scope() !== sendScope || sourceKey() !== value.key) return;
      if (optimisticPublished && !ready()) setReady(value);
      if (ready() === value)
        setError(
          `Could not ${destination === 'queue' ? 'queue' : destination === 'new-session' ? 'run' : 'send'} this follow-up. Your main draft has not changed.`
        );
    };
    const validateBeforeSend = async () => {
      const latest = await client.varro.followups(value.sessionId, value.source, {
        signal: AbortSignal.timeout(5_000),
        directory: value.directory,
        allowGenerate: false,
        model,
      });
      const latestAction = latest.actions.find(
        (item) => item.title === action.title && item.prompt === action.prompt
      );
      if (current() !== value || !latestAction) {
        if (ready() === value) clear();
        return false;
      }
      if (latestAction.sessionId) {
        setReady({ ...value, ...latest });
        return false;
      }
      return true;
    };
    try {
      if (!(await validateBeforeSend())) return;
      if (destination === 'queue') {
        enqueueMessage({
          id: crypto.randomUUID(),
          sessionId: value.sessionId,
          text: action.prompt,
          followupTitle: action.title,
          agent: 'build',
          paused: true,
        });
        return;
      }
      if (destination === 'new-session') {
        const originalTitle = state.sessions
          .find((session) => session.id === value.sessionId)
          ?.title.trim();
        const title = originalTitle ? `${action.title} (${originalTitle})` : action.title;
        const forkedSessionId = await forkSession(value.sessionId, undefined, { select: false });
        if (!forkedSessionId) {
          showSendError();
          return;
        }
        if (scope() !== sendScope || current() !== value) return;
        const accepted = await sendMessage(action.prompt, {
          targetSessionId: forkedSessionId,
          agent: 'build',
          preserveComposer: true,
          omitContext: true,
          followupTitle: action.title,
          validateBeforeSend,
        });
        if (accepted === false) showSendError();
        else {
          const linkedAction = { ...action, sessionId: forkedSessionId };
          if (ready() === value)
            setReady({
              ...value,
              actions: value.actions.map((item) => (item === action ? linkedAction : item)),
            });
          try {
            if (
              !(await client.varro.linkFollowupSession(
                value.sessionId,
                value.source,
                linkedAction,
                value.directory
              ))
            )
              throw new Error('Follow-up session link was not saved');
          } catch {
            if (scope() === sendScope && sourceKey() === value.key)
              setError(
                'Follow-up started, but its session link could not be saved. Reloading may remove the link.'
              );
          }
          try {
            if (!(await renameSession(forkedSessionId, title)))
              throw new Error('Follow-up session title was not saved');
          } catch {
            if (scope() === sendScope && sourceKey() === value.key)
              setError((previous) =>
                [
                  previous,
                  'Follow-up started, but its session could not be renamed to match the task.',
                ]
                  .filter(Boolean)
                  .join(' ')
              );
          }
        }
        return;
      }
      const accepted = await sendMessage(action.prompt, {
        targetSessionId: value.sessionId,
        preserveComposer: true,
        omitContext: true,
        followupTitle: action.title,
        validateBeforeSend,
        onOptimisticPublish: () => {
          if (ready() !== value) return;
          optimisticPublished = true;
          clear();
        },
      });
      if (accepted !== false) {
        persistDismissal(value);
        if (ready() === value) clear();
      } else showSendError();
    } catch {
      showSendError();
    } finally {
      sendPending = false;
      setSending(false);
      if (ready()?.key === value.key && ready()?.sessionId === value.sessionId && !current())
        clear();
    }
  }

  createEffect(() => {
    const currentScope = scope();
    const working = props.working;
    const currentTurnId = turnId();
    const loading = state.messagesLoading;
    const key = sourceKey();
    const opening = state.followupOpening;
    observedMessages();
    const scopeChanged = previousScope !== currentScope;
    if (scopeChanged) {
      previousScope = currentScope;
      armedTurn = null;
      attempted.clear();
      historicalAssistantIds = new Set<string>();
      historicalUserIds = new Set<string>();
    }
    // Record every hydrated completed answer, not just the messages present at scope change.
    // A stale busy status is not evidence that completed history streamed in this view.
    const messages = untrack(() =>
      state.messages.filter((entry) => entry.info.sessionID === state.activeSessionId)
    );
    if (scopeChanged || loading) {
      untrack(() => {
        for (const entry of messages) {
          if (entry.info.role === 'user') historicalUserIds.add(entry.info.id);
          else if (entry.info.time.completed) historicalAssistantIds.add(entry.info.id);
        }
      });
    }
    if (working && !loading && state.followupsEnabled && currentTurnId) {
      untrack(() => {
        const answers = messages.filter(
          (entry) => entry.info.role === 'assistant' && entry.info.parentID === currentTurnId
        );
        const terminal = answers.some(
          (entry) =>
            entry.info.role === 'assistant' &&
            !!entry.info.time.completed &&
            (entry.info.finish === 'stop' || entry.info.finish === 'end_turn')
        );
        const unfinished = answers.some(
          (entry) => entry.info.role === 'assistant' && !entry.info.time.completed
        );
        const newPrompt = messages.some(
          (entry) =>
            entry.info.id === currentTurnId &&
            entry.info.role === 'user' &&
            !historicalUserIds.has(entry.info.id)
        );
        if (!terminal && (unfinished || newPrompt)) armedTurn = currentTurnId;
      });
    }
    if (sendPending && !scopeChanged) return;
    untrack(clear);
    const source = key ? parseFollowupSource(JSON.parse(key)) : null;
    const sessionId = state.activeSessionId;
    const completedAt = untrack(() => {
      const answer = messages.find((entry) => entry.info.id === source?.assistantMessageId);
      return answer?.info.role === 'assistant' ? answer.info.time.completed : undefined;
    });
    const unreadOpening =
      opening?.sessionId === sessionId && !!completedAt && completedAt > opening.seenAt;
    const liveTurn =
      !!source &&
      source.userMessageId === armedTurn &&
      !historicalAssistantIds.has(source.assistantMessageId);
    const allowGenerate = liveTurn || unreadOpening;
    const attemptKey = `${currentScope}:${source?.userMessageId ?? ''}:${allowGenerate}`;
    if (!source || !sessionId || attempted.has(attemptKey)) return;
    attempted.add(attemptKey);
    if (attempted.size > 64) attempted.delete(attempted.values().next().value!);
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const directory = untrack(
      () => state.sessions.find((session) => session.id === sessionId)?.directory
    );
    const model = untrack(sessionModel);
    let finishRestore = !liveTurn ? untrack(() => props.onRestoreStart?.()) : undefined;
    const releaseRestore = () => {
      const finish = finishRestore;
      finishRestore = undefined;
      finish?.();
    };
    const publish = (suggestions: FollowupSuggestionSet) => {
      if (controller.signal.aborted || scope() !== currentScope || sourceKey() !== key)
        return false;
      // Treat bridge output as inert plain text and enforce the same bounds as the host.
      const validated = parseFollowupSuggestions(JSON.stringify(suggestions), {
        allowSessionId: true,
      });
      if (!validated.actions.length) return false;
      setReady({ key, source, sessionId, directory, ...validated });
      return true;
    };
    const load = async () => {
      if (finishRestore) {
        const cacheController = new AbortController();
        const timer = setTimeout(() => {
          cacheController.abort();
          releaseRestore();
        }, INITIAL_CACHE_LOOKUP_TIMEOUT_MS);
        onCleanup(() => {
          clearTimeout(timer);
          cacheController.abort();
          releaseRestore();
        });
        try {
          const cached = await client.varro.followups(sessionId, source, {
            signal: AbortSignal.any([controller.signal, cacheController.signal]),
            directory,
            allowGenerate: false,
            cacheOnly: true,
            model,
          });
          if (!cacheController.signal.aborted && publish(cached)) return;
        } catch {
          // A failed or slow cache probe falls back to normal suggestions without holding reveal.
        } finally {
          clearTimeout(timer);
          releaseRestore();
        }
      }
      if (controller.signal.aborted) return;
      const suggestions = await client.varro.followups(sessionId, source, {
        signal: controller.signal,
        directory,
        allowGenerate,
        model,
      });
      publish(suggestions);
    };
    void load().catch(() => {
      // Optional inference must not change chat completion or log conversation text.
      if (!controller.signal.aborted)
        logWarn('Follow-ups request failed; check Varro output for generation diagnostics');
    });
  });

  const current = () => {
    const value = ready();
    return value && sourceKey() === value.key && state.activeSessionId === value.sessionId
      ? value
      : null;
  };

  return (
    <>
      <span class="sr-only" role="status" aria-live="polite">
        {current() ? 'Suggested next actions available' : ''}
      </span>
      {/* Clear through the layout hook before removing flow height, even when the source expires. */}
      <Show when={ready()}>
        {(value) => (
          <div
            class="followup-suggestions"
            ref={element}
            role="group"
            aria-label="Suggested next actions"
          >
            <Tooltip content="Dismiss follow-ups">
              <button
                type="button"
                class="followup-dismiss"
                aria-label="Dismiss follow-ups"
                disabled={sending()}
                onClick={dismiss}
              >
                <UiIcon source={xmarkIcon} width={12} height={12} aria-hidden="true" />
              </button>
            </Tooltip>
            <p class="followup-suggestions-summary">
              <InlineCodeText text={value().summary} />
            </p>
            <div class="followup-suggestions-actions">
              <For each={value().actions}>
                {(action) => (
                  <Show
                    when={action.sessionId}
                    fallback={
                      <Tooltip content={action.prompt}>
                        <button
                          type="button"
                          disabled={sending() || !current()}
                          onClick={() => void send(action)}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (sending() || !current()) return;
                            const rect = event.currentTarget.getBoundingClientRect();
                            setMenu({
                              action,
                              x: event.clientX || rect.left,
                              y: event.clientY || rect.bottom,
                            });
                          }}
                        >
                          <InlineCodeText text={action.title} />
                        </button>
                      </Tooltip>
                    }
                  >
                    {(sessionId) => (
                      <FollowupSessionLink
                        sessionId={sessionId()}
                        title={action.title}
                        directory={value().directory}
                      />
                    )}
                  </Show>
                )}
              </For>
            </div>
            <Show when={error()}>
              <p class="followup-suggestions-error" role="alert">
                {error()}
              </p>
            </Show>
          </div>
        )}
      </Show>
      <Show when={menu()} keyed>
        {(value) => (
          <Portal>
            <FollowupActionsMenu
              x={value.x}
              y={value.y}
              onClose={() => setMenu(null)}
              onCopy={() => {
                void writeClipboard(value.action.prompt);
                setMenu(null);
              }}
              onQueue={() => {
                setMenu(null);
                void send(value.action, 'queue');
              }}
              onRunInNewSession={() => {
                setMenu(null);
                void send(value.action, 'new-session');
              }}
            />
          </Portal>
        )}
      </Show>
    </>
  );
}

function FollowupSessionLink(props: { sessionId: string; title: string; directory?: string }) {
  const working = createMemo(() => isSessionStatusWorking(state.sessionStatus[props.sessionId]));
  const failed = () => state.failedSessionIds.includes(props.sessionId);
  const status = () => (working() ? 'Running' : failed() ? 'Failed' : 'Completed');
  return (
    <Tooltip content={`Open session: ${props.title} · ${status()}`}>
      <a
        class="followup-session-link"
        href={`#session/${encodeURIComponent(props.sessionId)}`}
        data-session-id={props.sessionId}
        aria-label={`${props.title} · ${status()}`}
        onClick={(event) => {
          event.preventDefault();
          if (state.activeSessionId)
            rememberDirectSessionReturn(props.sessionId, state.activeSessionId);
          void selectSession(props.sessionId, { directory: props.directory });
        }}
      >
        <Show
          when={working()}
          fallback={
            <UiIcon
              source={failed() ? xmarkIcon : checkIcon}
              width={12}
              height={12}
              aria-hidden="true"
            />
          }
        >
          <span class="session-status-indicator is-running" aria-hidden="true" />
        </Show>
        <InlineCodeText text={props.title} />
      </a>
    </Tooltip>
  );
}
