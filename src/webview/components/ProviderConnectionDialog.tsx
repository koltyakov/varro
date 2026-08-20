import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
} from 'solid-js';
import { Portal } from 'solid-js/web';
import type {
  ProviderAuthMethod,
  ProviderAuthPromptSelect,
  ProviderAuthPromptText,
} from '../../shared/opencode-types';
import type { Provider } from '../types';
import { postMessage } from '../lib/bridge';
import { client } from '../lib/client';
import { trapModalFocus } from '../lib/modal-focus';
import { resolveProviderAuthFailure } from '../lib/provider-connection-state';
import { openProviderSetup } from '../lib/provider-setup';
import { state } from '../lib/state';
import { CopyIconButton } from './CopyIconButton';

export function ProviderConnectionDialog(props: {
  catalogProviders: Provider[];
  providerLoadError: string;
  isLoadingProviders: boolean;
  initialProviderID?: string | null;
  lockProvider?: boolean;
  reauthentication?: boolean;
  onClose: () => void;
}) {
  const [providerID, setProviderID] = createSignal<string | null>(
    props.lockProvider ? props.initialProviderID?.trim() || null : null
  );
  const [providerQuery, setProviderQuery] = createSignal('');
  const [activeProviderIndex, setActiveProviderIndex] = createSignal(0);
  const [methodIndex, setMethodIndex] = createSignal<number | null>(null);
  const [inputs, setInputs] = createSignal<Record<string, string>>({});
  const [apiKey, setApiKey] = createSignal('');
  const [authorizationCode, setAuthorizationCode] = createSignal('');
  const [authorization, setAuthorization] = createSignal<{
    url: string;
    method: 'auto' | 'code';
    instructions: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');
  let authController: AbortController | undefined;
  let initialProviderApplied = false;

  const providers = createMemo(() => {
    if (props.isLoadingProviders) return [];
    const byID = new Map(
      props.catalogProviders.map((provider) => [
        provider.id,
        {
          id: provider.id,
          name: provider.name,
          methods: state.providerAuthMethods[provider.id] ?? [GENERIC_API_METHOD],
        },
      ])
    );
    for (const [id, methods] of Object.entries(state.providerAuthMethods)) {
      if (!byID.has(id)) byID.set(id, { id, name: providerName(id), methods });
    }
    return [...byID.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  });
  const filteredProviders = createMemo(() => {
    const query = providerQuery().trim().toLocaleLowerCase();
    if (!query) return providers();
    return providers().filter((provider) =>
      [provider.name, provider.id].some((value) => value.toLocaleLowerCase().includes(query))
    );
  });
  const selectedProvider = createMemo(() =>
    providers().find((provider) => provider.id === providerID())
  );
  const selectedMethod = createMemo(() => {
    const index = methodIndex();
    return index === null ? undefined : selectedProvider()?.methods[index];
  });
  const visiblePrompts = createMemo(() =>
    (selectedMethod()?.prompts ?? []).filter((prompt) => promptIsVisible(prompt, inputs()))
  );

  function close() {
    authController?.abort(new Error('Provider authorization cancelled'));
    props.onClose();
  }

  onMount(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => document.removeEventListener('keydown', onKeyDown));
  });

  function chooseProvider(id: string) {
    setProviderID(id);
    setProviderQuery('');
    setActiveProviderIndex(0);
    setMethodIndex(null);
    setInputs({});
    setApiKey('');
    setAuthorization(null);
    setAuthorizationCode('');
    setErrorMessage('');
  }

  createEffect(() => {
    if (initialProviderApplied || props.isLoadingProviders) return;
    initialProviderApplied = true;
    const id = props.initialProviderID?.trim();
    if (id && providers().some((provider) => provider.id === id)) chooseProvider(id);
  });

  function handleProviderSearchKeyDown(event: KeyboardEvent) {
    const options = filteredProviders();
    if (options.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveProviderIndex((index) => Math.min(index + 1, options.length - 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveProviderIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter' && options.length > 0) {
      event.preventDefault();
      chooseProvider(options[activeProviderIndex()]?.id ?? options[0]!.id);
    }
  }

  function chooseMethod(index: number) {
    authController?.abort(new Error('Provider authorization cancelled'));
    setMethodIndex(index);
    setInputs({});
    setApiKey('');
    setAuthorization(null);
    setAuthorizationCode('');
    setErrorMessage('');
  }

  function returnToMethods() {
    authController?.abort(new Error('Provider authorization cancelled'));
    setIsSubmitting(false);
    setAuthorization(null);
    setAuthorizationCode('');
    setInputs({});
    setApiKey('');
    setErrorMessage('');
    setMethodIndex(null);
  }

  function updateInput(key: string, value: string) {
    setInputs((current) => ({ ...current, [key]: value }));
  }

  function requiredInputsArePresent() {
    return visiblePrompts().every((prompt) => Boolean(inputs()[prompt.key]?.trim()));
  }

  async function connect() {
    const id = providerID();
    const index = methodIndex();
    const method = selectedMethod();
    if (!id || index === null || !method || !requiredInputsArePresent()) return;

    setIsSubmitting(true);
    setErrorMessage('');
    const controller = new AbortController();
    authController = controller;
    try {
      if (method.type === 'api') {
        if (!apiKey().trim()) return;
        await client.config.connectApiProvider(
          {
            providerID: id,
            key: apiKey().trim(),
            metadata: visiblePromptInputs(visiblePrompts(), inputs()),
          },
          { signal: controller.signal }
        );
        finish();
        return;
      }

      const nextAuthorization = await client.config.authorizeProvider(
        {
          providerID: id,
          method: index,
          inputs: visiblePromptInputs(visiblePrompts(), inputs()),
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setAuthorization(nextAuthorization);
      postMessage({ type: 'vscode/open-external', payload: { url: nextAuthorization.url } });
      if (nextAuthorization.method === 'auto') {
        await client.config.completeProviderAuth(
          { providerID: id, method: index },
          { signal: controller.signal }
        );
        finish();
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (authController === controller) authController = undefined;
      setIsSubmitting(false);
    }
  }

  async function submitCode() {
    const id = providerID();
    const index = methodIndex();
    const code = authorizationCode().trim();
    if (!id || index === null || !code) return;
    setIsSubmitting(true);
    setErrorMessage('');
    const controller = new AbortController();
    authController = controller;
    try {
      await client.config.completeProviderAuth(
        { providerID: id, method: index, code },
        { signal: controller.signal }
      );
      finish();
    } catch (error) {
      if (!controller.signal.aborted) {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (authController === controller) authController = undefined;
      setIsSubmitting(false);
    }
  }

  function finish() {
    const id = providerID();
    if (id) resolveProviderAuthFailure(id);
    setApiKey('');
    setAuthorizationCode('');
    setInputs({});
    postMessage(
      props.reauthentication ? { type: 'providers/reauthenticated' } : { type: 'providers/refresh' }
    );
    props.onClose();
  }

  function useTerminal() {
    authController?.abort(new Error('Provider authorization cancelled'));
    openProviderSetup();
    props.onClose();
  }

  const canConnect = createMemo(
    () =>
      requiredInputsArePresent() &&
      (selectedMethod()?.type !== 'api' || Boolean(apiKey().trim())) &&
      !isSubmitting()
  );

  return (
    <Portal>
      <div class="provider-connect-overlay">
        <div
          ref={(element) => onCleanup(trapModalFocus(element))}
          class="provider-connect-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="provider-connect-title"
        >
          <div class="provider-connect-header">
            <div>
              <div id="provider-connect-title" class="provider-connect-title">
                {props.reauthentication ? 'Re-authenticate provider' : 'Connect provider'}
              </div>
              <Show when={selectedProvider()}>
                {(provider) => <div class="provider-connect-subtitle">{provider().name}</div>}
              </Show>
            </div>
            <button type="button" class="provider-connect-close" onClick={close} aria-label="Close">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                <path d="M6.758 17.243L12 12m5.243-5.243L12 12m0 0L6.758 6.757M12 12l5.243 5.243" />
              </svg>
            </button>
          </div>

          <div class="provider-connect-body" classList={{ 'is-provider-list': !providerID() }}>
            <Show
              when={providerID()}
              fallback={
                <div class="provider-connect-provider-step">
                  <div class="provider-connect-intro">
                    Choose a provider to connect to OpenCode.
                  </div>
                  <Show when={!props.isLoadingProviders} fallback={<ProviderListSkeleton />}>
                    <div class="provider-connect-picker">
                      <input
                        class="provider-connect-search"
                        type="text"
                        role="combobox"
                        aria-label="Search providers"
                        aria-autocomplete="list"
                        aria-expanded="true"
                        aria-controls="provider-connect-options"
                        aria-activedescendant={
                          filteredProviders()[activeProviderIndex()]
                            ? `provider-connect-option-${activeProviderIndex()}`
                            : undefined
                        }
                        value={providerQuery()}
                        placeholder="Search providers"
                        onInput={(event) => {
                          setProviderQuery(event.currentTarget.value);
                          setActiveProviderIndex(0);
                        }}
                        onKeyDown={handleProviderSearchKeyDown}
                        autocomplete="off"
                      />
                      <ProviderOptions
                        providers={filteredProviders()}
                        activeIndex={activeProviderIndex()}
                        selectedProviderID={providerID()}
                        onActivate={setActiveProviderIndex}
                        onSelect={chooseProvider}
                      />
                    </div>
                  </Show>
                  <Show when={props.providerLoadError}>
                    <div class="provider-connect-error" role="alert">
                      Could not load the full provider catalog. Showing available authentication
                      plugins only. {props.providerLoadError}
                    </div>
                  </Show>
                </div>
              }
            >
              <Show when={!props.isLoadingProviders} fallback={<ProviderListSkeleton />}>
                <Show
                  when={selectedMethod()}
                  fallback={
                    <div class="provider-connect-methods">
                      <Show when={!props.lockProvider}>
                        <button
                          type="button"
                          class="provider-connect-back"
                          onClick={() => setProviderID(null)}
                        >
                          <BackArrowIcon />
                          Back to providers
                        </button>
                      </Show>
                      <div class="provider-connect-intro">Choose how you want to authenticate.</div>
                      <For each={selectedProvider()?.methods ?? []}>
                        {(method, index) => (
                          <button
                            type="button"
                            class="provider-connect-method"
                            onClick={() => chooseMethod(index())}
                          >
                            <span>{method.label}</span>
                            <span class="provider-connect-method-type">
                              {method.type === 'api' ? 'API key' : 'OAuth'}
                            </span>
                          </button>
                        )}
                      </For>
                      <Show when={(selectedProvider()?.methods.length ?? 0) === 0}>
                        <div class="provider-connect-empty">
                          This provider has no embedded authentication methods. Use terminal setup
                          instead.
                        </div>
                      </Show>
                    </div>
                  }
                >
                  {(method) => (
                    <form
                      class="provider-connect-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void (authorization()?.method === 'code' ? submitCode() : connect());
                      }}
                    >
                      <button type="button" class="provider-connect-back" onClick={returnToMethods}>
                        <BackArrowIcon />
                        Back to methods
                      </button>
                      <Show when={!authorization()}>
                        <Show when={method().type === 'oauth' && visiblePrompts().length === 0}>
                          <div class="provider-connect-oauth-handoff">
                            <div class="provider-connect-oauth-icon" aria-hidden="true">
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.5"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                              >
                                <path d="M8.5 12a3.5 3.5 0 117 0v2.5h-7V12z" />
                                <path d="M7 14.5h10v6H7z" />
                                <path d="M12 17v1" />
                                <path d="M12 3v2M4.9 5.9l1.4 1.4M19.1 5.9l-1.4 1.4" />
                              </svg>
                            </div>
                            <div>
                              <div class="provider-connect-oauth-title">
                                Continue with {selectedProvider()?.name}
                              </div>
                              <div class="provider-connect-oauth-copy">
                                Your browser will open to complete authorization. OpenCode securely
                                stores the resulting credential.
                              </div>
                            </div>
                          </div>
                        </Show>
                        <For each={visiblePrompts()}>
                          {(prompt) => (
                            <div class="provider-connect-field">
                              <span>{prompt.message}</span>
                              <Show
                                when={prompt.type === 'select'}
                                fallback={
                                  <input
                                    class="provider-connect-input"
                                    type="text"
                                    value={inputs()[prompt.key] ?? ''}
                                    // SAFETY: The surrounding shape or discriminator check establishes the ProviderAuthPromptText contract used below.
                                    placeholder={(prompt as ProviderAuthPromptText).placeholder}
                                    onInput={(event) =>
                                      updateInput(prompt.key, event.currentTarget.value)
                                    }
                                    disabled={isSubmitting()}
                                    required
                                  />
                                }
                              >
                                <PromptSelect
                                  // SAFETY: The surrounding shape or discriminator check establishes the ProviderAuthPromptSelect contract used below.
                                  prompt={prompt as ProviderAuthPromptSelect}
                                  value={inputs()[prompt.key] ?? ''}
                                  onChange={(value) => updateInput(prompt.key, value)}
                                  disabled={isSubmitting()}
                                />
                              </Show>
                            </div>
                          )}
                        </For>
                        <Show when={method().type === 'api'}>
                          <label class="provider-connect-field">
                            <span>API key</span>
                            <input
                              class="provider-connect-input"
                              type="password"
                              value={apiKey()}
                              onInput={(event) => setApiKey(event.currentTarget.value)}
                              autocomplete="off"
                              disabled={isSubmitting()}
                              required
                            />
                          </label>
                        </Show>
                      </Show>

                      <Show when={authorization()}>
                        {(auth) => (
                          <div class="provider-connect-authorization">
                            <AuthorizationInstructions text={auth().instructions} />
                            <button
                              type="button"
                              class="provider-connect-secondary"
                              onClick={() =>
                                postMessage({
                                  type: 'vscode/open-external',
                                  payload: { url: auth().url },
                                })
                              }
                            >
                              Open authorization page
                            </button>
                            <Show when={auth().method === 'code'}>
                              <label class="provider-connect-field">
                                <span>Authorization code</span>
                                <input
                                  class="provider-connect-input"
                                  type="text"
                                  value={authorizationCode()}
                                  onInput={(event) =>
                                    setAuthorizationCode(event.currentTarget.value)
                                  }
                                  disabled={isSubmitting()}
                                  required
                                />
                              </label>
                            </Show>
                          </div>
                        )}
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
                          onClick={returnToMethods}
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          class="provider-connect-primary"
                          disabled={
                            !canConnect() ||
                            Boolean(authorization() && authorization()?.method !== 'code')
                          }
                        >
                          {isSubmitting()
                            ? authorization()?.method === 'auto'
                              ? 'Waiting for authorization...'
                              : 'Connecting...'
                            : authorization()?.method === 'code'
                              ? 'Complete connection'
                              : method().type === 'oauth'
                                ? 'Continue in browser'
                                : 'Connect'}
                        </button>
                      </div>
                    </form>
                  )}
                </Show>
              </Show>
            </Show>
          </div>

          <div class="provider-connect-footer">
            <span>Provider not listed or having trouble?</span>
            <button type="button" onClick={useTerminal} disabled={isSubmitting()}>
              Use terminal setup
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

const GENERIC_API_METHOD: ProviderAuthMethod = { type: 'api', label: 'API key' };

function BackArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
      <path d="M21 12H3m0 0l8.5-8.5M3 12l8.5 8.5" />
    </svg>
  );
}

function ProviderListSkeleton() {
  return (
    <div class="provider-connect-skeleton" aria-hidden="true">
      <div class="provider-connect-skeleton-search" />
      <For each={[0, 1, 2, 3, 4]}>
        {(index) => (
          <div class="provider-connect-skeleton-row">
            <span style={{ width: `${42 + ((index * 13) % 31)}%` }} />
            <span />
          </div>
        )}
      </For>
    </div>
  );
}

function ProviderOptions(props: {
  providers: Array<{ id: string; name: string; methods: ProviderAuthMethod[] }>;
  activeIndex: number;
  selectedProviderID: string | null;
  onActivate: (index: number) => void;
  onSelect: (providerID: string) => void;
}) {
  let optionsRef: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [clientHeight, setClientHeight] = createSignal(0);
  const [scrollHeight, setScrollHeight] = createSignal(0);

  const updateScrollMetrics = () => {
    if (!optionsRef) return;
    setScrollTop(optionsRef.scrollTop);
    setClientHeight(optionsRef.clientHeight);
    setScrollHeight(optionsRef.scrollHeight);
  };

  onMount(() => {
    updateScrollMetrics();
    if (!optionsRef) return;
    const observer = new ResizeObserver(updateScrollMetrics);
    observer.observe(optionsRef);
    onCleanup(() => observer.disconnect());
  });

  createEffect(
    on(
      () => props.providers.length,
      () => queueMicrotask(updateScrollMetrics)
    )
  );

  const thumbHeight = createMemo(() => {
    if (scrollHeight() <= clientHeight()) return 0;
    return Math.max(24, (clientHeight() * clientHeight()) / scrollHeight());
  });
  const thumbTop = createMemo(() => {
    const availableTrack = clientHeight() - thumbHeight();
    const availableScroll = scrollHeight() - clientHeight();
    return availableScroll > 0 ? (scrollTop() / availableScroll) * availableTrack : 0;
  });

  return (
    <div class="provider-connect-options-shell">
      <div
        ref={(element) => (optionsRef = element)}
        id="provider-connect-options"
        class="provider-connect-options"
        role="listbox"
        onScroll={updateScrollMetrics}
      >
        <For each={props.providers}>
          {(provider, index) => (
            <button
              id={`provider-connect-option-${index()}`}
              type="button"
              class={`provider-connect-option ${index() === props.activeIndex ? 'is-active' : ''}`}
              role="option"
              aria-selected={provider.id === props.selectedProviderID}
              onPointerMove={() => props.onActivate(index())}
              onClick={() => props.onSelect(provider.id)}
            >
              <span class="provider-connect-option-name">{provider.name}</span>
              <Show when={provider.name.toLocaleLowerCase() !== provider.id.toLocaleLowerCase()}>
                <span class="provider-connect-option-id">{provider.id}</span>
              </Show>
              <span class="provider-connect-method-count">
                {provider.methods.length} {provider.methods.length === 1 ? 'method' : 'methods'}
              </span>
            </button>
          )}
        </For>
        <Show when={props.providers.length === 0}>
          <div class="provider-connect-empty">No matching providers.</div>
        </Show>
      </div>
      <Show when={thumbHeight() > 0}>
        <div class="provider-connect-scrollbar" aria-hidden="true">
          <div
            class="provider-connect-scrollbar-thumb"
            style={{ height: `${thumbHeight()}px`, transform: `translateY(${thumbTop()}px)` }}
          />
        </div>
      </Show>
    </div>
  );
}

function AuthorizationInstructions(props: { text: string }) {
  const code = () => props.text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/)?.[0];
  return (
    <div class="provider-connect-instructions">
      <span>{props.text}</span>
      <Show when={code()}>
        {(value) => <CopyIconButton text={value()} label="authorization code" />}
      </Show>
    </div>
  );
}

function PromptSelect(props: {
  prompt: ProviderAuthPromptSelect;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal(0);
  let rootRef: HTMLDivElement | undefined;
  let bodyRef: HTMLElement | null = null;
  const listboxID = `provider-prompt-${props.prompt.key}-options`;
  const selectedIndex = () =>
    Math.max(
      0,
      props.prompt.options.findIndex((option) => option.value === props.value)
    );
  const selectedOption = () => props.prompt.options.find((option) => option.value === props.value);

  onMount(() => {
    bodyRef = rootRef?.closest<HTMLElement>('.provider-connect-body') ?? null;
    const onPointerDown = (event: PointerEvent) => {
      // SAFETY: The surrounding shape or discriminator check establishes the Node contract used below.
      if (!rootRef?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    onCleanup(() => {
      document.removeEventListener('pointerdown', onPointerDown);
      bodyRef?.classList.remove('has-open-select');
    });
  });

  createEffect(() => {
    bodyRef?.classList.toggle('has-open-select', open());
  });

  function openMenu() {
    if (props.disabled) return;
    setActiveIndex(selectedIndex());
    setOpen(true);
  }

  function choose(index: number) {
    const option = props.prompt.options[index];
    if (!option) return;
    props.onChange(option.value);
    setActiveIndex(index);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (props.disabled) return;
    if (event.key === 'Escape' && open()) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open()) {
        openMenu();
        return;
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex(
        (index) => (index + direction + props.prompt.options.length) % props.prompt.options.length
      );
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ') && !open()) {
      event.preventDefault();
      openMenu();
      return;
    }
    if (event.key === 'Enter' && open()) {
      event.preventDefault();
      choose(activeIndex());
    }
  }

  return (
    <div ref={(element) => (rootRef = element)} class="provider-connect-select">
      <button
        type="button"
        class={`provider-connect-select-trigger ${open() ? 'is-open' : ''}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={listboxID}
        aria-activedescendant={open() ? `${listboxID}-${activeIndex()}` : undefined}
        disabled={props.disabled}
        onClick={() => (open() ? setOpen(false) : openMenu())}
        onKeyDown={handleKeyDown}
      >
        <span class={selectedOption() ? '' : 'provider-connect-select-placeholder'}>
          {selectedOption()?.label ?? 'Select an option'}
        </span>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <Show when={open()}>
        <div id={listboxID} class="provider-connect-select-options" role="listbox">
          <For each={props.prompt.options}>
            {(option, index) => (
              <button
                id={`${listboxID}-${index()}`}
                type="button"
                class={`provider-connect-select-option ${index() === activeIndex() ? 'is-active' : ''}`}
                role="option"
                aria-selected={option.value === props.value}
                onPointerMove={() => setActiveIndex(index())}
                onClick={() => choose(index())}
              >
                <span>{option.label}</span>
                <Show when={option.hint}>
                  <span class="provider-connect-select-hint">{option.hint}</span>
                </Show>
                <Show when={option.value === props.value}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function promptIsVisible(
  prompt: NonNullable<ProviderAuthMethod['prompts']>[number],
  inputs: Record<string, string>
) {
  if (!prompt.when) return true;
  const matches = inputs[prompt.when.key] === prompt.when.value;
  return prompt.when.op === 'eq' ? matches : !matches;
}

function visiblePromptInputs(
  prompts: NonNullable<ProviderAuthMethod['prompts']>,
  inputs: Record<string, string>
) {
  return Object.fromEntries(
    prompts
      .map((prompt) => [prompt.key, inputs[prompt.key]?.trim() ?? ''])
      .filter(([, value]) => value)
  );
}

function providerName(providerID: string) {
  const configured = state.providers.find((provider) => provider.id === providerID);
  if (configured) return configured.name;
  return providerID
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(' ');
}
