import { Show, createSignal } from "solid-js"
import type { Permission } from "../types"
import { respondPermission } from "../hooks/useOpenCode"
import { state } from "../lib/state"

export function PermissionPrompt(props: { permission: Permission }) {
  const [remember, setRemember] = createSignal(false)
  const sessionId = () => props.permission.sessionID

  return (
    <div class="mx-2 my-1 rounded border border-vscode-warning bg-vscode-card px-3 py-2">
      <div class="mb-2 text-xs font-medium text-vscode-warning">Permission Required</div>
      <div class="mb-2 text-xs">{props.permission.title}</div>
      <Show when={props.permission.metadata}>
        <div class="mb-2 max-h-[100px] overflow-y-auto rounded bg-vscode-input-bg p-1.5 text-[10px]">
          <pre class="whitespace-pre-wrap text-vscode-muted">
            {JSON.stringify(props.permission.metadata, null, 2)}
          </pre>
        </div>
      </Show>
      <div class="flex items-center justify-between">
        <label class="flex items-center gap-1 text-[10px] text-vscode-muted">
          <input
            type="checkbox"
            checked={remember()}
            onChange={(e) => setRemember(e.currentTarget.checked)}
            class="h-3 w-3"
          />
          Remember for this session
        </label>
        <div class="flex gap-1">
          <button
            class="rounded px-2 py-0.5 text-xs bg-vscode-input-bg text-vscode-fg hover:bg-vscode-hover"
            onClick={() =>
              respondPermission(sessionId(), props.permission.id, "deny", remember())
            }
          >
            Deny
          </button>
          <button
            class="rounded px-2 py-0.5 text-xs bg-vscode-button-bg text-vscode-button-fg hover:bg-vscode-button-hover"
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
