import { For, createEffect, createSignal } from 'solid-js';
import { defaultAppState } from '../lib/state';
import type { NormalizedTodo } from '../types';

const todos = () => defaultAppState.state.todos;

export function TodoList() {
  const completed = () => todos().filter((todo) => isResolvedTodoStatus(todo.status)).length;
  const total = () => todos().length;
  const progress = () => (total() > 0 ? (completed() / total()) * 100 : 0);
  const allDone = () => total() > 0 && completed() === total();
  const [collapsed, setCollapsed] = createSignal(allDone());
  let previousTodoIds = new Set(todos().map((todo) => todo.id));
  let previousUserMessageCount = userMessageCount();
  let previousAllDone = allDone();

  createEffect(() => {
    const nextTodoIds = new Set(todos().map((todo) => todo.id));
    const hasNewTodo = todos().some((todo) => !previousTodoIds.has(todo.id));
    const nextUserMessageCount = userMessageCount();
    const nextAllDone = allDone();

    if (nextAllDone && !previousAllDone) {
      setCollapsed(true);
    } else if (hasNewTodo) {
      setCollapsed(false);
    } else if (nextUserMessageCount > previousUserMessageCount && nextAllDone) {
      setCollapsed(true);
    }

    previousTodoIds = nextTodoIds;
    previousUserMessageCount = nextUserMessageCount;
    previousAllDone = nextAllDone;
  });

  return (
    <div class="todo-block animate-fade-in">
      <button
        type="button"
        class="todo-block-header"
        onClick={() => setCollapsed(!collapsed())}
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
        <ul class="todo-block-list">
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
    <li class={`todo-block-item status-${props.todo.status}`}>
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
