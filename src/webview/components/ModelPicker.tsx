import { createMemo, createSignal, For, Show } from "solid-js"
import { getVisibleProviders, state } from "../lib/state"

interface Selection {
  providerID?: string
  modelID?: string
  variant?: string
  agent?: string
}

export function ModelPicker(props: {
  onSelect: (sel: Selection) => void
  onClose: () => void
}) {
  const [tab, setTab] = createSignal<"agents" | "models">("agents")
  const visibleProviders = createMemo(() => getVisibleProviders(state.providers))

  return (
    <div class="fixed inset-0 z-50 flex items-end justify-center" onClick={props.onClose}>
      <div
        class="mb-16 w-[min(380px,calc(100%-2rem))] overflow-hidden rounded-lg border border-vscode-border bg-vscode-card shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
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
                    class={`flex w-full items-start gap-3 px-4 py-2.5 text-left text-[13px] transition-colors hover:bg-vscode-hover ${
                      state.selectedAgent === agent.name ? "bg-vscode-hover" : ""
                    }`}
                    onClick={() => {
                      props.onSelect({ agent: agent.name })
                      props.onClose()
                    }}
                  >
                    <span
                      class="mt-1 h-2 w-2 shrink-0 rounded-full"
                      style={{ "background-color": agent.color || "var(--color-vscode-muted)" }}
                    />
                    <div class="min-w-0 flex-1">
                      <div class="font-medium">{agent.name}</div>
                      <Show when={agent.description}>
                        <div class="line-clamp-2 text-[11px] text-vscode-muted">{agent.description}</div>
                      </Show>
                    </div>
                    <Show when={state.selectedAgent === agent.name}>
                      <span class="text-vscode-accent text-xs">✓</span>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </Show>
          <Show when={tab() === "models"}>
            <Show
              when={visibleProviders().length > 0}
              fallback={<EmptyState label="No providers configured" />}
            >
              <For each={visibleProviders()}>
                {(provider) => (
                  <div>
                    <div class="bg-vscode-sidebar px-4 py-1.5 text-[10px] uppercase tracking-wider text-vscode-muted">
                      {provider.name}
                    </div>
                    <For each={Object.values(provider.models)}>
                      {(model) => (
                        <div class="border-t border-vscode-border/25">
                          <button
                            class={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-[13px] transition-colors hover:bg-vscode-hover ${
                              state.selectedModel?.providerID === provider.id &&
                              state.selectedModel?.modelID === model.id &&
                              !state.selectedModel?.variant
                                ? "bg-vscode-hover"
                                : ""
                            }`}
                            onClick={() => {
                              props.onSelect({ providerID: provider.id, modelID: model.id, variant: undefined })
                              props.onClose()
                            }}
                          >
                            <span class="min-w-0 truncate">{model.name}</span>
                            <Show
                              when={
                                state.selectedModel?.providerID === provider.id &&
                                state.selectedModel?.modelID === model.id &&
                                !state.selectedModel?.variant
                              }
                            >
                              <span class="text-vscode-accent text-xs">✓</span>
                            </Show>
                          </button>
                          <Show when={Object.keys(model.variants || {}).length > 0}>
                            <div class="flex flex-wrap gap-1 px-4 pb-2">
                              <For each={Object.keys(model.variants || {})}>
                                {(variant) => (
                                  <button
                                    class={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                                      state.selectedModel?.providerID === provider.id &&
                                      state.selectedModel?.modelID === model.id &&
                                      state.selectedModel?.variant === variant
                                        ? "border-vscode-accent/40 bg-vscode-accent/8 text-vscode-fg"
                                        : "border-vscode-border/40 text-vscode-muted hover:bg-vscode-hover hover:text-vscode-fg"
                                    }`}
                                    onClick={() => {
                                      props.onSelect({ providerID: provider.id, modelID: model.id, variant })
                                      props.onClose()
                                    }}
                                    title={`Thinking level: ${formatThinkingLabel(variant)}`}
                                  >
                                    {formatThinkingLabel(variant)}
                                  </button>
                                )}
                              </For>
                            </div>
                          </Show>
                        </div>
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
      class={`flex-1 px-3 py-2.5 text-[13px] font-medium transition-colors ${
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
  return <div class="px-4 py-8 text-center text-[12px] text-vscode-muted">{props.label}</div>
}

function formatThinkingLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}
