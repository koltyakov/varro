import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import {
  MAX_SIDE_QUESTION_LENGTH,
  MAX_SIDE_QUESTION_ANSWER_LENGTH,
  SIDE_QUESTION_TIMEOUT_MS,
  MAX_SIDE_QUESTION_TURNS,
  MAX_SIDE_QUESTION_CONTEXT_LENGTH,
} from '../../shared/side-question';
import { asRecord, isString } from '../../shared/type-utils';
import type {
  SideQuestionAnswer,
  SideQuestionTurn,
  SideQuestionRequest,
} from '../../shared/side-question';
import { apiCall } from '../lib/bridge';
import { createComposerHistory, getComposerHistoryAction } from '../lib/composer-history';
import type { ComposerHistoryAction, ComposerSnapshot } from '../lib/composer-history';
import { trapModalFocus } from '../lib/modal-focus';
import {
  sideQuestionPromptUnavailableReason,
  sideQuestionUnavailableReason,
} from '../lib/side-question';
import { formatTurnDuration } from '../lib/time-format';
import { writeClipboard } from '../lib/write-clipboard';
import { checkIcon, clockIcon, copyIcon, xmarkIcon } from '../lib/ui-icons';
import { MarkdownRenderer } from './MarkdownRenderer';
import { showSessionActionFeedback } from './chat/SessionActionFeedback';
import { RichComposerArea } from './chat-input/RichComposerArea';
import { SendControls } from './chat-input/SendControls';
import { StopButton } from './chat-input/StopButton';
import { UserMessageContent } from './message/UserMessageContent';
import { StarterLogo } from './message-list/StarterLogo';
import { ThinkingIndicator } from './ThinkingIndicator';
import { UiIcon } from './UiIcon';

type TimedSideQuestionTurn = SideQuestionTurn & { durationMs: number };

export function SideQuestionDialog(props: {
  sessionID: string;
  directory: string;
  question: string;
  context?: string;
  onClose: () => void;
}) {
  const titleID = createUniqueId();
  const [question, setQuestion] = createSignal(props.question);
  const [caret, setCaret] = createSignal(props.question.length);
  const [focused, setFocused] = createSignal(false);
  const [turns, setTurns] = createSignal<TimedSideQuestionTurn[]>([]);
  const [submittedQuestion, setSubmittedQuestion] = createSignal('');
  const [submittedDraft, setSubmittedDraft] = createSignal('');
  const [contextSent, setContextSent] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal('');
  const [copied, setCopied] = createSignal<number | null>(null);
  const [minimumHeight, setMinimumHeight] = createSignal(0);
  const canSend = createMemo(
    () =>
      !!question().trim() &&
      !sideQuestionUnavailableReason(false) &&
      !sideQuestionPromptUnavailableReason(question())
  );
  const showWelcome = () => turns().length === 0 && !submittedQuestion() && !error();
  let dialogRef: HTMLElement | undefined;
  let controller: AbortController | undefined;
  let inputRef: HTMLDivElement | undefined;
  let closeRef: HTMLButtonElement | undefined;
  let bodyRef: HTMLDivElement | undefined;
  const composerHistory = createComposerHistory();
  const snapshot = (): ComposerSnapshot => ({
    text: question(),
    caret: caret(),
    files: [],
    images: [],
  });
  composerHistory.reset(snapshot());

  function resetDraft(text: string) {
    batch(() => {
      setQuestion(text);
      setCaret(text.length);
      composerHistory.reset(snapshot());
    });
  }

  function updateDraft(text: string, offset: number) {
    batch(() => {
      setQuestion(text.slice(0, MAX_SIDE_QUESTION_LENGTH));
      setCaret(Math.min(offset, MAX_SIDE_QUESTION_LENGTH));
      composerHistory.record(snapshot());
    });
  }

  function rememberCaret(offset: number) {
    setCaret(offset);
    composerHistory.record(snapshot());
  }

  function handlePaste(event: ClipboardEvent) {
    const clipboard = event.clipboardData;
    const hasImage =
      Array.from(clipboard?.items ?? []).some(
        (item) => item.kind === 'file' && item.type.startsWith('image/')
      ) || Array.from(clipboard?.files ?? []).some((file) => file.type.startsWith('image/'));
    if (!hasImage) return;
    event.stopPropagation();
    if (!clipboard?.getData('text/plain')) event.preventDefault();
    showSessionActionFeedback(
      'Side questions support text only',
      'warning',
      inputRef?.closest<HTMLElement>('.chat-input-container') ?? undefined
    );
  }

  function restoreDraft(action: ComposerHistoryAction) {
    const value = action === 'undo' ? composerHistory.undo() : composerHistory.redo();
    if (!value) return;
    batch(() => {
      setQuestion(value.text);
      setCaret(value.caret);
    });
  }

  const focusInput = () =>
    queueMicrotask(() => {
      const target = inputRef?.isConnected ? inputRef : closeRef;
      if (target?.isConnected) target.focus({ preventScroll: true });
    });
  const revealLatest = () =>
    queueMicrotask(() => {
      if (bodyRef?.isConnected) bodyRef.scrollTop = bodyRef.scrollHeight;
    });

  onCleanup(() => {
    controller?.abort();
    controller = undefined;
  });

  function rememberWelcomeHeight() {
    if (!showWelcome() || !dialogRef?.isConnected) return;
    const height = Math.ceil(dialogRef.getBoundingClientRect().height);
    setMinimumHeight((previous) => Math.max(previous, height));
  }

  createEffect(() => {
    if (!showWelcome() || !dialogRef) return;
    rememberWelcomeHeight();
    const observer = new ResizeObserver(rememberWelcomeHeight);
    observer.observe(dialogRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    const reason = sideQuestionUnavailableReason(false);
    if (reason && pending()) {
      controller?.abort();
      controller = undefined;
      setPending(false);
      setError(reason);
      if (!question()) resetDraft(submittedDraft());
      setSubmittedQuestion('');
    }
  });

  async function ask() {
    const draft = question().trim();
    if (!draft || pending()) return;
    const promptReason = sideQuestionPromptUnavailableReason(draft);
    const text = [draft, contextSent() ? '' : props.context].filter(Boolean).join('\n\n');
    if (promptReason || text.length > MAX_SIDE_QUESTION_LENGTH) {
      showSessionActionFeedback(
        promptReason ?? 'Question and context exceed the side-question limit',
        'warning',
        inputRef?.closest<HTMLElement>('.chat-input-container') ?? undefined
      );
      return;
    }
    const reason = sideQuestionUnavailableReason(false);
    if (reason) {
      setError(reason);
      return;
    }
    const history = turns();
    if (
      history.length >= MAX_SIDE_QUESTION_TURNS ||
      history.reduce(
        (length, turn) => length + turn.question.length + turn.answer.length,
        text.length
      ) > MAX_SIDE_QUESTION_CONTEXT_LENGTH
    ) {
      setError('This side conversation is full. Close it and start another.');
      return;
    }
    rememberWelcomeHeight();
    const request = new AbortController();
    const startedAt = performance.now();
    controller = request;
    setPending(true);
    setError('');
    setSubmittedQuestion(text);
    setSubmittedDraft(draft);
    resetDraft('');
    revealLatest();
    if (!history.length) {
      setFocused(false);
      focusInput();
    }
    try {
      const body: SideQuestionRequest = { question: text };
      if (history.length) {
        body.history = history.map((turn) => ({ question: turn.question, answer: turn.answer }));
      }
      const result = asRecord(
        await apiCall<SideQuestionAnswer>(
          'POST',
          `/session/${encodeURIComponent(props.sessionID)}/side-question?directory=${encodeURIComponent(props.directory)}`,
          body,
          { signal: request.signal, timeoutMs: SIDE_QUESTION_TIMEOUT_MS, retries: 0 }
        )
      );
      if (controller !== request || request.signal.aborted) return;
      if (
        !isString(result?.text) ||
        !result.text.trim() ||
        result.text.length > MAX_SIDE_QUESTION_ANSWER_LENGTH
      ) {
        throw new Error('OpenCode returned no usable answer. Try a narrower question.');
      }
      const followingLatest =
        !bodyRef || bodyRef.scrollHeight - bodyRef.clientHeight - bodyRef.scrollTop <= 24;
      setTurns([
        ...history,
        { question: text, answer: result.text, durationMs: performance.now() - startedAt },
      ]);
      setContextSent(true);
      setSubmittedQuestion('');
      if (followingLatest) revealLatest();
      focusInput();
    } catch (cause) {
      if (controller !== request || request.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      if (!question()) resetDraft(draft);
      setSubmittedQuestion('');
      focusInput();
    } finally {
      if (controller === request) {
        controller = undefined;
        setPending(false);
      }
    }
  }

  onMount(() => {
    focusInput();
    if (props.question.trim()) void ask();
  });

  async function copyAnswer(index: number) {
    const turn = turns()[index];
    if (!turn) return;
    if (await writeClipboard(turn.answer)) setCopied(index);
    else setError('Could not copy the answer');
  }

  function stopAnswer() {
    controller?.abort();
    controller = undefined;
    setPending(false);
    if (!question()) resetDraft(submittedDraft());
    setSubmittedQuestion('');
    focusInput();
  }

  return (
    <Portal>
      <div class="side-question-overlay">
        <section
          class="interactive-session side-question-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleID}
          style={{
            '--side-question-min-height': minimumHeight() ? `${minimumHeight()}px` : undefined,
          }}
          ref={(element) => {
            dialogRef = element;
            onCleanup(trapModalFocus(element, { preventScrollOnRestore: true }));
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            props.onClose();
          }}
        >
          <header class="side-question-header">
            <h2 id={titleID}>Side question</h2>
            <button
              type="button"
              class="provider-connect-close side-question-close"
              aria-label="Close side question"
              ref={(element) => {
                closeRef = element;
              }}
              onClick={props.onClose}
            >
              <UiIcon source={xmarkIcon} width={16} height={16} />
            </button>
          </header>
          <div
            class="side-question-body"
            classList={{ 'is-empty': showWelcome() }}
            ref={(element) => {
              bodyRef = element;
            }}
            aria-busy={pending()}
          >
            <Show when={showWelcome()}>
              <div class="side-question-empty-state">
                <StarterLogo contained />
                <p class="side-question-empty-copy">Ask anything about this session.</p>
              </div>
            </Show>
            <For each={turns()}>
              {(turn, index) => (
                <article class="side-question-turn">
                  <SideQuestionPrompt text={turn.question} />
                  <div
                    class="chat-turn chat-turn-assistant side-question-answer"
                    aria-label="Assistant response"
                  >
                    <div class="chat-turn-content">
                      <MarkdownRenderer
                        content={turn.answer}
                        sessionID={props.sessionID}
                        directory={props.directory}
                        escapeHtml
                      />
                    </div>
                    <div class="model-change-indicator assistant-dialog-summary side-question-answer-actions">
                      <div class="assistant-dialog-summary-content">
                        <span class="model-change-label">
                          <span
                            class="assistant-dialog-summary-metric side-question-response-time"
                            aria-label={`Response time: ${formatTurnDuration(turn.durationMs)}`}
                            title="Elapsed time from sending the question to receiving the answer"
                          >
                            <UiIcon source={clockIcon} width={12} height={12} aria-hidden="true" />
                            {formatTurnDuration(turn.durationMs)}
                          </span>
                        </span>
                        <div class="assistant-dialog-summary-turn-actions">
                          <button
                            type="button"
                            class="assistant-dialog-summary-turn-action assistant-dialog-summary-copy side-question-copy"
                            classList={{ 'is-copied': copied() === index() }}
                            aria-label={copied() === index() ? 'Answer copied' : 'Copy answer'}
                            title={copied() === index() ? 'Copied' : 'Copy answer'}
                            onClick={() => void copyAnswer(index())}
                          >
                            <UiIcon
                              source={copied() === index() ? checkIcon : copyIcon}
                              width={16}
                              height={16}
                            />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </article>
              )}
            </For>
            <Show when={submittedQuestion()}>
              <SideQuestionPrompt text={submittedQuestion()} />
            </Show>
            <Show when={pending()}>
              <div
                class="interactive-item-container interactive-response"
                role="status"
                aria-label="Thinking"
              >
                <div class="loading-indicator">
                  <ThinkingIndicator />
                </div>
              </div>
            </Show>
            <Show when={error()}>
              <p class="side-question-error" role="alert">
                {error()}
              </p>
            </Show>
          </div>
          <Show when={!pending() || turns().length > 0}>
            <div class="side-question-composer">
              <div class="chat-input-container" classList={{ focused: focused() }}>
                <RichComposerArea
                  editorRef={(element) => {
                    inputRef = element;
                  }}
                  ariaLabel={turns().length ? 'Follow-up question' : 'Question'}
                  centerCaret
                  placeholder={turns().length ? 'Ask a follow-up…' : 'Ask about this conversation…'}
                  value={question()}
                  cursorOffset={caret()}
                  chips={[]}
                  isFocused={focused()}
                  showCompletionMenu={false}
                  completionItems={[]}
                  completionSelectedIndex={0}
                  onInput={updateDraft}
                  onKeyDown={(event) => {
                    const historyAction = getComposerHistoryAction(event);
                    if (historyAction) {
                      event.preventDefault();
                      restoreDraft(historyAction);
                    } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                      event.preventDefault();
                      void ask();
                    }
                  }}
                  onPaste={handlePaste}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  onClick={rememberCaret}
                  onKeyUp={rememberCaret}
                  onSelect={rememberCaret}
                  onSelectCompletion={() => {}}
                  onHistory={restoreDraft}
                />
                <div class="side-question-composer-actions">
                  <Show
                    when={pending()}
                    fallback={
                      <Show
                        when={error()}
                        fallback={
                          <SendControls
                            showBusyControls={false}
                            showBusyOptions={false}
                            busyMenuOpen={false}
                            canSend={canSend()}
                            onSend={() => void ask()}
                            onToggleBusyMenu={() => {}}
                          />
                        }
                      >
                        <button
                          type="button"
                          class="question-btn"
                          disabled={
                            !question().trim() ||
                            !!sideQuestionUnavailableReason(false) ||
                            !!sideQuestionPromptUnavailableReason(question())
                          }
                          onClick={() => void ask()}
                        >
                          Retry
                        </button>
                      </Show>
                    }
                  >
                    <StopButton onStop={stopAnswer} />
                  </Show>
                </div>
              </div>
            </div>
          </Show>
        </section>
      </div>
    </Portal>
  );
}

function SideQuestionPrompt(props: { text: string }) {
  const id = createUniqueId();
  return (
    <div
      class="interactive-item-container interactive-request side-question-question"
      aria-label="Your message"
    >
      <div class="chat-turn chat-turn-user">
        <div class="value chat-turn-content chat-turn-card user-message-card">
          <UserMessageContent
            parts={[{ id, sessionID: '', messageID: id, type: 'text', text: props.text }]}
          />
        </div>
      </div>
    </div>
  );
}
