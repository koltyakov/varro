import { For, createSignal } from 'solid-js';
import { state } from '../lib/state';
import type { Todo } from '../types';

export function TodoList() {
  const todos = () => state.todos;
  const completed = () => todos().filter((t) => t.status === 'completed').length;
  const total = () => todos().length;
  const progress = () => (total() > 0 ? (completed() / total()) * 100 : 0);
  const allDone = () => total() > 0 && completed() === total();
  const [collapsed, setCollapsed] = createSignal(allDone());

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
        <div class="todo-block-progress" aria-hidden="true">
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

function TodoItem(props: { todo: Todo }) {
  const icon = () => {
    switch (props.todo.status) {
      case 'completed':
        return (
          <svg class="h-3.5 w-3.5 text-vscode-success" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="8" r="6.5" />
            <path
              d="M5 8.25l2.25 2.25L11 6.5"
              fill="none"
              stroke="var(--vscode-editor-background, #1e1e1e)"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
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

  return (
    <li class={`todo-block-item status-${props.todo.status}`}>
      <span class="todo-block-item-icon">{icon()}</span>
      <span class="todo-block-item-text">{props.todo.content}</span>
    </li>
  );
}
