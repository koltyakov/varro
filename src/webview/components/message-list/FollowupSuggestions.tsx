import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack } from 'solid-js';
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
import { getSelectedModelForSession, state } from '../../lib/state';
import { deriveSelectedModelFromSession } from '../../hooks/routing-state';
import { prepareForMessageBlockRemoval } from '../../lib/message-list-layout';
import { sendMessage } from '../../hooks/useOpenCode';
import { xmarkIcon } from '../../lib/ui-icons';
import { InlineCodeText } from '../InlineCodeText';
import { UiIcon } from '../UiIcon';
import { Tooltip } from '../Tooltip';

type ReadyFollowups = FollowupSuggestionSet & {
  key: string;
  source: FollowupSource;
  sessionId: string;
  directory?: string;
};

/** One observer for the latest live turn, outside virtualized message rows. */
export function FollowupSuggestions(props: {
  finalMessageId: string | null;
  turnId: string | null;
  working: boolean;
  blocked: boolean;
}) {
  const [ready, setReady] = createSignal<ReadyFollowups | null>(null);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal('');
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

  async function send(action: FollowupAction) {
    const value = current();
    if (sendPending || !value || !value.actions.includes(action)) return;
    sendPending = true;
    setSending(true);
    setError('');
    const sendScope = scope();
    let optimisticPublished = false;
    const showSendError = () => {
      if (scope() !== sendScope || sourceKey() !== value.key) return;
      if (optimisticPublished && !ready()) setReady(value);
      if (ready() === value)
        setError('Could not send this follow-up. Your main draft has not changed.');
    };
    const validateBeforeSend = async () => {
      const latest = await client.varro.followups(value.sessionId, value.source, {
        signal: AbortSignal.timeout(5_000),
        directory: value.directory,
        allowGenerate: false,
        model: untrack(sessionModel),
      });
      if (
        current() !== value ||
        !latest.actions.some((item) => item.title === action.title && item.prompt === action.prompt)
      ) {
        if (ready() === value) clear();
        return false;
      }
      return true;
    };
    try {
      if (!(await validateBeforeSend())) return;
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
      if (ready() === value && !current()) clear();
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
    const allowGenerate =
      !!source &&
      ((source.userMessageId === armedTurn &&
        !historicalAssistantIds.has(source.assistantMessageId)) ||
        unreadOpening);
    const attemptKey = `${currentScope}:${source?.userMessageId ?? ''}:${allowGenerate}`;
    if (!source || !sessionId || attempted.has(attemptKey)) return;
    attempted.add(attemptKey);
    if (attempted.size > 64) attempted.delete(attempted.values().next().value!);
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const directory = untrack(
      () => state.sessions.find((session) => session.id === sessionId)?.directory
    );
    void client.varro
      .followups(sessionId, source, {
        signal: controller.signal,
        directory,
        allowGenerate,
        model: untrack(sessionModel),
      })
      .then((suggestions) => {
        if (controller.signal.aborted || scope() !== currentScope || sourceKey() !== key) return;
        // Treat bridge output as inert plain text and enforce the same bounds as the host.
        const validated = parseFollowupSuggestions(JSON.stringify(suggestions));
        if (validated.actions.length) setReady({ key, source, sessionId, directory, ...validated });
      })
      .catch(() => {
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
                  <Tooltip content={action.prompt}>
                    <button
                      type="button"
                      disabled={sending() || !current()}
                      onClick={() => void send(action)}
                    >
                      <InlineCodeText text={action.title} />
                    </button>
                  </Tooltip>
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
    </>
  );
}
