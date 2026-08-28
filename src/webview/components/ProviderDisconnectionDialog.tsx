import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { Provider } from '../types';
import { postMessage } from '../lib/bridge';
import { client } from '../lib/client';
import { trapModalFocus } from '../lib/modal-focus';
import { openProviderLogout } from '../lib/provider-setup';
import { arrowLeftIcon, xmarkIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

export function ProviderDisconnectionDialog(props: {
  catalogProviders: Provider[];
  connectedProviderIDs: string[];
  providerLoadError: string;
  isLoadingProviders: boolean;
  initialProviderID?: string | null;
  providerConfigPaths?: Record<string, string[]>;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal('');
  const [selectedProviderID, setSelectedProviderID] = createSignal<string | null>(
    props.initialProviderID ?? null
  );
  const [isDeleting, setIsDeleting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');

  const providers = createMemo(() => {
    if (props.isLoadingProviders) return [];
    const catalog = new Map(props.catalogProviders.map((provider) => [provider.id, provider]));
    const providerIDs = [...props.connectedProviderIDs];
    const initialProviderID = props.initialProviderID;
    if (
      initialProviderID &&
      initialProviderID !== 'opencode' &&
      catalog.has(initialProviderID) &&
      !providerIDs.includes(initialProviderID)
    ) {
      providerIDs.push(initialProviderID);
    }
    return providerIDs
      .filter((id) => id !== 'opencode')
      .map((id) => ({
        id,
        name: catalog.get(id)?.name ?? formatProviderID(id),
        source: catalog.get(id)?.source,
        env: catalog.get(id)?.env ?? [],
        connected: props.connectedProviderIDs.includes(id),
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  });
  const filteredProviders = createMemo(() => {
    const search = query().trim().toLocaleLowerCase();
    if (!search) return providers();
    return providers().filter((provider) =>
      [provider.name, provider.id].some((value) => value.toLocaleLowerCase().includes(search))
    );
  });
  const selectedProvider = createMemo(() =>
    providers().find((provider) => provider.id === selectedProviderID())
  );
  const selectedProviderConfigPaths = createMemo(
    () => props.providerConfigPaths?.[selectedProviderID() ?? ''] ?? []
  );

  createEffect(() => {
    if (props.isLoadingProviders || !selectedProviderID()) return;
    if (!selectedProvider()) setSelectedProviderID(null);
  });

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });

  async function disconnect() {
    const provider = selectedProvider();
    if (!provider || isDeleting()) return;
    setIsDeleting(true);
    setErrorMessage('');
    try {
      await client.config.disconnectProvider(provider.id);
      postMessage({ type: 'providers/auth-changed' });
      props.onClose();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsDeleting(false);
    }
  }

  function useTerminal() {
    openProviderLogout();
    props.onClose();
  }

  return (
    <Portal>
      <div class="provider-connect-overlay">
        <div
          ref={(element) => onCleanup(trapModalFocus(element))}
          class="provider-connect-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-disconnect-title"
        >
          <div class="provider-connect-header">
            <div>
              <div id="provider-disconnect-title" class="provider-connect-title">
                Disconnect provider
              </div>
              <Show when={selectedProvider()}>
                {(provider) => <div class="provider-connect-subtitle">{provider().name}</div>}
              </Show>
            </div>
            <button
              type="button"
              class="provider-connect-close"
              onClick={props.onClose}
              aria-label="Close"
            >
              <UiIcon source={xmarkIcon} width={16} height={16} aria-hidden="true" />
            </button>
          </div>

          <div
            class="provider-connect-body"
            classList={{ 'is-provider-list': !selectedProviderID() }}
          >
            <Show
              when={selectedProvider()}
              fallback={
                <div class="provider-connect-provider-step">
                  <div class="provider-connect-intro">
                    Choose a provider credential to remove from OpenCode.
                  </div>
                  <Show when={!props.isLoadingProviders} fallback={<DisconnectListSkeleton />}>
                    <div class="provider-connect-picker">
                      <input
                        class="provider-connect-search"
                        type="text"
                        value={query()}
                        onInput={(event) => setQuery(event.currentTarget.value)}
                        placeholder="Search connected providers"
                        aria-label="Search connected providers"
                        autocomplete="off"
                      />
                      <div
                        class="provider-connect-options provider-disconnect-options"
                        role="listbox"
                      >
                        <For each={filteredProviders()}>
                          {(provider) => (
                            <button
                              type="button"
                              class="provider-connect-option"
                              role="option"
                              aria-selected="false"
                              onClick={() => setSelectedProviderID(provider.id)}
                            >
                              <span class="provider-connect-option-name">{provider.name}</span>
                              <Show
                                when={
                                  provider.name.toLocaleLowerCase() !==
                                  provider.id.toLocaleLowerCase()
                                }
                              >
                                <span class="provider-connect-option-id">{provider.id}</span>
                              </Show>
                            </button>
                          )}
                        </For>
                        <Show when={filteredProviders().length === 0}>
                          <div class="provider-connect-empty">No connected providers found.</div>
                        </Show>
                      </div>
                    </div>
                  </Show>
                  <Show when={props.providerLoadError}>
                    <div class="provider-connect-error" role="alert">
                      Could not load connected providers. {props.providerLoadError}
                    </div>
                  </Show>
                </div>
              }
            >
              {(provider) => (
                <div class="provider-connect-form">
                  <button
                    type="button"
                    class="provider-connect-back"
                    onClick={() => {
                      setSelectedProviderID(null);
                      setErrorMessage('');
                    }}
                  >
                    <UiIcon source={arrowLeftIcon} width={11} height={11} aria-hidden="true" />
                    Back to providers
                  </button>
                  <div class="provider-disconnect-confirmation">
                    <Show
                      when={provider().connected}
                      fallback={
                        <>
                          <strong>{provider().name}</strong> has no saved credential to disconnect.
                        </>
                      }
                    >
                      Remove the saved credential for <strong>{provider().name}</strong>?
                    </Show>
                  </div>
                  <Show
                    when={
                      provider().source === 'config' || selectedProviderConfigPaths().length > 0
                    }
                  >
                    <div class="provider-disconnect-config-notice">
                      <span>
                        This provider is configured in OpenCode config. Disconnecting its saved
                        credential may not remove it until you update the config.
                      </span>
                      <For each={selectedProviderConfigPaths()}>
                        {(path) => (
                          <button
                            type="button"
                            title={path}
                            onClick={() =>
                              postMessage({
                                type: 'vscode/open',
                                payload: { path, kind: 'file' },
                              })
                            }
                          >
                            Open {formatConfigFilename(path)}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={provider().source === 'env'}>
                    <div class="provider-disconnect-config-notice">
                      This provider is supplied by environment credentials
                      <Show when={provider().env.length > 0}>
                        {` (${provider().env.join(', ')})`}
                      </Show>
                      . Disconnecting a saved credential will not remove it while those credentials
                      remain available to OpenCode.
                    </div>
                  </Show>
                  <Show when={errorMessage()}>
                    <div class="provider-connect-error" role="alert">
                      {errorMessage()}
                    </div>
                  </Show>
                  <div class="provider-connect-actions">
                    <button
                      type="button"
                      class="provider-connect-secondary"
                      onClick={() => setSelectedProviderID(null)}
                      disabled={isDeleting()}
                    >
                      Cancel
                    </button>
                    <Show when={provider().connected}>
                      <button
                        type="button"
                        class="provider-connect-danger"
                        onClick={() => void disconnect()}
                        disabled={isDeleting()}
                      >
                        {isDeleting() ? 'Disconnecting...' : 'Disconnect'}
                      </button>
                    </Show>
                  </div>
                </div>
              )}
            </Show>
          </div>

          <div class="provider-connect-footer">
            <span>Provider not listed or having trouble?</span>
            <button type="button" onClick={useTerminal} disabled={isDeleting()}>
              Use terminal setup
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

function DisconnectListSkeleton() {
  return (
    <div class="provider-connect-skeleton" aria-hidden="true">
      <div class="provider-connect-skeleton-search" />
      <For each={[0, 1, 2, 3, 4]}>
        {(index) => (
          <div class="provider-connect-skeleton-row">
            <span style={{ width: `${44 + index * 6}%` }} />
            <span />
          </div>
        )}
      </For>
    </div>
  );
}

function formatProviderID(providerID: string) {
  return providerID
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(' ');
}

function formatConfigFilename(path: string) {
  return path.split(/[\\/]/).at(-1) || 'OpenCode config';
}
