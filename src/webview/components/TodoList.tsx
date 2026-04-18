import { For } from 'solid-js';
import { state } from '../lib/state';
import type { Todo } from '../types';

export function TodoList() {
  const todos = () => state.todos;
  const completed = () => todos().filter((t) => t.status === 'completed').length;
  const total = () => todos().length;
  const progress = () => (total() > 0 ? (completed() / total()) * 100 : 0);

  return (
    <div class="border-b border-vscode-border/15 px-3 py-2 animate-fade-in">
      <div class="mb-1.5 flex items-center gap-1.5">
        <span class="text-[11px] font-semibold text-vscode-fg">Todos</span>
        <span class="text-[11px] text-vscode-muted/50">
          ({completed()}/{total()})
        </span>
      </div>
      <div class="mb-2 h-[2px] rounded-full bg-vscode-border/15">
        <div
          class="h-full rounded-full bg-vscode-accent transition-all duration-300"
          style={{ width: `${progress()}%` }}
        />
      </div>
      <div class="space-y-0.5">
        <For each={todos()}>{(todo) => <TodoItem todo={todo} />}</For>
      </div>
    </div>
  );
}

function TodoItem(props: { todo: Todo }) {
  const statusIcon = () => {
    switch (props.todo.status) {
      case 'completed':
        return (
          <svg class="h-3.5 w-3.5 text-vscode-success" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
        );
      case 'in_progress':
        return (
          <div class="flex h-3.5 w-3.5 items-center justify-center">
            <div class="h-2 w-2 rounded-full bg-vscode-accent animate-pulse-soft" />
          </div>
        );
      default:
        return (
          <div class="flex h-3.5 w-3.5 items-center justify-center">
            <div class="h-2.5 w-2.5 rounded-full border border-vscode-border/40" />
          </div>
        );
    }
  };

  return (
    <div
      class={`flex items-start gap-2 rounded px-1 py-0.5 text-[12px] leading-[1.4] ${
        props.todo.status === 'completed'
          ? 'text-vscode-muted/40 line-through'
          : props.todo.status === 'in_progress'
            ? 'text-vscode-fg'
            : 'text-vscode-muted/60'
      }`}
    >
      <div class="mt-[1px] shrink-0">{statusIcon()}</div>
      <span class="min-w-0">{props.todo.content}</span>
    </div>
  );
}
