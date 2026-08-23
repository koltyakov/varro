import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { McpStatus } from '../../shared/protocol';
import { postMessage } from '../lib/bridge';
import { client } from '../lib/client';
import { trapModalFocus } from '../lib/modal-focus';
import { getSelectedMcpsForSession, setMcpStatus, state } from '../lib/state';
import { observePopupViewport, placeDropdownAnchor } from '../lib/popup-position';
import { checkIcon, xmarkIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

export function McpPicker(props: {
  sessionId: string | null;
  onChange: (names: string[]) => void;
  onClose: () => void;
  popoverRef?: (el: HTMLDivElement) => void;
}) {
  let anchorRef: HTMLDivElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const [query, setQuery] = createSignal('');
  const [focusIndex, setFocusIndex] = createSignal(0);
  const [authServer, setAuthServer] = createSignal<{
    name: string;
    status: McpStatus;
  } | null>(null);
  const normalizedQuery = () => query().trim().toLocaleLowerCase();

  const allItems = createMemo(() =>
    Object.entries(state.mcpStatus)
      .map(([name, status]) => ({
        name,
        status: status.status,
        error: status.error,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  );

  const filteredItems = createMemo(() => {
    const search = normalizedQuery();
    if (!search) return allItems();
    return allItems().filter(
      (item) =>
        item.name.toLocaleLowerCase().includes(search) ||
        item.status.toLocaleLowerCase().replaceAll('_', ' ').includes(search)
    );
  });

  const selectedNames = createMemo(() => new Set(getSelectedMcpsForSession(props.sessionId) || []));

  createEffect(() => {
    setFocusIndex((current) => Math.max(0, Math.min(current, filteredItems().length - 1)));
  });

  function toggle(name: string) {
    const next = new Set(selectedNames());
    if (next.has(name)) next.delete(name);
    else next.add(name);
    props.onChange([...next]);
  }

  function activate(item: ReturnType<typeof allItems>[number]) {
    if (item.status === 'needs_auth' || item.status === 'needs_client_registration') {
      if (!selectedNames().has(item.name)) {
        props.onChange([...selectedNames(), item.name]);
      }
      setAuthServer({ name: item.name, status: { status: item.status, error: item.error } });
      return;
    }
    toggle(item.name);
  }

  function handleKeyDown(e: KeyboardEvent) {
    const items = filteredItems();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((cur) => {
        const next = cur + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) return items.length - 1;
        if (next >= items.length) return 0;
        return next;
      });
      queueMicrotask(() => {
        menuRef
          ?.querySelector('.dropdown-item.keyboard-focus')
          ?.scrollIntoView({ block: 'nearest' });
      });
      return;
    }

    if (e.key === ' ' && e.target === searchInputRef) return;

    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const item = items[focusIndex()];
      if (item) activate(item);
      return;
    }

    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  }

  onMount(() => {
    const reposition = () => {
      if (anchorRef && menuRef) {
        const editBanner = anchorRef
          .closest('.interactive-input-part')
          ?.querySelector<HTMLElement>('.composer-edit-banner');
        placeDropdownAnchor(anchorRef, menuRef, 10, 8, editBanner);
      }
    };

    if (allItems().length > 8) searchInputRef?.focus();
    else menuRef?.focus();

    if (!menuRef) return;
    onCleanup(observePopupViewport(menuRef, reposition));
  });

  return (
    <div
      ref={(el) => {
        anchorRef = el;
      }}
      class="dropdown-anchor absolute inset-x-0 z-50"
      onClick={props.onClose}
      style={{ bottom: '100%', 'padding-bottom': '10px' }}
    >
      <div
        ref={(el) => {
          menuRef = el;
          props.popoverRef?.(el);
        }}
        class="dropdown-menu w-full"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{ outline: 'none' }}
      >
        <div class="dropdown-header">MCPs</div>

        <Show when={allItems().length > 8}>
          <div class="dropdown-search">
            <input
              ref={(el) => {
                searchInputRef = el;
              }}
              type="text"
              class="dropdown-search-input"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search MCPs"
              aria-label="Search MCPs"
              spellcheck={false}
            />
          </div>
        </Show>

        <div class="model-picker-list overflow-y-auto py-1">
          <Show
            when={allItems().length > 0}
            fallback={
              <div class="px-3 py-4 text-center text-[11px] text-vscode-muted">No MCPs found</div>
            }
          >
            <Show
              when={filteredItems().length > 0}
              fallback={
                <div class="px-3 py-4 text-center text-[11px] text-vscode-muted">
                  No matching MCPs
                </div>
              }
            >
              <For each={filteredItems()}>
                {(item, index) => (
                  <button
                    class={`dropdown-item ${selectedNames().has(item.name) ? 'selected' : ''} ${focusIndex() === index() ? 'keyboard-focus' : ''}`}
                    aria-pressed={selectedNames().has(item.name)}
                    onClick={() => activate(item)}
                    onMouseEnter={() => setFocusIndex(index())}
                  >
                    <span class="dropdown-name-wrap">
                      <span class="dropdown-name">{item.name}</span>
                      <span class="dropdown-check">
                        <Show when={selectedNames().has(item.name)}>
                          <UiIcon
                            source={checkIcon}
                            class="h-3 w-3 text-vscode-accent"
                            width={12}
                            height={12}
                          />
                        </Show>
                      </span>
                    </span>
                    <span class="dropdown-meta">
                      <span class={`model-capability-tag mcp-status-tag status-${item.status}`}>
                        {item.status.replaceAll('_', ' ')}
                      </span>
                      <Show when={item.error}>
                        <span class="dropdown-hint">{item.error}</span>
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
      <Show when={authServer()}>
        {(server) => <McpAuthDialog server={server()} onClose={() => setAuthServer(null)} />}
      </Show>
    </div>
  );
}

function McpAuthDialog(props: {
  server: { name: string; status: McpStatus };
  onClose: () => void;
}) {
  const needsConfiguration = () => currentStatus().status === 'needs_client_registration';
  const [authorizationUrl, setAuthorizationUrl] = createSignal('');
  const [authorizationCode, setAuthorizationCode] = createSignal('');
  const [currentStatus, setCurrentStatus] = createSignal<McpStatus>(props.server.status);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
    if (!needsConfiguration()) void startAuth();
  });

  async function refreshStatus() {
    const statuses = await client.mcp.status();
    setMcpStatus(statuses);
    const status = statuses[props.server.name];
    if (status) setCurrentStatus(status);
    return status;
  }

  async function startAuth() {
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const authorization = await client.mcp.startAuth(props.server.name);
      const url = new URL(authorization.authorizationUrl);
      if (url.protocol !== 'https:') {
        throw new Error(
          'OpenCode returned an unsafe MCP authorization URL. Only HTTPS is allowed.'
        );
      }
      setAuthorizationUrl(url.href);
      postMessage({ type: 'vscode/open-external', payload: { url: url.href } });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function submitCode() {
    const code = authorizationCode().trim();
    if (!code) return;
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      setCurrentStatus(await client.mcp.completeAuth(props.server.name, code));
      await refreshStatus();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function removeAndRestart() {
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      await client.mcp.removeAuth(props.server.name);
      setAuthorizationCode('');
      setAuthorizationUrl('');
      await refreshStatus();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setIsSubmitting(false);
      return;
    }
    setIsSubmitting(false);
    await startAuth();
  }

  async function refreshConfigurationStatus() {
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const status = await refreshStatus();
      if (status?.status === 'needs_auth') {
        setIsSubmitting(false);
        await startAuth();
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Portal>
      <div class="provider-connect-overlay">
        <div
          ref={(element) => onCleanup(trapModalFocus(element))}
          class="provider-connect-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mcp-auth-title"
        >
          <div class="provider-connect-header">
            <div>
              <div id="mcp-auth-title" class="provider-connect-title">
                {needsConfiguration() ? 'Configure MCP OAuth' : 'Authorize MCP server'}
              </div>
              <div class="provider-connect-subtitle">{props.server.name}</div>
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
          <div class="provider-connect-body">
            <Show
              when={!needsConfiguration()}
              fallback={
                <div class="provider-connect-form">
                  <div class="provider-connect-intro">
                    Add a client ID for this server in your OpenCode MCP configuration, then refresh
                    its status. OpenCode cannot start OAuth until client registration is configured.
                  </div>
                  <Show when={props.server.status.error}>
                    <div class="provider-connect-instructions">{props.server.status.error}</div>
                  </Show>
                  <div class="provider-connect-actions">
                    <button
                      type="button"
                      class="provider-connect-primary"
                      disabled={isSubmitting()}
                      onClick={() => void refreshConfigurationStatus()}
                    >
                      {isSubmitting() ? 'Refreshing...' : 'Refresh status'}
                    </button>
                  </div>
                </div>
              }
            >
              <form
                class="provider-connect-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCode();
                }}
              >
                <div class="provider-connect-oauth-handoff">
                  <div>
                    <div class="provider-connect-oauth-title">Continue in your browser</div>
                    <div class="provider-connect-oauth-copy">
                      Authorize the server, then paste the returned authorization code below.
                    </div>
                  </div>
                </div>
                <Show when={authorizationUrl()}>
                  <button
                    type="button"
                    class="provider-connect-secondary"
                    onClick={() =>
                      postMessage({
                        type: 'vscode/open-external',
                        payload: { url: authorizationUrl() },
                      })
                    }
                  >
                    Reopen authorization page
                  </button>
                </Show>
                <label class="provider-connect-field">
                  Authorization code
                  <input
                    class="provider-connect-input"
                    value={authorizationCode()}
                    onInput={(event) => setAuthorizationCode(event.currentTarget.value)}
                    autocomplete="off"
                  />
                </label>
                <div class="provider-connect-intro" aria-live="polite">
                  Status: {currentStatus().status.replaceAll('_', ' ')}
                </div>
                <div class="provider-connect-actions">
                  <button
                    type="button"
                    class="provider-connect-danger"
                    disabled={isSubmitting()}
                    onClick={() => void removeAndRestart()}
                  >
                    Remove credentials and restart
                  </button>
                  <button
                    type="submit"
                    class="provider-connect-primary"
                    disabled={isSubmitting() || !authorizationCode().trim()}
                  >
                    {isSubmitting() ? 'Working...' : 'Complete authorization'}
                  </button>
                </div>
              </form>
            </Show>
            <Show when={errorMessage()}>
              <div class="provider-connect-error" role="alert">
                {errorMessage()}
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
