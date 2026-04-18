import { Show, createSignal } from "solid-js"
import type { Permission } from "../types"
import { respondPermission } from "../hooks/useOpenCode"

export function PermissionPrompt(props: { permission: Permission }) {
  const [remember, setRemember] = createSignal(false)
  const sessionId = () => props.permission.sessionID

  return (
    <div class="mx-3 my-1.5 rounded-md border border-vscode-warning/20 bg-vscode-warning/[0.03] px-3 py-2.5 animate-fade-in">
      <div class="mb-1 flex items-center gap-1.5">
        <svg class="h-3.5 w-3.5 text-vscode-warning" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 1.5a.5.5 0 01.44.27l6.5 12a.5.5 0 01-.44.73H1.5a.5.5 0 01-.44-.73l6.5-12A.5.5 0 018 1.5zM8 5a.75.75 0 00-.75.75v2.5a.75.75 0 001.5 0v-2.5A.75.75 0 008 5zm0 6a1 1 0 100-2 1 1 0 000 2z" />
        </svg>
        <span class="text-[11px] font-medium text-vscode-warning">Permission Required</span>
      </div>
      <div class="mb-2 text-[12px] leading-[1.4] text-vscode-fg">{props.permission.title}</div>
      <Show when={props.permission.metadata}>
        <div class="mb-2 max-h-[60px] overflow-y-auto rounded border border-vscode-border/20 bg-vscode-input-bg/30 p-1.5 text-[10px]">
          <pre class="whitespace-pre-wrap text-vscode-muted">
            {JSON.stringify(props.permission.metadata, null, 2)}
          </pre>
        </div>
      </Show>
      <div class="flex items-center justify-between">
        <label class="flex items-center gap-1.5 text-[10px] text-vscode-muted cursor-pointer">
          <input
            type="checkbox"
            checked={remember()}
            onChange={(e) => setRemember(e.currentTarget.checked)}
            class="accent-vscode-accent"
          />
          Remember
        </label>
        <div class="flex gap-1.5">
          <button
            class="rounded px-2.5 py-1 text-[11px] font-medium bg-vscode-hover text-vscode-fg transition-colors hover:bg-vscode-hover/80"
            onClick={() =>
              respondPermission(sessionId(), props.permission.id, "deny", remember())
            }
          >
            Deny
          </button>
          <button
            class="rounded px-2.5 py-1 text-[11px] font-medium bg-vscode-accent text-white transition-colors hover:opacity-80"
            onClick={() =>
              respondPermission(sessionId(), props.permission.id, "allow", remember())
            }
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
