import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js';
import { refreshSessionMcps } from '../hooks/useOpenCode';
import { parseMcpConfigSnippet } from '../../shared/mcp-config';
import type { McpConfigScope } from '../../shared/mcp-config';
import { client } from '../lib/client';
import { isBoolean } from '../lib/runtime-values';
import {
  getAvailableMcpNames,
  getEffectiveComposerSessionId,
  requestComposerFocus,
  setMcpDefaults,
  setShowMcpSettings,
  setState,
  state,
} from '../lib/state';
import { navArrowLeftIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

type McpScope = McpConfigScope;

const MCP_SCOPES: { scope: McpScope; label: string; description: string }[] = [
  {
    scope: 'global',
    label: 'Global',
    description: 'Settings here apply to every project that does not override them.',
  },
  {
    scope: 'project',
    label: 'This project',
    description: 'Settings here apply only to this project and take priority over Global.',
  },
];

export function McpSettingsPanel() {
  const [loading, setLoading] = createSignal(true);
  const [ready, setReady] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [openingConfig, setOpeningConfig] = createSignal(false);
  const [configJson, setConfigJson] = createSignal('');
  const [configName, setConfigName] = createSignal('');
  const [addedMessage, setAddedMessage] = createSignal('');
  const [error, setError] = createSignal('');
  const [scope, setScope] = createSignal<McpScope>('global');
  const [pending, setPending] = createSignal<{
    name: string;
    scope: McpScope;
    enabled: boolean;
  } | null>(null);
  let generation = 0;
  let disposed = false;
  let backButton: HTMLButtonElement | undefined;
  let tabList: HTMLDivElement | undefined;

  const names = createMemo(getAvailableMcpNames);
  const hasDefaults = () => Boolean(state.mcpDefaults);
  const activity = () => {
    if (openingConfig()) return 'Opening...';
    if (saving()) return 'Saving...';
    return loading() && hasDefaults() ? 'Refreshing...' : '';
  };
  const sessionsWorking = createMemo(() =>
    Object.values(state.sessionStatus).some(
      (status) => status?.type === 'busy' || status?.type === 'retry'
    )
  );
  // Attached servers expose only effective values, which the project scope shows.
  const activeScope = () => (state.mcpDefaults?.editable ? scope() : 'project');
  const canEditConfig = () =>
    ready() &&
    !loading() &&
    !saving() &&
    state.mcpDefaults?.editable === true &&
    !sessionsWorking();
  const canChangeDefault = (name: string, target: McpScope) =>
    canEditConfig() && (target !== 'global' || isBoolean(state.mcpDefaults?.global[name]));

  const configPreview = createMemo(() => {
    if (!configJson().trim()) return null;
    try {
      return { data: parseMcpConfigSnippet(configJson(), configName()), error: '' };
    } catch (cause) {
      return { data: null, error: cause instanceof Error ? cause.message : String(cause) };
    }
  });
  const importNames = () => Object.keys(configPreview()?.data?.servers ?? {});

  async function openConfig() {
    if (openingConfig() || saving() || state.mcpDefaults?.editable === false) return;
    const current = generation;
    setOpeningConfig(true);
    setError('');
    try {
      await client.mcp.openConfig(scope());
    } catch (cause) {
      if (!disposed && current === generation)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && current === generation) setOpeningConfig(false);
    }
  }

  async function addServers() {
    if (!canEditConfig() || !importNames().length) return;
    const current = generation;
    const target = scope();
    setSaving(true);
    setError('');
    setAddedMessage('');
    try {
      const defaults = await client.mcp.addConfig(
        target,
        configJson(),
        configName().trim() || undefined
      );
      if (disposed || current !== generation) return;
      setMcpDefaults(defaults);
      setAddedMessage(
        `Added ${importNames().join(', ')} to ${target === 'global' ? 'Global' : 'This project'}.`
      );
      setConfigJson('');
      setConfigName('');
      await refreshSessionMcps(getEffectiveComposerSessionId());
    } catch (cause) {
      if (!disposed && current === generation)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && current === generation) setSaving(false);
    }
  }

  function savedValue(name: string, target: McpScope) {
    const defaults = state.mcpDefaults;
    return (target === 'global' ? defaults?.global[name] : defaults?.effective[name]) === true;
  }

  function isChecked(name: string, target: McpScope) {
    const change = pending();
    return change?.name === name && change.scope === target
      ? change.enabled
      : savedValue(name, target);
  }

  function changeDefault(name: string, target: McpScope, input: HTMLInputElement) {
    const enabled = input.checked;
    input.checked = isChecked(name, target);
    void saveDefault(name, target, enabled);
  }

  function hasOverride(name: string) {
    return (
      isBoolean(state.mcpDefaults?.project[name]) && isBoolean(state.mcpDefaults?.global[name])
    );
  }

  function serverNote(name: string) {
    const defaults = state.mcpDefaults;
    if (scope() !== 'global' || !defaults?.editable) return '';
    if (!isBoolean(defaults.global[name])) return 'Only configured in this project';
    if (isBoolean(defaults.project[name]) && defaults.project[name] !== defaults.global[name])
      return defaults.project[name] ? 'On in this project' : 'Off in this project';
    return '';
  }

  function serverProblem(name: string) {
    const status = state.mcpStatus[name];
    if (status?.error) return status.error;
    return status?.status === 'needs_auth' || status?.status === 'needs_client_registration'
      ? status.status.replaceAll('_', ' ')
      : '';
  }

  function moveTab(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = MCP_SCOPES.find((item) => item.scope !== scope());
    if (!next) return;
    setScope(next.scope);
    tabList?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }

  async function load() {
    const current = ++generation;
    setLoading(true);
    setReady(false);
    setSaving(false);
    setOpeningConfig(false);
    setPending(null);
    setError('');
    try {
      const defaults = await client.mcp.defaults();
      if (disposed || current !== generation) return;
      setMcpDefaults(defaults);
      setReady(true);
    } catch (cause) {
      if (!disposed && current === generation)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && current === generation) setLoading(false);
    }
  }

  async function saveDefault(name: string, target: McpScope, enabled: boolean | null) {
    if (!canChangeDefault(name, target)) return;
    const current = generation;
    setSaving(true);
    setError('');
    if (enabled !== null) setPending({ name, scope: target, enabled });
    try {
      const defaults = await client.mcp.setDefault(name, target, enabled);
      if (disposed || current !== generation) return;
      setMcpDefaults(defaults);
      await refreshSessionMcps(getEffectiveComposerSessionId());
    } catch (cause) {
      if (!disposed && current === generation)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && current === generation) {
        setPending(null);
        setSaving(false);
      }
    }
  }

  createEffect(
    on(
      () => state.editorContext.workspacePath,
      (workspacePath, previous) => {
        // Startup values belong to the workspace that loaded them.
        if (previous !== undefined && previous !== workspacePath) {
          setState('mcpDefaults', null);
          setConfigJson('');
          setConfigName('');
          setAddedMessage('');
        }
        void load();
      }
    )
  );
  onMount(() => backButton?.focus());
  onCleanup(() => {
    disposed = true;
    generation += 1;
  });

  return (
    <section class="mcp-settings-panel" aria-label="MCP settings">
      <header class="mcp-settings-header">
        <div class="mcp-settings-header-inner">
          <button
            ref={(element) => {
              backButton = element;
            }}
            type="button"
            class="chat-header-btn"
            aria-label="Back"
            onClick={() => {
              setShowMcpSettings(false);
              requestComposerFocus();
            }}
          >
            <UiIcon source={navArrowLeftIcon} width={16} height={16} />
          </button>
          <h1>MCP settings</h1>
          <Show when={activity()}>
            <span class="mcp-settings-saving" role="status">
              {activity()}
            </span>
          </Show>
        </div>
      </header>
      <div class="mcp-settings-body">
        <div class="mcp-settings-content">
          <p class="mcp-settings-description">
            Checked servers connect when OpenCode starts. Others stay available in the session
            picker.
          </p>
          <div>
            <button
              type="button"
              disabled={openingConfig() || saving() || state.mcpDefaults?.editable === false}
              onClick={() => void openConfig()}
            >
              Open OpenCode config
            </button>
          </div>
          <Show when={error()}>
            <div class="mcp-settings-error" role="alert">
              <span>
                {error()}
                <Show when={!ready() && hasDefaults()}>
                  {' '}
                  Showing the last loaded settings. Retry to change them.
                </Show>
              </span>
              <Show when={!ready()}>
                <button type="button" onClick={() => void load()}>
                  Retry
                </button>
              </Show>
            </div>
          </Show>
          <Show when={loading() && !hasDefaults()}>
            <div class="chat-messages-loading" role="status" aria-label="Loading MCP settings">
              <span class="chat-messages-loading-dot" />
              <span class="chat-messages-loading-dot" style={{ 'animation-delay': '0.3s' }} />
              <span class="chat-messages-loading-dot" style={{ 'animation-delay': '0.6s' }} />
            </div>
          </Show>
          <Show when={hasDefaults()}>
            <Show
              when={!state.mcpDefaults?.editable}
              fallback={
                <Show when={sessionsWorking()}>
                  <p class="mcp-settings-notice" role="status">
                    Defaults can be changed when running sessions finish. Session toggles remain
                    available in the picker.
                  </p>
                </Show>
              }
            >
              <p class="mcp-settings-notice">
                This server is managed elsewhere. Edit its MCP defaults on the OpenCode server host.
              </p>
            </Show>
            <Show when={state.mcpDefaults?.editable}>
              <div
                ref={(element) => {
                  tabList = element;
                }}
                class="mcp-settings-tabs"
                role="tablist"
                aria-label="Settings scope"
                onKeyDown={moveTab}
              >
                <For each={MCP_SCOPES}>
                  {(item) => (
                    <button
                      type="button"
                      role="tab"
                      id={`mcp-settings-tab-${item.scope}`}
                      aria-selected={scope() === item.scope}
                      aria-controls="mcp-settings-tabpanel"
                      tabIndex={scope() === item.scope ? 0 : -1}
                      disabled={saving() || openingConfig()}
                      onClick={() => setScope(item.scope)}
                    >
                      {item.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div
              id="mcp-settings-tabpanel"
              class="mcp-settings-tabpanel"
              role={state.mcpDefaults?.editable ? 'tabpanel' : undefined}
              aria-labelledby={
                state.mcpDefaults?.editable ? `mcp-settings-tab-${scope()}` : undefined
              }
            >
              <Show when={state.mcpDefaults?.editable}>
                <p class="mcp-settings-note">
                  {MCP_SCOPES.find((item) => item.scope === scope())?.description}
                </p>
              </Show>
              <Show
                when={names().length > 0}
                fallback={<p class="mcp-settings-note">No MCP servers configured.</p>}
              >
                <div class="mcp-settings-servers" aria-busy={saving() || loading()}>
                  <For each={names()}>
                    {(name) => (
                      <div class="mcp-settings-server">
                        <label class="mcp-settings-server-toggle">
                          <input
                            type="checkbox"
                            checked={isChecked(name, activeScope())}
                            disabled={!canChangeDefault(name, activeScope())}
                            onChange={(event) =>
                              changeDefault(name, activeScope(), event.currentTarget)
                            }
                          />
                          <span>{name}</span>
                        </label>
                        <Show
                          when={
                            state.mcpDefaults?.editable &&
                            scope() === 'project' &&
                            hasOverride(name)
                          }
                        >
                          <button
                            type="button"
                            class="mcp-settings-reset"
                            aria-label={`Use global setting for ${name}`}
                            disabled={!canChangeDefault(name, 'project')}
                            onClick={() => void saveDefault(name, 'project', null)}
                          >
                            Use global
                          </button>
                        </Show>
                        <Show when={serverNote(name)}>
                          <p class="mcp-settings-server-detail mcp-settings-note">
                            {serverNote(name)}
                          </p>
                        </Show>
                        <Show when={serverProblem(name)}>
                          <p class="mcp-settings-server-detail mcp-settings-server-error">
                            {serverProblem(name)}
                          </p>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={state.mcpDefaults?.editable}>
                <form
                  class="mcp-settings-import"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void addServers();
                  }}
                >
                  <h2>Add MCP servers</h2>
                  <p class="mcp-settings-note">
                    Paste a server entry, a map of named servers, or JSON containing mcp,
                    mcp.servers, or mcpServers. Existing entries are not replaced.
                  </p>
                  <label>
                    MCP JSON
                    <textarea
                      rows={8}
                      value={configJson()}
                      spellcheck={false}
                      disabled={saving()}
                      placeholder={`{
  "browser-bridge": {
    "type": "local",
    "command": ["bbx", "mcp", "serve"]
  }
}`}
                      onInput={(event) => {
                        setConfigJson(event.currentTarget.value);
                        setAddedMessage('');
                      }}
                    />
                  </label>
                  <Show when={configPreview()?.data?.requiresName}>
                    <label>
                      Server name
                      <input
                        value={configName()}
                        disabled={saving()}
                        onInput={(event) => setConfigName(event.currentTarget.value)}
                        placeholder="my-server"
                      />
                    </label>
                  </Show>
                  <Show when={configPreview()?.error}>
                    <p class="mcp-settings-server-error" role="alert">
                      {configPreview()?.error}
                    </p>
                  </Show>
                  <Show when={importNames().length > 0}>
                    <p class="mcp-settings-note" role="status">
                      Detected servers: {importNames().join(', ')}. Add to{' '}
                      {scope() === 'global' ? 'Global' : 'This project'}.
                    </p>
                  </Show>
                  <Show when={addedMessage()}>
                    <p class="mcp-settings-note" role="status">
                      {addedMessage()}
                    </p>
                  </Show>
                  <div>
                    <button type="submit" disabled={!canEditConfig() || importNames().length === 0}>
                      Add MCP servers
                    </button>
                  </div>
                </form>
              </Show>
            </div>
          </Show>
        </div>
      </div>
    </section>
  );
}
