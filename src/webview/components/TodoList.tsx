import { For, Show } from "solid-js"
import { state } from "../lib/state"
import type { Todo } from "../types"

export function TodoList() {
  const todos = () => state.todos

  return (
    <div class="border-b border-vscode-border px-2 py-1">
      <div class="mb-1 text-[10px] font-medium text-vscode-muted uppercase tracking-wider">
        Tasks
      </div>
      <For each={todos()}>
        {(todo) => <TodoItem todo={todo} />}
      </For>
    </div>
  )
}

function TodoItem(props: { todo: Todo }) {
  const statusColor = () => {
    switch (props.todo.status) {
      case "completed":
        return "text-vscode-success"
      case "in_progress":
        return "text-vscode-accent"
      case "cancelled":
        return "text-vscode-muted line-through"
      default:
        return "text-vscode-fg"
    }
  }

  const icon = () => {
    switch (props.todo.status) {
      case "completed":
        return "✓"
      case "in_progress":
        return "◐"
      case "cancelled":
        return "○"
      default:
        return "○"
    }
  }

  return (
    <div class={`flex items-start gap-1.5 py-0.5 text-xs ${statusColor()}`}>
      <span class="mt-0.5 shrink-0 text-[10px]">{icon()}</span>
      <span class={props.todo.status === "completed" ? "line-through opacity-70" : ""}>
        {props.todo.content}
      </span>
    </div>
  )
}
