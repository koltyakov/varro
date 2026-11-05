import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { McpStatus } from '../../shared/protocol';
import { postMessage } from '../lib/bridge';
import { client } from '../lib/client';
import { trapModalFocus } from '../lib/modal-focus';
import {
  getAvailableMcpNames,
  getSelectedMcpsForSession,
  setShowMcpSettings,
  setMcpStatus,
  state,
} from '../lib/state';
import { observePopupViewport, placeDropdownAnchor } from '../lib/popup-position';
import { checkIcon, xmarkIcon } from '../lib/ui-icons';
import { PickerManageIcon } from './PickerManageIcon';
import { UiIcon } from './UiIcon';

function statusLabel(status: McpStatus['status']) {
  if (status === 'needs_auth') return 'Sign in required';
  if (status === 'needs_client_registration') return 'Setup required';
  return status.replaceAll('_', ' ');
}

export function McpPicker(props: {
  sessionId: string | null;
  onChange: (names: string[]) => void;
  onClose: () => void;
  popoverRef?: (el: HTMLDivElement) => void;
  initialQuery?: string;
  authDialogRef?: (el: HTMLDivElement | undefined) => void;
}) {
  let anchorRef: HTMLDivElement | undefined;
  let menuRef: HTMLDivElement | undefined;
  let searchInputRef: HTMLInputElement | undefined;

  const [query, setQuery] = createSignal(props.initialQuery ?? '');
  const [focusIndex, setFocusIndex] = createSignal(0);
  const [authServer, setAuthServer] = createSignal<{
    name: string;
    status: McpStatus;
    switchingAccount?: boolean;
  } | null>(null);
  const [accountAction, setAccountAction] = createSignal<'sign-out' | 'switch' | null>(null);
  const [accountError, setAccountError] = createSignal('');
  const [accountMessage, setAccountMessage] = createSignal('');
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const normalizedQuery = () => query().trim().toLocaleLowerCase();

  const allItems = createMemo(() =>
    getAvailableMcpNames()
      .map((name) => ({
        name,
        status: state.mcpStatus[name]?.status ?? 'disabled',
        error: state.mcpStatus[name]?.error,
        oauth: state.mcpDefaults?.oauthServers?.includes(name) === true,
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name))
  );

  const filteredItems = createMemo(() => {
    const search = normalizedQuery();
    if (!search) return allItems();
    return allItems().filter(
      (item) =>
        item.name.toLocaleLowerCase().includes(search) ||
        item.status.toLocaleLowerCase().replaceAll('_', ' ').includes(search) ||
        statusLabel(item.status).toLocaleLowerCase().includes(search)
    );
  });

  const selectedNames = createMemo(() => new Set(getSelectedMcpsForSession(props.sessionId) || []));
  const showSearch = () => allItems().length > 8 || !!props.initialQuery;

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
    toggle(item.name);
  }

  function authenticate(item: ReturnType<typeof allItems>[number]) {
    if (accountAction()) return;
    if (!selectedNames().has(item.name)) {
      props.onChange([...selectedNames(), item.name]);
    }
    setAuthServer({ name: item.name, status: { status: item.status, error: item.error } });
  }

  async function changeAccount(name: string, action: 'sign-out' | 'switch') {
    if (accountAction()) return;
    setAccountAction(action);
    setAccountError('');
    setAccountMessage('');
    let credentialsRemoved = false;
    try {
      await client.mcp.disconnect(name);
      if (disposed) return;
      await client.mcp.removeAuth(name);
      credentialsRemoved = true;
      if (disposed) return;
      const statuses = await client.mcp.status();
      if (disposed) return;
      setMcpStatus(statuses);
      if (statuses[name]?.status === 'connected')
        throw new Error('The MCP server is still connected. Refresh its status and try again.');
      if (action === 'switch') {
        setAuthServer({
          name,
          status: statuses[name] ?? { status: 'needs_auth' },
          switchingAccount: true,
        });
      } else {
        setAccountMessage(`Signed out of ${name}. Stored MCP credentials were removed.`);
        menuRef?.focus();
      }
    } catch (error) {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      setAccountError(
        credentialsRemoved
          ? `Credentials for ${name} were removed, but the account change could not be completed: ${message}`
          : `Could not ${action === 'switch' ? 'switch accounts for' : 'sign out of'} ${name}: ${message}`
      );
      if (!credentialsRemoved) {
        try {
          const statuses = await client.mcp.status();
          if (!disposed) setMcpStatus(statuses);
        } catch (refreshError) {
          if (!disposed)
            setAccountError(
              (previous) =>
                `${previous}. Status refresh failed: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`
            );
        }
      }
    } finally {
      if (!disposed) {
        setAccountAction(null);
        if (!authServer() && !menuRef?.contains(document.activeElement)) menuRef?.focus();
      }
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
      return;
    }
    if (e.target instanceof Element && e.target.closest('.dropdown-footer, .mcp-picker-controls'))
      return;
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
      if (accountAction()) return;
      const item = items[focusIndex()];
      if (item) activate(item);
      return;
    }
  }

  onMount(() => {
    // Best effort: the settings screen falls back to its own load if this fails.
    void import('./McpSettingsPanel').catch(() => undefined);

    const reposition = () => {
      if (anchorRef && menuRef) {
        const editBanner = anchorRef
          .closest('.interactive-input-part')
          ?.querySelector<HTMLElement>('.composer-edit-banner');
        placeDropdownAnchor(anchorRef, menuRef, 10, 8, editBanner);
      }
    };

    if (showSearch()) searchInputRef?.focus();
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

        <Show when={showSearch()}>
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
                  <div class="mcp-picker-server">
                    <div
                      class={`mcp-picker-server-line ${focusIndex() === index() ? 'keyboard-focus' : ''}`}
                      onMouseEnter={() => setFocusIndex(index())}
                      onClick={() => {
                        if (!accountAction()) activate(item);
                      }}
                    >
                      <button
                        class={`dropdown-item mcp-picker-item ${selectedNames().has(item.name) ? 'selected' : ''} ${focusIndex() === index() ? 'keyboard-focus' : ''}`}
                        aria-pressed={selectedNames().has(item.name)}
                        aria-label={
                          item.status === 'needs_auth'
                            ? item.name
                            : [item.name, statusLabel(item.status), item.error]
                                .filter(Boolean)
                                .join(' ')
                        }
                        disabled={accountAction() !== null}
                        onClick={(event) => {
                          event.stopPropagation();
                          activate(item);
                        }}
                      >
                        <span class="mcp-picker-row">
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
                        </span>
                        <Show when={item.error && item.status !== 'needs_auth'}>
                          <span class="dropdown-hint mcp-picker-error">{item.error}</span>
                        </Show>
                      </button>
                      <div class="dropdown-meta mcp-picker-controls">
                        <Show
                          when={
                            item.status === 'needs_auth' ||
                            item.status === 'needs_client_registration'
                          }
                        >
                          <button
                            type="button"
                            class="mcp-picker-action mcp-picker-account-action"
                            aria-label={`${item.status === 'needs_auth' ? 'Sign in to' : 'Configure OAuth for'} ${item.name}`}
                            disabled={accountAction() !== null}
                            onClick={(event) => {
                              event.stopPropagation();
                              authenticate(item);
                            }}
                          >
                            {item.status === 'needs_auth' ? 'Sign in' : 'Configure OAuth'}
                          </button>
                        </Show>
                        <Show when={item.status === 'connected' && item.oauth}>
                          <div class="mcp-picker-account-actions">
                            <button
                              type="button"
                              class="mcp-picker-account-action"
                              aria-label={`Switch account for ${item.name}`}
                              title="Clear the MCP login for all sessions using this connection and sign in again. Browser login is unchanged."
                              disabled={accountAction() !== null}
                              onClick={(event) => {
                                event.stopPropagation();
                                void changeAccount(item.name, 'switch');
                              }}
                            >
                              Switch account
                            </button>
                            <button
                              type="button"
                              class="mcp-picker-account-action"
                              aria-label={`Sign out of ${item.name}`}
                              title="Remove stored MCP credentials for all sessions using this connection. Browser login is unchanged."
                              disabled={accountAction() !== null}
                              onClick={(event) => {
                                event.stopPropagation();
                                void changeAccount(item.name, 'sign-out');
                              }}
                            >
                              Sign out
                            </button>
                          </div>
                        </Show>
                        <Show when={item.status !== 'needs_auth'}>
                          <span class={`model-capability-tag mcp-status-tag status-${item.status}`}>
                            {statusLabel(item.status)}
                          </span>
                        </Show>
                      </div>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
        <Show when={accountAction()}>
          <div class="mcp-picker-feedback" role="status">
            {accountAction() === 'switch' ? 'Switching account...' : 'Signing out...'}
          </div>
        </Show>
        <Show when={accountMessage()}>
          <div class="mcp-picker-feedback" role="status">
            {accountMessage()}
          </div>
        </Show>
        <Show when={accountError()}>
          <div class="mcp-picker-feedback mcp-picker-feedback-error" role="alert">
            {accountError()}
          </div>
        </Show>
        <div class="dropdown-footer">
          <button
            type="button"
            class="dropdown-item"
            onClick={() => {
              setShowMcpSettings(true);
              props.onClose();
            }}
          >
            <span class="dropdown-footer-icon">
              <PickerManageIcon />
            </span>
            <span class="dropdown-footer-label text-vscode-muted">Manage MCPs</span>
          </button>
        </div>
      </div>
      <Show when={authServer()}>
        {(server) => (
          <McpAuthDialog
            server={server()}
            onClose={() => {
              setAuthServer(null);
              menuRef?.focus();
            }}
            dialogRef={props.authDialogRef}
          />
        )}
      </Show>
    </div>
  );
}

function McpAuthDialog(props: {
  server: { name: string; status: McpStatus; switchingAccount?: boolean };
  onClose: () => void;
  dialogRef?: (el: HTMLDivElement | undefined) => void;
}) {
  const needsConfiguration = () => currentStatus().status === 'needs_client_registration';
  const [authorizationUrl, setAuthorizationUrl] = createSignal('');
  const [authorizationCode, setAuthorizationCode] = createSignal('');
  const [currentStatus, setCurrentStatus] = createSignal<McpStatus>(props.server.status);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');
  const [statusError, setStatusError] = createSignal('');
  const isConnected = () => currentStatus().status === 'connected';
  const waitingForAuthorization = createMemo(
    () => !!authorizationUrl() && !isSubmitting() && !needsConfiguration() && !isConnected()
  );
  let disposed = false;

  createEffect(() => {
    const status = state.mcpStatus[props.server.name];
    if (status) setCurrentStatus({ status: status.status, error: status.error });
  });

  createEffect(() => {
    if (!waitingForAuthorization()) return;
    const deadline = Date.now() + 5 * 60_000;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const checkStatus = async () => {
      try {
        await refreshStatus(() => !cancelled && !disposed);
        if (cancelled) return;
        setStatusError('');
      } catch (error) {
        if (cancelled) return;
        setStatusError(error instanceof Error ? error.message : String(error));
      }
      if (cancelled) return;
      if (Date.now() >= deadline) {
        setStatusError(
          'Still waiting for sign-in. Use Refresh status after completing it in your browser.'
        );
        return;
      }
      timer = setTimeout(() => void checkStatus(), 1_000);
    };
    timer = setTimeout(() => void checkStatus(), 1_000);
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  });

  onCleanup(() => {
    disposed = true;
    props.dialogRef?.(undefined);
  });

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      props.onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
    if (!needsConfiguration() && !isConnected()) void startAuth();
  });

  async function refreshStatus(isCurrent: () => boolean = () => !disposed) {
    const statuses = await client.mcp.status();
    if (!isCurrent()) return;
    setMcpStatus(statuses);
    const status = statuses[props.server.name];
    if (status) setCurrentStatus(status);
    return status;
  }

  async function startAuth() {
    setIsSubmitting(true);
    setErrorMessage('');
    setStatusError('');
    try {
      const authorization = await client.mcp.startAuth(props.server.name);
      if (disposed) return;
      const url = new URL(authorization.authorizationUrl);
      if (url.protocol !== 'https:') {
        throw new Error(
          'OpenCode returned an unsafe MCP authorization URL. Only HTTPS is allowed.'
        );
      }
      setAuthorizationUrl(url.href);
      postMessage({ type: 'vscode/open-external', payload: { url: url.href } });
    } catch (error) {
      if (!disposed) setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (!disposed) setIsSubmitting(false);
    }
  }

  async function submitCode() {
    const code = authorizationCode().trim();
    if (!code) return;
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      const status = await client.mcp.completeAuth(props.server.name, code);
      if (disposed) return;
      setCurrentStatus(status);
      await refreshStatus();
    } catch (error) {
      if (!disposed) setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (!disposed) setIsSubmitting(false);
    }
  }

  async function checkAuthorizationStatus() {
    setIsSubmitting(true);
    setErrorMessage('');
    setStatusError('');
    try {
      await refreshStatus();
    } catch (error) {
      if (!disposed) setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (!disposed) setIsSubmitting(false);
    }
  }

  async function removeAndRestart() {
    setIsSubmitting(true);
    setErrorMessage('');
    try {
      await client.mcp.removeAuth(props.server.name);
      if (disposed) return;
      setAuthorizationCode('');
      setAuthorizationUrl('');
      await refreshStatus();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setIsSubmitting(false);
      return;
    }
    if (disposed) return;
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
      <div
        class="provider-connect-overlay"
        ref={(element) => props.dialogRef?.(element)}
        onClick={(event) => event.stopPropagation()}
      >
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
              <Show
                when={!isConnected()}
                fallback={
                  <div class="provider-connect-form">
                    <div class="provider-connect-oauth-title">Authorization successful</div>
                    <div class="provider-connect-intro" aria-live="polite">
                      {props.server.name} is connected.
                    </div>
                    <div class="provider-connect-actions">
                      <button
                        type="button"
                        class="provider-connect-primary"
                        onClick={props.onClose}
                      >
                        Done
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
                        Complete sign-in in your browser. This dialog updates automatically when the
                        server connects.
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
                  <Show when={props.server.switchingAccount}>
                    <div class="provider-connect-intro">
                      Choose the other account or customer tenant in your browser. If the previous
                      account is reused, switch accounts or sign out on the provider's website
                      first. Removing MCP credentials does not sign you out of that website. This
                      changes the MCP login for all sessions using this connection.
                    </div>
                  </Show>
                  <details>
                    <summary>Use an authorization code instead</summary>
                    <label class="provider-connect-field">
                      Authorization code
                      <input
                        class="provider-connect-input"
                        value={authorizationCode()}
                        onInput={(event) => setAuthorizationCode(event.currentTarget.value)}
                        autocomplete="off"
                      />
                    </label>
                    <button
                      type="submit"
                      class="provider-connect-primary"
                      disabled={isSubmitting() || !authorizationCode().trim()}
                    >
                      {isSubmitting() ? 'Working...' : 'Complete authorization'}
                    </button>
                  </details>
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
                      type="button"
                      class="provider-connect-primary"
                      disabled={isSubmitting()}
                      onClick={() => void checkAuthorizationStatus()}
                    >
                      {isSubmitting() ? 'Refreshing...' : 'Refresh status'}
                    </button>
                  </div>
                </form>
              </Show>
            </Show>
            <Show when={!isConnected() && (errorMessage() || statusError())}>
              <div class="provider-connect-error" role="alert">
                {errorMessage() || statusError()}
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
