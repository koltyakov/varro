import { createSignal, For, Show } from "solid-js"
import { client } from "../lib/client"
import type { Agent, Provider } from "../types"

export function ModelPicker(props: {
  onSelect: (model: { providerID: string; modelID: string; agent?: string }) => void
  onClose: () => void
}) {
  const [agents, setAgents] = createSignal<Agent[]>([])
  const [tab, setTab] = createSignal<"models" | "agents">("agents")

  ;(async () => {
    try {
      const agentList = await client.agent.list()
      setAgents(agentList.filter((a) => a.mode !== "subagent"))
    } catch {}
  })()

  return (
    <div class="fixed inset-0 z-50 flex items-end justify-center" onClick={props.onClose}>
      <div
        class="mb-12 w-[280px] rounded border border-vscode-border bg-vscode-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex border-b border-vscode-border">
          <button
            class={`flex-1 px-2 py-1.5 text-xs ${tab() === "agents" ? "border-b-2 border-vscode-accent text-vscode-fg" : "text-vscode-muted"}`}
            onClick={() => setTab("agents")}
          >
            Agents
          </button>
          <button
            class={`flex-1 px-2 py-1.5 text-xs ${tab() === "models" ? "border-b-2 border-vscode-accent text-vscode-fg" : "text-vscode-muted"}`}
            onClick={() => setTab("models")}
          >
            Models
          </button>
        </div>
        <div class="max-h-[200px] overflow-y-auto">
          <Show when={tab() === "agents"}>
            <For each={agents()}>
              {(agent) => (
                <button
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-vscode-hover"
                  onClick={() => {
                    props.onSelect({
                      providerID: agent.model?.providerID || "",
                      modelID: agent.model?.modelID || "",
                      agent: agent.name,
                    })
                    props.onClose()
                  }}
                >
                  <Show when={agent.color}>
                    <span
                      class="h-2 w-2 rounded-full"
                      style={{ "background-color": agent.color }}
                    />
                  </Show>
                  <span>{agent.name}</span>
                  <Show when={agent.description}>
                    <span class="truncate text-vscode-muted">{agent.description}</span>
                  </Show>
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}
