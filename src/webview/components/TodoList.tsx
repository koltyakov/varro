import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { defaultAppState } from '../lib/state';
import type { NormalizedTodo } from '../types';

const todos = () => defaultAppState.state.todos;
const TODO_LIST_CHAT_SHARE = 0.28;
const MIN_TODO_LIST_HEIGHT = 52;
const MAX_TODO_LIST_HEIGHT = 220;
const DEFAULT_TODO_LIST_HEIGHT = 160;
const MIN_CHAT_VIEW_HEIGHT = 140;
const MIN_CHAT_VIEW_SHARE = 0.4;

export function TodoList() {
  const completed = () => todos().filter((todo) => isResolvedTodoStatus(todo.status)).length;
  const total = () => todos().length;
  const progress = () => (total() > 0 ? (completed() / total()) * 100 : 0);
  const allDone = () => total() > 0 && completed() === total();
  const inProgressTodos = () => todos().filter((todo) => todo.status === 'in_progress');
  const inProgressTodo = () => inProgressTodos()[0];
  const [activeTodoIndex, setActiveTodoIndex] = createSignal(0);
  const activeTodo = () => {
    const running = inProgressTodos();
    return (
      running[activeTodoIndex() % running.length] ||
      todos().find((todo) => !isResolvedTodoStatus(todo.status))
    );
  };
  const activeTodoDots = () => {
    const count = inProgressTodos().length || (activeTodo() ? 1 : 0);
    if (count === 0) return [];

    const gap = Math.min(1, 4 / count);
    const diameter = Math.min(3, (14 - gap * (count - 1)) / count);
    const firstCenter = (14 - (diameter * count + gap * (count - 1))) / 2 + diameter / 2;
    return Array.from({ length: count }, (_, index) => ({
      center: firstCenter + index * (diameter + gap),
      radius: diameter / 2,
    }));
  };
  const [collapsed, setCollapsed] = createSignal(allDone());
  const [listMaxHeight, setListMaxHeight] = createSignal(DEFAULT_TODO_LIST_HEIGHT);
  let previousTodoIds = new Set(todos().map((todo) => todo.id));
  let previousUserMessageCount = userMessageCount();
  let previousAllDone = allDone();
  let blockRef: HTMLDivElement | undefined;
  let listRef: HTMLUListElement | undefined;
  let manuallyExpanded = false;

  const setAutomaticCollapsed = (nextCollapsed: boolean) => {
    manuallyExpanded = false;
    setCollapsed(nextCollapsed);
  };

  createEffect(() => {
    const runningCount = inProgressTodos().length;
    if (!collapsed() || runningCount <= 1) {
      setActiveTodoIndex(0);
      return;
    }

    setActiveTodoIndex(0);
    const interval = window.setInterval(() => {
      setActiveTodoIndex((index) => (index + 1) % runningCount);
    }, 5_000);
    onCleanup(() => window.clearInterval(interval));
  });

  createEffect(() => {
    const nextTodoIds = new Set(todos().map((todo) => todo.id));
    const hasNewTodo = todos().some((todo) => !previousTodoIds.has(todo.id));
    const nextUserMessageCount = userMessageCount();
    const nextAllDone = allDone();

    if (nextAllDone && !previousAllDone) {
      setAutomaticCollapsed(true);
    } else if (hasNewTodo) {
      setAutomaticCollapsed(false);
    } else if (nextUserMessageCount > previousUserMessageCount && nextAllDone) {
      setAutomaticCollapsed(true);
    }

    previousTodoIds = nextTodoIds;
    previousUserMessageCount = nextUserMessageCount;
    previousAllDone = nextAllDone;
  });

  createEffect(() => {
    const inProgressTodoId = inProgressTodo()?.id;
    if (!inProgressTodoId || collapsed()) return;

    queueMicrotask(() => {
      if (collapsed() || inProgressTodo()?.id !== inProgressTodoId) return;
      const inProgressItem = Array.from(listRef?.children || []).find(
        (item) => (item as HTMLElement).dataset.todoId === inProgressTodoId
      );
      inProgressItem?.scrollIntoView?.({ block: 'nearest' });
    });
  });

  onMount(() => {
    const chatShell = blockRef?.closest<HTMLElement>('.chat-main-column-shell');
    const chatView = chatShell?.querySelector<HTMLElement>('.interactive-list');
    if (!chatShell) return;

    let previousChatShellHeight = chatShell.clientHeight;
    const updateAvailableSpace = () => {
      const chatShellHeight = chatShell.clientHeight;
      if (chatShellHeight > 0) {
        setListMaxHeight(
          Math.min(
            MAX_TODO_LIST_HEIGHT,
            Math.max(MIN_TODO_LIST_HEIGHT, Math.floor(chatShellHeight * TODO_LIST_CHAT_SHARE))
          )
        );
      }

      if (
        !collapsed() &&
        !manuallyExpanded &&
        chatView &&
        hasLimitedChatRoom(chatShellHeight, chatView.clientHeight)
      ) {
        setAutomaticCollapsed(true);
      }
    };

    updateAvailableSpace();
    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => {
      const chatShellHeight = chatShell.clientHeight;
      if (chatShellHeight !== previousChatShellHeight) {
        manuallyExpanded = false;
        previousChatShellHeight = chatShellHeight;
      }
      updateAvailableSpace();
    });
    observer.observe(chatShell);
    if (chatView) observer.observe(chatView);
    onCleanup(() => observer.disconnect());
  });

  const toggleCollapsed = () => {
    const nextCollapsed = !collapsed();
    manuallyExpanded = !nextCollapsed;
    setCollapsed(nextCollapsed);
  };

  return (
    <div
      class="todo-block animate-fade-in"
      ref={(element) => {
        blockRef = element;
      }}
    >
      <button
        type="button"
        class="todo-block-header"
        onClick={toggleCollapsed}
        aria-expanded={!collapsed()}
      >
        <svg
          class={`todo-block-chevron ${collapsed() ? 'collapsed' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
        <span class="todo-block-title">Todos</span>
        <span class="todo-block-count">
          {completed()}
          <span class="todo-block-count-sep">/</span>
          {total()}
        </span>
        <Show when={collapsed() && activeTodo()}>
          {(todo) => (
            <span class="todo-block-active" title={todo().content}>
              <svg class="todo-block-active-indicators" viewBox="0 0 6 14" aria-hidden="true">
                <For each={activeTodoDots()}>
                  {(dot, index) => (
                    <circle
                      class={`todo-block-active-dot ${index() === activeTodoIndex() ? 'is-current' : ''}`}
                      cx="3"
                      cy={dot.center}
                      r={dot.radius}
                      fill="currentColor"
                    />
                  )}
                </For>
              </svg>
              <span class="todo-block-active-text">{todo().content}</span>
            </span>
          )}
        </Show>
        <div
          class="todo-block-progress"
          role="progressbar"
          aria-valuenow={completed()}
          aria-valuemin={0}
          aria-valuemax={total()}
          aria-label={`${completed()} of ${total()} todos completed`}
        >
          <div
            class={`todo-block-progress-fill ${allDone() ? 'is-complete' : ''}`}
            style={{ width: `${progress()}%` }}
          />
        </div>
      </button>
      {!collapsed() && (
        <ul
          class="todo-block-list"
          ref={(element) => {
            listRef = element;
          }}
          style={{ 'max-height': `${listMaxHeight()}px` }}
        >
          <For each={todos()}>{(todo) => <TodoItem todo={todo} />}</For>
        </ul>
      )}
    </div>
  );
}

function TodoItem(props: { todo: NormalizedTodo }) {
  const icon = () => {
    switch (props.todo.status) {
      case 'completed':
        return (
          <svg class="h-3.5 w-3.5 text-vscode-success" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="8" r="6.5" />
            <path
              d="M5 8.25l2.25 2.25L11 6.5"
              fill="none"
              stroke="var(--vscode-button-foreground, #ffffff)"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        );
      case 'cancelled':
      case 'canceled':
        return (
          <svg class="h-3.5 w-3.5 text-vscode-muted/70" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.25" />
            <path
              d="M5.5 5.5l5 5m0-5l-5 5"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        );
      case 'in_progress':
        return (
          <svg class="h-3.5 w-3.5 text-vscode-accent" viewBox="0 0 16 16">
            <circle
              cx="8"
              cy="8"
              r="6.25"
              fill="none"
              stroke="currentColor"
              stroke-width="1.25"
              opacity="0.45"
            />
            <circle cx="8" cy="8" r="3" fill="currentColor" />
          </svg>
        );
      default:
        return (
          <svg
            class="h-3.5 w-3.5 text-vscode-muted/60"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
          >
            <circle cx="8" cy="8" r="5.5" opacity="0.55" />
          </svg>
        );
    }
  };

  const statusLabel = () => {
    switch (props.todo.status) {
      case 'completed':
        return 'completed';
      case 'in_progress':
        return 'in progress';
      case 'cancelled':
      case 'canceled':
        return 'cancelled';
      default:
        return 'pending';
    }
  };
  return (
    <li class={`todo-block-item status-${props.todo.status}`} data-todo-id={props.todo.id}>
      <span class="todo-block-item-icon" role="img" aria-label={statusLabel()}>
        {icon()}
      </span>
      <span class="todo-block-item-text">{props.todo.content}</span>
    </li>
  );
}

function isResolvedTodoStatus(status: string) {
  return status === 'completed' || status === 'cancelled' || status === 'canceled';
}

function userMessageCount() {
  return defaultAppState.state.messages.filter((message) => message.info.role === 'user').length;
}

function hasLimitedChatRoom(chatShellHeight: number, chatViewHeight: number) {
  if (chatShellHeight <= 0 || chatViewHeight <= 0) return false;
  return (
    chatViewHeight < MIN_CHAT_VIEW_HEIGHT || chatViewHeight / chatShellHeight < MIN_CHAT_VIEW_SHARE
  );
}
