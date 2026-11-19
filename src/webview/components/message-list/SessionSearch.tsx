import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onSettled,
  untrack,
} from 'solid-js';
import { ariaBoolean } from '../../lib/aria';
import type { MessageEntry } from '../../types';
import { client } from '../../lib/client';
import {
  getSessionHistoryCursor,
  getSessionMessageWindowStateVersion,
  MESSAGE_HISTORY_WINDOW,
} from '../../lib/message-window';
import { getSessionSearchDocuments, searchSessionDocuments } from './session-search';
import type { SessionSearchDocument } from './session-search';
import { UiIcon } from '../UiIcon';
import { ChatContentBottomFade } from './MessageListChrome';
import {
  chatBubbleQuestionIcon,
  navArrowRightIcon,
  searchIcon,
  sparksIcon,
  xmarkIcon,
} from '../../lib/ui-icons';

const RESULT_PAGE_SIZE = 200;

export function SessionSearch(props: {
  sessionId: string | null;
  directory?: string;
  messages: readonly MessageEntry[];
  loading: boolean;
  onNavigate: (messageId: string) => Promise<void>;
  onClose: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal('');
  const [searchQuery, setSearchQuery] = createSignal('');
  const [allPrompts, setAllPrompts] = createSignal(false);
  const [history, setHistory] = createSignal<SessionSearchDocument[]>([]);
  const [searching, setSearching] = createSignal(false);
  const [error, setError] = createSignal('');
  const [navigationError, setNavigationError] = createSignal('');
  const visibleError = () => navigationError() || error();
  const [activeIndex, setActiveIndex] = createSignal(0);
  const [resultLimit, setResultLimit] = createSignal(RESULT_PAGE_SIZE);
  const listId = createUniqueId();
  let input: HTMLInputElement | undefined;
  let panel: HTMLElement | undefined;
  let resultsContainer: HTMLDivElement | undefined;
  let resultsScrollTop = 0;
  let lastResultPointerPosition: { x: number; y: number } | undefined;
  let previousFocus: HTMLElement | null = null;
  let navigationEpoch = 0;
  let historyCache:
    | { sessionId: string; version: number; directory?: string; cursor?: string }
    | undefined;
  const hasQuery = createMemo(() => searchQuery().trim().length > 0);
  const hasSearch = createMemo(() => hasQuery() || allPrompts());

  const documents = createMemo(() => {
    if (!open() || !hasSearch() || !props.sessionId) return [];
    const merged = new Map(history().map((document) => [document.id, document]));
    // Loaded messages own the latest text, including edits and streamed responses.
    for (const message of props.messages) merged.delete(message.info.id);
    for (const document of getSessionSearchDocuments(props.messages, props.sessionId)) {
      merged.set(document.id, document);
    }
    return [...merged.values()].toSorted(
      (left, right) =>
        Number(right.role === 'user') - Number(left.role === 'user') ||
        right.created - left.created ||
        right.id.localeCompare(left.id)
    );
  });
  const results = createMemo(() => {
    const items = allPrompts()
      ? documents().filter((document) => document.role === 'user')
      : documents();
    if (hasQuery()) return searchSessionDocuments(items, searchQuery());
    return items.map((document) => ({
      ...document,
      before: `${document.text.slice(0, 165)}${document.text.length > 165 ? '…' : ''}`,
      match: '',
      after: '',
    }));
  });
  const visibleResults = createMemo(() => results().slice(0, resultLimit()));
  const promptCount = createMemo(() => results().filter((result) => result.role === 'user').length);
  const resultSummary = createMemo(() => {
    const count = results().length;
    const noun = allPrompts() ? 'prompt' : 'message';
    const qualifier = hasQuery() ? 'matching ' : '';
    if (count > resultLimit()) return `Showing ${resultLimit()} of ${count} ${qualifier}${noun}s`;
    return `${count} ${qualifier}${noun}${count === 1 ? '' : 's'}`;
  });
  const promptResults = createMemo(() =>
    visibleResults().filter((result) => result.role === 'user')
  );
  const responseResults = createMemo(() =>
    visibleResults().filter((result) => result.role === 'assistant')
  );
  const resultGroups = [
    {
      role: 'user',
      label: 'Your prompts',
      icon: chatBubbleQuestionIcon,
      items: promptResults,
      count: promptCount,
      offset: () => 0,
    },
    {
      role: 'assistant',
      label: 'Assistant responses',
      icon: sparksIcon,
      items: responseResults,
      count: () => results().length - promptCount(),
      offset: () => promptResults().length,
    },
  ] as const;
  const selectedIndex = () => Math.min(activeIndex(), Math.max(0, visibleResults().length - 1));

  const selectResultWithPointer = (event: PointerEvent, index: number) => {
    if (event.pointerType === 'touch') return;
    // Scrolling can retarget events beneath a stationary pointer. Only real movement
    // should replace the keyboard destination.
    if (
      lastResultPointerPosition?.x === event.clientX &&
      lastResultPointerPosition.y === event.clientY
    )
      return;
    lastResultPointerPosition = { x: event.clientX, y: event.clientY };
    setActiveIndex(index);
  };

  createEffect(query, (value) => {
    const cleanups: Array<() => void> = [];

    const timer = setTimeout(() => setSearchQuery(value), 120);
    cleanups.push(() => clearTimeout(timer));

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });
  createEffect(
    () => [searchQuery(), allPrompts()] as const,
    () => {
      setActiveIndex(0);
      setResultLimit(RESULT_PAGE_SIZE);
      resultsScrollTop = 0;
      if (resultsContainer) resultsContainer.scrollTop = 0;
    }
  );
  createEffect(
    () => props.sessionId,
    () => {
      setOpen(false);
      setQuery('');
      setSearchQuery('');
      setAllPrompts(false);
      setError('');
      setNavigationError('');
      navigationEpoch += 1;
      resultsScrollTop = 0;
      previousFocus = null;
    },
    { defer: true }
  );

  // Searching never prepends transcript rows or changes its pagination cursor.
  createEffect(
    () => ({
      sessionId: props.sessionId,
      version: props.sessionId ? getSessionMessageWindowStateVersion(props.sessionId) : 0,
      directory: props.directory,
      isOpen: open(),
      searchEnabled: hasSearch(),
      loading: props.loading,
    }),
    ({ sessionId, version, directory, isOpen, searchEnabled, loading }) => {
      const cleanups: Array<() => void> = [];

      if (
        historyCache &&
        (historyCache.sessionId !== sessionId ||
          historyCache.version !== version ||
          historyCache.directory !== directory)
      ) {
        historyCache = undefined;
        setHistory([]);
      }
      if (!isOpen || !searchEnabled || !sessionId || loading) {
        setSearching(false);
        if (!searchEnabled || !sessionId) setError('');
        return () => {
          for (const cleanup of cleanups.toReversed()) cleanup();
        };
      }
      const controller = new AbortController();
      cleanups.push(() => controller.abort());
      setError('');
      historyCache ??= {
        sessionId,
        version,
        directory,
        cursor: untrack(() => getSessionHistoryCursor(sessionId)),
      };
      const cache = historyCache;
      if (!cache.cursor) {
        setSearching(false);
        return () => {
          for (const cleanup of cleanups.toReversed()) cleanup();
        };
      }
      setSearching(true);
      // A liveness check for async pagination: it compares against the latest values on purpose.
      const isCurrent = () =>
        !controller.signal.aborted &&
        untrack(
          () =>
            props.sessionId === sessionId &&
            getSessionMessageWindowStateVersion(sessionId) === version
        );
      void (async () => {
        const seen = new Set<string>();
        const collected = new Map(untrack(history).map((document) => [document.id, document]));
        try {
          while (cache.cursor && isCurrent()) {
            if (seen.has(cache.cursor))
              throw new Error('History pagination did not advance. Reopen search to retry.');
            seen.add(cache.cursor);
            const page = await client.session.messages(sessionId, {
              limit: MESSAGE_HISTORY_WINDOW,
              before: cache.cursor,
              directory,
              signal: controller.signal,
            });
            if (!isCurrent()) return;
            for (const document of getSessionSearchDocuments(page, sessionId))
              collected.set(document.id, document);
            setHistory([...collected.values()]);
            cache.cursor = page.nextCursor;
          }
        } catch (cause: unknown) {
          if (isCurrent())
            setError(
              `History search incomplete: ${cause instanceof Error ? cause.message : String(cause)}`
            );
        } finally {
          if (isCurrent()) setSearching(false);
        }
      })();

      return () => {
        for (const cleanup of cleanups.toReversed()) cleanup();
      };
    }
  );

  const show = () => {
    if (!props.sessionId) return;
    setNavigationError('');
    if (!open())
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpen(true);
    queueMicrotask(() => {
      if (!open()) return;
      if (resultsContainer) resultsContainer.scrollTop = resultsScrollTop;
      input?.focus({ preventScroll: true });
      input?.select();
    });
  };
  const close = (restoreFocus = true) => {
    props.onClose();
    resultsScrollTop = resultsContainer?.scrollTop ?? resultsScrollTop;
    setOpen(false);
    navigationEpoch += 1;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  };
  const navigate = async (id: string) => {
    close();
    const epoch = ++navigationEpoch;
    setError('');
    setNavigationError('');
    try {
      // Publish the closed panel before a route loader can replace its rows.
      await Promise.resolve();
      if (epoch !== navigationEpoch) return;
      await props.onNavigate(id);
    } catch (cause: unknown) {
      if (epoch === navigationEpoch) {
        show();
        setNavigationError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };
  onSettled(() => {
    const cleanups: Array<() => void> = [];

    const handleKeydown = (event: KeyboardEvent) => {
      if (
        !event.isComposing &&
        event.key.toLowerCase() === 'f' &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        props.sessionId
      ) {
        event.preventDefault();
        event.stopPropagation();
        show();
      } else if (open() && event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (open() && event.target instanceof Node && !panel?.contains(event.target)) close(false);
    };
    window.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    cleanups.push(() => {
      window.removeEventListener('keydown', handleKeydown, true);
      document.removeEventListener('pointerdown', handleOutsidePointerDown);
      navigationEpoch += 1;
    });

    return () => {
      for (const cleanup of cleanups.toReversed()) cleanup();
    };
  });

  return (
    <Show when={open()}>
      <div class="session-search-layer">
        <section
          ref={(element) => {
            panel = element;
          }}
          class="session-search"
          role="search"
          aria-label="Search this session"
        >
          <div class="session-search-heading">
            <span>Search this session</span>
            <button
              type="button"
              class="session-search-prompts-toggle"
              aria-pressed={ariaBoolean(allPrompts())}
              aria-controls={listId}
              title="Browse all prompts in this session"
              onClick={() => {
                setAllPrompts((value) => !value);
                input?.focus({ preventScroll: true });
              }}
            >
              <UiIcon source={chatBubbleQuestionIcon} width={14} height={14} />
              All prompts
            </button>
          </div>
          <div class="session-search-controls">
            <UiIcon source={searchIcon} width={16} height={16} />
            <input
              ref={(element) => {
                input = element;
              }}
              type="text"
              spellcheck={false}
              role="combobox"
              aria-expanded="true"
              aria-autocomplete="list"
              aria-label={allPrompts() ? 'Search prompts' : 'Search prompts and responses'}
              placeholder={allPrompts() ? 'Search prompts' : 'Search this session'}
              value={query()}
              aria-controls={listId}
              aria-activedescendant={
                visibleResults().length ? `${listId}-${selectedIndex()}` : undefined
              }
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.isComposing) return;
                const items = visibleResults();
                if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length) {
                  event.preventDefault();
                  const index =
                    (selectedIndex() + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                    items.length;
                  setActiveIndex(index);
                  document
                    .getElementById(`${listId}-${index}`)
                    ?.scrollIntoView({ block: 'nearest' });
                } else if (event.key === 'Enter' && items[selectedIndex()]) {
                  event.preventDefault();
                  void navigate(items[selectedIndex()]!.id);
                }
              }}
            />
            <Show when={query().length > 0}>
              <button
                type="button"
                class="session-list-search-clear"
                aria-label="Clear search"
                title="Clear search"
                onClick={() => {
                  setQuery('');
                  setSearchQuery('');
                  setError('');
                  input?.focus({ preventScroll: true });
                }}
              >
                <UiIcon
                  source={xmarkIcon}
                  class="session-list-search-clear-icon"
                  width={10}
                  height={10}
                />
              </button>
            </Show>
          </div>
          <div class="session-search-status" role="status">
            <Show when={hasSearch()} fallback="Search this conversation or browse all prompts.">
              {resultSummary()}
              {searching() || props.loading
                ? hasQuery()
                  ? ' · Searching history…'
                  : ' · Loading history…'
                : ''}
            </Show>
          </div>
          <Show when={visibleError()}>
            <div class="session-search-error" role="alert">
              {visibleError()}
            </div>
          </Show>
          <div
            class="session-search-results"
            ref={(element) => {
              resultsContainer = element;
            }}
            id={listId}
            role="listbox"
            aria-label={allPrompts() ? 'Session prompts' : 'Matching messages'}
          >
            <For each={resultGroups}>
              {(group) => (
                <Show when={group.items().length > 0}>
                  <div class="session-search-result-group" role="group" aria-label={group.label}>
                    <div
                      class={['session-search-group', { 'is-prompt-group': group.role === 'user' }]}
                      role="presentation"
                    >
                      <span class="session-search-group-label">
                        <UiIcon source={group.icon} width={14} height={14} />
                        {group.label}
                      </span>
                      <span class="session-search-group-count">{group.count()}</span>
                    </div>
                    <For each={group.items()}>
                      {(result, index) => {
                        const resultIndex = () => group.offset() + index();
                        return (
                          <button
                            id={`${listId}-${resultIndex()}`}
                            type="button"
                            role="option"

                            class={[
                              'session-search-result',
                              {
                                'is-selected': selectedIndex() === resultIndex(),
                                'is-prompt': result.role === 'user',
                              },
                            ]}
                            aria-selected={ariaBoolean(selectedIndex() === resultIndex())}
                            aria-label={`${result.role === 'user' ? 'Prompt' : 'Response'}: ${result.before}${result.match}${result.after}`}
                            onPointerMove={(event) => selectResultWithPointer(event, resultIndex())}
                            onClick={() => {
                              setActiveIndex(resultIndex());
                              void navigate(result.id);
                            }}
                          >
                            <span class="session-search-snippet">
                              {result.before}
                              <Show when={result.match}>
                                <mark>{result.match}</mark>
                              </Show>
                              {result.after}
                            </span>
                            <span class="session-search-open-icon">
                              <UiIcon source={navArrowRightIcon} width={14} height={14} />
                            </span>
                          </button>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              )}
            </For>
          </div>
          <Show when={results().length > resultLimit()}>
            <button
              class="session-search-more"
              type="button"
              onClick={() => setResultLimit((limit) => limit + RESULT_PAGE_SIZE)}
            >
              Show more results
            </button>
          </Show>
          <div class="session-search-footer" aria-hidden="true">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> Select
            </span>
            <span>
              <kbd>Enter</kbd> Open message
            </span>
            <span>
              <kbd>Esc</kbd> Close
            </span>
          </div>
          <ChatContentBottomFade belowContent />
        </section>
      </div>
    </Show>
  );
}
