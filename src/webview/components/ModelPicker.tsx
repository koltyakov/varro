import { createSignal, For, Show } from "solid-js"
import { state } from "../lib/state"

interface Selection {
  providerID?: string
  modelID?: string
  agent?: string
}

export function ModelPicker(props: {
  onSelect: (sel: Selection) => void
  onClose: () => void
}) {
  const [tab, setTab] = createSignal<"agents" | "models">("agents")

  return (
    <div class="fixed inset-0 z-50 flex items-end justify-center" onClick={props.onClose}>
      <div
        class="mb-20 w-[min(380px,calc(100%-1rem))] overflow-hidden rounded-md border border-vscode-border bg-vscode-card shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex border-b border-vscode-border">
          <TabButton
            active={tab() === "agents"}
            onClick={() => setTab("agents")}
            label={`Agents (${state.agents.length})`}
          />
          <TabButton
            active={tab() === "models"}
            onClick={() => setTab("models")}
            label="Models"
          />
        </div>
        <div class="max-h-[320px] overflow-y-auto">
          <Show when={tab() === "agents"}>
            <Show
              when={state.agents.length > 0}
              fallback={<EmptyState label="No agents available" />}
            >
              <For each={state.agents}>
                {(agent) => (
                  <button
                    class={`flex w-full items-start gap-3 px-4 py-3 text-left text-sm hover:bg-vscode-hover ${
                      state.selectedAgent === agent.name ? "bg-vscode-hover" : ""
                    }`}
                    onClick={() => {
                      props.onSelect({ agent: agent.name })
                      props.onClose()
                    }}
                  >
                    <span
                      class="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ "background-color": agent.color || "var(--color-vscode-muted)" }}
                    />
                    <div class="min-w-0 flex-1">
                      <div class="font-medium">{agent.name}</div>
                      <Show when={agent.description}>
                        <div class="line-clamp-2 text-[12px] text-vscode-muted">{agent.description}</div>
                      </Show>
                    </div>
                    <Show when={state.selectedAgent === agent.name}>
                      <span class="text-vscode-accent">✓</span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </Show>
          <Show when={tab() === "models"}>
            <Show
              when={state.providers.length > 0}
              fallback={<EmptyState label="No providers configured" />}
            >
              <button
                class={`flex w-full items-center justify-between gap-2 border-b border-vscode-border px-4 py-2.5 text-left text-sm hover:bg-vscode-hover ${
                  state.selectedModel === null ? "bg-vscode-hover" : ""
                }`}
                onClick={() => {
                  props.onSelect({ providerID: undefined, modelID: undefined })
                  props.onClose()
                }}
              >
                <span class="min-w-0 truncate font-medium">Automatic</span>
                <Show when={state.selectedModel === null}>
                  <span class="text-vscode-accent">✓</span>
                </Show>
              </button>
              <For each={state.providers}>
                {(provider) => (
                  <div>
                    <div class="bg-vscode-sidebar px-4 py-1.5 text-[11px] uppercase tracking-wider text-vscode-muted">
                      {provider.name}
                    </div>
                    <For each={Object.values(provider.models)}>
                      {(model) => (
                        <button
                          class={`flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left text-sm hover:bg-vscode-hover ${
                            state.selectedModel?.providerID === provider.id &&
                            state.selectedModel?.modelID === model.id
                              ? "bg-vscode-hover"
                              : ""
                          }`}
                          onClick={() => {
                            props.onSelect({ providerID: provider.id, modelID: model.id })
                            props.onClose()
                          }}
                        >
                          <span class="min-w-0 truncate">{model.name}</span>
                          <Show
                            when={
                              state.selectedModel?.providerID === provider.id &&
                              state.selectedModel?.modelID === model.id
                            }
                          >
                            <span class="text-vscode-accent">✓</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}

function TabButton(props: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      class={`flex-1 px-3 py-2 text-sm transition-colors ${
        props.active
          ? "border-b-2 border-vscode-accent text-vscode-fg"
          : "border-b-2 border-transparent text-vscode-muted hover:text-vscode-fg"
      }`}
      onClick={props.onClick}
    >
      {props.label}
    </button>
  )
}

function EmptyState(props: { label: string }) {
  return <div class="px-4 py-8 text-center text-sm text-vscode-muted">{props.label}</div>
}
