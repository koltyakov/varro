import { For, Show, createMemo } from "solid-js"
import {
  isModelVisible,
  isProviderVisible,
  resetModelVisibility,
  setModelVisible,
  setProviderVisible,
  setShowSettings,
  state,
} from "../lib/state"

export function SettingsPanel() {
  const hiddenProviderCount = createMemo(() => state.hiddenProviders.length)
  const hiddenModelCount = createMemo(() => state.hiddenModels.length)

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6" onClick={() => setShowSettings(false)}>
      <div
        class="flex max-h-full w-[min(680px,100%)] flex-col rounded-xl border border-vscode-border/50 bg-vscode-card shadow-[0_16px_48px_rgba(0,0,0,0.45)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="flex items-center justify-between border-b border-vscode-border/40 px-5 py-3.5">
          <div>
            <div class="text-[14px] font-semibold text-vscode-fg">Settings</div>
            <div class="mt-0.5 text-[11px] text-vscode-muted">
              Disable providers or individual models from the picker.
            </div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class="rounded-md border border-vscode-border/40 px-2.5 py-1.5 text-[11px] text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
              onClick={resetModelVisibility}
              title="Reset provider and model visibility"
            >
              Reset
            </button>
            <button
              class="rounded-md p-1 text-vscode-muted transition-colors hover:bg-vscode-hover hover:text-vscode-fg"
              onClick={() => setShowSettings(false)}
              title="Close settings"
            >
              <svg class="h-4 w-4" viewBox="0 0 16 16" fill="currentColor">
                <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
              </svg>
            </button>
          </div>
        </div>

        <div class="grid gap-3 border-b border-vscode-border/40 px-5 py-3 text-[12px] text-vscode-muted md:grid-cols-3">
          <StatBlock label="Providers" value={String(state.providers.length)} />
          <StatBlock label="Disabled Providers" value={String(hiddenProviderCount())} />
          <StatBlock label="Disabled Models" value={String(hiddenModelCount())} />
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <Show
            when={state.providers.length > 0}
            fallback={<div class="py-8 text-center text-[12px] text-vscode-muted">No providers configured</div>}
          >
            <div class="space-y-3">
              <For each={state.providers}>
                {(provider) => {
                  const models = () => Object.values(provider.models)

                  return (
                    <section class="rounded-lg border border-vscode-border/35 bg-vscode-bg/15 overflow-hidden">
                      <div class="flex items-center justify-between gap-3 border-b border-vscode-border/25 px-4 py-3">
                        <div class="min-w-0">
                          <div class="text-[13px] font-medium text-vscode-fg">{provider.name}</div>
                          <div class="mt-0.5 text-[11px] text-vscode-muted">
                            {models().length} model{models().length === 1 ? "" : "s"} available
                          </div>
                        </div>
                        <label class="inline-flex items-center gap-2 text-[11px] text-vscode-muted">
                          <input
                            type="checkbox"
                            checked={isProviderVisible(provider.id)}
                            onChange={(e) => setProviderVisible(provider.id, e.currentTarget.checked)}
                          />
                          Enabled
                        </label>
                      </div>

                      <div class="divide-y divide-vscode-border/15">
                        <For each={models()}>
                          {(model) => (
                            <div class="flex items-start justify-between gap-3 px-4 py-2.5">
                              <div class="min-w-0 flex-1">
                                <div class="text-[12px] font-medium text-vscode-fg">{model.name}</div>
                                <div class="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-vscode-muted">
                                  <span>{model.id}</span>
                                  <Show when={model.limit?.context}>
                                    <span>{formatContextLimit(model.limit!.context)} ctx</span>
                                  </Show>
                                  <Show when={Object.keys(model.variants || {}).length > 0}>
                                    <span>{Object.keys(model.variants || {}).length} levels</span>
                                  </Show>
                                </div>
                              </div>
                              <label class="inline-flex items-center gap-2 text-[11px] text-vscode-muted">
                                <input
                                  type="checkbox"
                                  checked={isModelVisible(provider.id, model.id)}
                                  disabled={!isProviderVisible(provider.id)}
                                  onChange={(e) => setModelVisible(provider.id, model.id, e.currentTarget.checked)}
                                />
                                Enabled
                              </label>
                            </div>
                          )}
                        </For>
                      </div>
                    </section>
                  )
                }}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </div>
  )
}

function StatBlock(props: { label: string; value: string }) {
  return (
    <div class="rounded-md border border-vscode-border/30 bg-vscode-bg/15 px-3 py-2">
      <div class="text-[10px] uppercase tracking-wide text-vscode-muted/70">{props.label}</div>
      <div class="mt-0.5 text-[15px] font-semibold text-vscode-fg">{props.value}</div>
    </div>
  )
}

function formatContextLimit(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(value)
}
