import { For } from 'solid-js';
import { state } from '../lib/state';
import type { Todo } from '../types';

export function TodoList(props: { placement?: 'section' | 'composer' }) {
  const todos = () => state.todos;
  const completed = () => todos().filter((t) => t.status === 'completed').length;
  const total = () => todos().length;
  const progress = () => (total() > 0 ? (completed() / total()) * 100 : 0);
  const isComposer = () => props.placement === 'composer';
  const listClass = () =>
    isComposer() ? 'space-y-1 max-h-36 overflow-y-auto pr-1' : 'space-y-0.5';

  return (
    <div
      class={
        isComposer()
          ? '-mx-[10px] -mt-[8px] mb-2 border-b border-vscode-border/15 px-3 py-2.5 animate-fade-in'
          : 'border-b border-vscode-border/15 px-3 py-2 animate-fade-in'
      }
      style={
        isComposer()
          ? {
              background:
                'linear-gradient(180deg, color-mix(in srgb, var(--color-vscode-widget-bg) 76%, transparent) 0%, color-mix(in srgb, var(--color-vscode-widget-bg) 42%, transparent) 100%)',
            }
          : undefined
      }
    >
      <div class="mb-2 flex items-center justify-between gap-3">
        <div class="flex items-center gap-1.5">
          <span class="text-[11px] font-semibold uppercase tracking-[0.08em] text-vscode-fg/90">
            Todos
          </span>
          <span class="text-[11px] text-vscode-muted/60">
            {completed()}/{total()}
          </span>
        </div>
        <span
          class="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
          style={{
            color:
              progress() === 100
                ? 'var(--color-vscode-success)'
                : 'color-mix(in srgb, var(--color-vscode-accent) 78%, var(--color-vscode-fg))',
            'border-color':
              progress() === 100
                ? 'color-mix(in srgb, var(--color-vscode-success) 30%, transparent)'
                : 'color-mix(in srgb, var(--color-vscode-accent) 25%, transparent)',
            background:
              progress() === 100
                ? 'color-mix(in srgb, var(--color-vscode-success) 10%, transparent)'
                : 'color-mix(in srgb, var(--color-vscode-accent) 10%, transparent)',
          }}
        >
          {Math.round(progress())}%
        </span>
      </div>
      <div class="mb-2.5 h-[3px] rounded-full bg-vscode-border/15">
        <div
          class="h-full rounded-full bg-vscode-accent transition-all duration-300"
          style={{ width: `${progress()}%` }}
        />
      </div>
      <div class={listClass()}>
        <For each={todos()}>{(todo) => <TodoItem todo={todo} placement={props.placement} />}</For>
      </div>
    </div>
  );
}

function TodoItem(props: { todo: Todo; placement?: 'section' | 'composer' }) {
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
  const statusLabel = () => {
    switch (props.todo.status) {
      case 'completed':
        return 'Done';
      case 'in_progress':
        return 'Active';
      default:
        return 'Queued';
    }
  };
  const itemClass = () => {
    if (props.placement !== 'composer') {
      return `flex items-start gap-2 rounded px-1 py-0.5 text-[12px] leading-[1.4] ${
        props.todo.status === 'completed'
          ? 'text-vscode-muted/40 line-through'
          : props.todo.status === 'in_progress'
            ? 'text-vscode-fg'
            : 'text-vscode-muted/60'
      }`;
    }

    return `flex items-start gap-2.5 rounded-md border px-2 py-1.5 text-[12px] leading-[1.4] ${
      props.todo.status === 'completed'
        ? 'border-vscode-border/12 bg-vscode-card/15 text-vscode-muted/55'
        : props.todo.status === 'in_progress'
          ? 'border-vscode-accent/25 bg-vscode-accent/[0.08] text-vscode-fg'
          : 'border-vscode-border/10 bg-vscode-card/10 text-vscode-muted/75'
    }`;
  };
  const badgeStyle = () => {
    switch (props.todo.status) {
      case 'completed':
        return {
          color: 'var(--color-vscode-success)',
          'border-color': 'color-mix(in srgb, var(--color-vscode-success) 26%, transparent)',
          background: 'color-mix(in srgb, var(--color-vscode-success) 10%, transparent)',
        };
      case 'in_progress':
        return {
          color: 'color-mix(in srgb, var(--color-vscode-accent) 82%, var(--color-vscode-fg))',
          'border-color': 'color-mix(in srgb, var(--color-vscode-accent) 24%, transparent)',
          background: 'color-mix(in srgb, var(--color-vscode-accent) 10%, transparent)',
        };
      default:
        return {
          color: 'color-mix(in srgb, var(--color-vscode-muted) 82%, var(--color-vscode-fg))',
          'border-color': 'color-mix(in srgb, var(--color-vscode-border) 20%, transparent)',
          background: 'color-mix(in srgb, var(--color-vscode-widget-bg) 56%, transparent)',
        };
    }
  };

  return (
    <div class={itemClass()}>
      <div class="mt-[1px] shrink-0">{statusIcon()}</div>
      <div class="min-w-0 flex-1">
        <div class={props.todo.status === 'completed' ? 'line-through' : ''}>
          {props.todo.content}
        </div>
      </div>
      {props.placement === 'composer' && (
        <span
          class="mt-px shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
          style={badgeStyle()}
        >
          {statusLabel()}
        </span>
      )}
    </div>
  );
}
