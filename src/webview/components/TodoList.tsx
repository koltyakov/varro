import { For } from "solid-js"
import { state } from "../lib/state"
import type { Todo } from "../types"

export function TodoList() {
  const todos = () => state.todos
  const completed = () => todos().filter((t) => t.status === "completed").length
  const total = () => todos().length
  const progress = () => total() > 0 ? (completed() / total()) * 100 : 0

  return (
    <div class="border-b border-vscode-border px-4 py-3 animate-fade-in">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-[10px] font-semibold uppercase tracking-[0.08em] text-vscode-muted">
          Tasks
        </span>
        <span class="text-[10px] text-vscode-muted">
          {completed()}/{total()}
        </span>
      </div>
      <div class="mb-3 h-0.5 bg-vscode-border/30">
        <div
          class="h-full bg-vscode-accent transition-all duration-300"
          style={{ width: `${progress()}%` }}
        />
      </div>
      <div class="space-y-1">
        <For each={todos()}>
          {(todo) => <TodoItem todo={todo} />}
        </For>
      </div>
    </div>
  )
}

function TodoItem(props: { todo: Todo }) {
  const statusIcon = () => {
    switch (props.todo.status) {
      case "completed":
        return (
          <svg class="h-3 w-3 text-vscode-success" viewBox="0 0 16 16" fill="currentColor">
            <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
          </svg>
        )
      case "in_progress":
        return (
          <div class="h-3 w-3 flex items-center justify-center">
            <div class="h-1.5 w-1.5 bg-vscode-accent animate-pulse-soft" />
          </div>
        )
      default:
        return (
          <div class="h-3 w-3 border border-vscode-border" />
        )
    }
  }

  return (
    <div class={`flex items-start gap-2 py-0.5 text-[12px] leading-5 ${
      props.todo.status === "completed"
        ? "text-vscode-muted line-through opacity-60"
        : props.todo.status === "in_progress"
          ? "text-vscode-fg"
          : "text-vscode-muted"
    }`}>
      <div class="mt-1 shrink-0">{statusIcon()}</div>
      <span class="min-w-0">{props.todo.content}</span>
    </div>
  )
}
