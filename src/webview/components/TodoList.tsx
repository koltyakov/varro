import { For, createSignal } from 'solid-js';
import { state } from '../lib/state';
import type { Todo } from '../types';

export function TodoList() {
  const todos = () => state.todos;
  const completed = () => todos().filter((t) => t.status === 'completed').length;
  const total = () => todos().length;
  const [collapsed, setCollapsed] = createSignal(false);

  return (
    <div class="-mx-2.5 -mt-2 mb-2 bg-black/20 px-3 pt-2 pb-3 animate-fade-in">
      <button
        type="button"
        class="flex w-full items-center gap-1.5 text-left text-[12px] text-vscode-fg/85 hover:text-vscode-fg focus:outline-none focus-visible:outline-none"
        onClick={() => setCollapsed(!collapsed())}
      >
        <svg
          class={`h-3 w-3 shrink-0 text-vscode-muted/70 transition-transform ${collapsed() ? '-rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="currentColor"
        >
          <path d="M4.5 6.5l3.5 3.5 3.5-3.5z" />
        </svg>
        <span class="font-medium">Todos</span>
        <span class="text-vscode-muted/70">
          ({completed()}/{total()})
        </span>
      </button>
      {!collapsed() && (
        <ul class="mt-1.5 space-y-0.5">
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
          <svg
            class="h-3.5 w-3.5 text-vscode-success"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <circle cx="8" cy="8" r="6.25" />
            <path d="M5 8.25l2.25 2.25L11 6.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        );
      case 'in_progress':
        return (
          <svg class="h-3.5 w-3.5 text-vscode-accent" viewBox="0 0 16 16" fill="currentColor">
            <circle cx="8" cy="8" r="4" />
          </svg>
        );
      default:
        return (
          <svg
            class="h-3.5 w-3.5 text-vscode-muted/55"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.25"
          >
            <circle cx="8" cy="8" r="5" />
          </svg>
        );
    }
  };
  const textClass = () => {
    switch (props.todo.status) {
      case 'completed':
        return 'text-vscode-muted/55';
      case 'in_progress':
        return 'text-vscode-fg';
      default:
        return 'text-vscode-fg/80';
    }
  };

  return (
    <li class="flex items-center gap-2 text-[12px] leading-normal">
      <span class="shrink-0">{icon()}</span>
      <span class={`min-w-0 flex-1 truncate ${textClass()}`}>{props.todo.content}</span>
    </li>
  );
}
