import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { createComponent, Suspense } from 'solid-js';
import type { ModelPricing } from '../../shared/protocol';
import type { Provider } from '../types';
import { ModelPicker } from './ModelPicker';
import { client } from '../lib/client';
import {
  resetDefaultAppState,
  setProviderLimit,
  setShowModels,
  setState,
  showModels,
} from '../lib/state';
import {
  createOpenCodeRuntime,
  installOpenCodeRuntime,
} from '../hooks/runtime/useOpenCode.runtime';
import { STORAGE_KEYS } from '../lib/state-storage';
import {
  markProviderAuthFailure,
  resetProviderConnectionState,
} from '../lib/provider-connection-state';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

const refreshProviderLimit = vi.fn(async (_providerID: string) => {});
let restoreRuntime: (() => void) | undefined;

function createModel(
  id: string,
  name: string,
  overrides: Partial<Provider['models'][string]> = {}
) {
  return {
    id,
    name,
    capabilities: { toolcall: false },
    cost: { input: 1, output: 1 },
    ...overrides,
  } satisfies Provider['models'][string];
}

function createProvider(
  id: string,
  name: string,
  models: Record<string, Provider['models'][string]>
): Provider {
  return {
    id,
    name,
    source: 'api',
    models,
  };
}

async function flushMicrotasks(count = 2) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  vi.spyOn(client.config, 'modelPricing').mockResolvedValue(null);
  refreshProviderLimit.mockClear();
  restoreRuntime = installOpenCodeRuntime({ ...createOpenCodeRuntime(), refreshProviderLimit });
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  window.localStorage.removeItem(STORAGE_KEYS.modelDisplayNames);
  resetDefaultAppState();
  resetProviderConnectionState();
  window.localStorage.removeItem(STORAGE_KEYS.modelPickerOpened);
  container = document.createElement('div');
  document.body.appendChild(container);
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  restoreRuntime?.();
  vi.useRealTimers();
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  setShowModels(false);
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  window.localStorage.removeItem(STORAGE_KEYS.modelDisplayNames);
  resetDefaultAppState();
  resetProviderConnectionState();
  vi.restoreAllMocks();
});

describe('ModelPicker', () => {
  it('clears the model highlight when the pointer leaves and restores keyboard navigation', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        alpha: createModel('alpha', 'Alpha'),
        beta: createModel('beta', 'Beta'),
      }),
    ]);
    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    const row = container!.querySelector<HTMLElement>('.model-picker-row')!;
    row.dispatchEvent(new MouseEvent('mouseenter'));
    expect(row.querySelector('.keyboard-focus')).not.toBeNull();

    row.dispatchEvent(new MouseEvent('mouseleave'));
    container!.querySelector('.dropdown-group-header')!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(container!.querySelector('.keyboard-focus')).toBeNull();
    expect(container!.querySelector('.model-picker-details')).toBeNull();

    container!
      .querySelector('.dropdown-menu')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(row.querySelector('.keyboard-focus')).not.toBeNull();
  });

  it('keeps the dropdown visible inside Suspense while hover pricing loads', async () => {
    vi.useFakeTimers();
    let resolvePricing!: (pricing: ModelPricing | null) => void;
    const pending = new Promise<ModelPricing | null>((resolve) => {
      resolvePricing = resolve;
    });
    vi.mocked(client.config.modelPricing).mockReturnValue(pending);
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        sol: createModel('sol', 'Sol', { cost: { input: 0, output: 0 } }),
      }),
    ]);
    const onSelect = vi.fn();
    cleanup = render(
      () =>
        createComponent(Suspense, {
          fallback: 'Loading picker',
          get children() {
            return ModelPicker({ onSelect, onClose: vi.fn() });
          },
        }),
      container!
    );
    await flushMicrotasks();
    container
      ?.querySelector<HTMLElement>('.model-picker-row')
      ?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2_000);
    await flushMicrotasks(6);

    expect(client.config.modelPricing).toHaveBeenCalledWith('openai', 'sol');
    expect(container?.querySelector('.model-picker-menu')).not.toBeNull();
    expect(container?.textContent).not.toContain('Loading picker');
    expect(container?.querySelector('.model-picker-cost-heading')).toBeNull();
    container?.querySelector<HTMLButtonElement>('.model-picker-item')?.click();
    expect(onSelect).toHaveBeenCalledWith({ providerID: 'openai', modelID: 'sol' });

    resolvePricing({ input: 4, output: 20 });
    await flushMicrotasks(6);
    expect(container?.querySelector('.model-picker-menu')).not.toBeNull();
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain('$4.00');
  });

  it('loads provider quotas and updates remaining percentages without labeling pinned groups', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        alpha: createModel('alpha', 'Alpha'),
        beta: createModel('beta', 'Beta'),
      }),
      createProvider('custom', 'Custom', { custom: createModel('custom', 'Custom') }),
    ]);
    setState('pinnedModels', ['openai:alpha']);
    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    expect(refreshProviderLimit).toHaveBeenCalledWith('openai', undefined);
    expect(refreshProviderLimit).toHaveBeenCalledWith('custom', undefined);
    expect(container?.querySelector('.model-picker-provider-limit')).toBeNull();

    setProviderLimit('openai', null, {
      providerID: 'openai',
      status: 'available',
      source: 'provider',
      checkedAt: 1,
      windows: [
        {
          id: 'five_hour',
          label: '5 hour',
          unit: 'requests',
          remaining: 82,
          limit: 100,
          resetAt: null,
        },
        {
          id: 'weekly',
          label: 'Weekly',
          unit: 'tokens',
          remaining: 640,
          limit: 1000,
          resetAt: null,
        },
        {
          id: 'spark_five_hour',
          label: '5-Hour Limit (Spark)',
          unit: 'requests',
          remaining: 100,
          limit: 100,
          resetAt: null,
        },
        {
          id: 'spark_weekly',
          label: 'Weekly Limit (Spark)',
          unit: 'requests',
          remaining: 100,
          limit: 100,
          resetAt: null,
        },
      ],
    });
    await flushMicrotasks();

    const limits = container!.querySelectorAll('.model-picker-provider-limit');
    expect(limits).toHaveLength(1);
    expect(limits[0]?.textContent).toBe('5h 82% w 64% left');
    expect(limits[0]?.getAttribute('aria-label')).toBe('OpenAI limits remaining: 5h 82%, w 64%');
    expect(container?.querySelector('.dropdown-group-header')?.textContent).toBe('Pinned');

    setProviderLimit('openai', null, {
      providerID: 'openai',
      status: 'available',
      source: 'provider',
      checkedAt: 2,
      windows: [
        {
          id: 'five_hour',
          label: '5 hour',
          unit: 'requests',
          remaining: 0,
          limit: 100,
          resetAt: null,
        },
      ],
    });
    await flushMicrotasks();
    expect(container?.querySelector('.model-picker-provider-limit')?.textContent).toBe(
      '5h 0% left'
    );

    setProviderLimit('openai', null, {
      providerID: 'openai',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 3,
      note: 'No quota available',
    });
    await flushMicrotasks();
    expect(container?.querySelector('.model-picker-provider-limit')).toBeNull();
  });

  it('uses manually ordered providers and models', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        alpha: createModel('alpha', 'Alpha model'),
        zeta: createModel('zeta', 'Zeta model'),
      }),
      createProvider('custom', 'Custom', {
        custom: createModel('custom', 'Custom model'),
      }),
    ]);
    setState('providerOrder', ['custom', 'openai']);
    setState('modelOrder', ['openai:zeta', 'openai:alpha']);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-group-header') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['Custom', 'OpenAI']);
    expect(
      Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['Custom model', 'Zeta model', 'Alpha model']);
  });

  it('does not label provider defaults in the dropdown', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);
    setState('providerDefaults', { openai: 'gpt-5' });

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    expect(container?.querySelector('.model-default-label')).toBeNull();
    expect(container?.querySelector('.model-picker-item')?.textContent).not.toContain('(default)');
  });

  it('shows and searches a renamed model while selecting its original ID', async () => {
    const onSelect = vi.fn();
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);
    setState('modelDisplayNames', { 'openai:gpt-5': 'Primary coder' });

    cleanup = render(() => ModelPicker({ onSelect, onClose: vi.fn() }), container!);
    await flushMicrotasks();

    expect(container?.querySelector('.dropdown-name')?.textContent).toBe('Primary coder');
    const search = container?.querySelector<HTMLInputElement>('[aria-label="Search models"]');
    if (search) {
      search.value = 'primary';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    container?.querySelector<HTMLButtonElement>('.model-picker-item')?.click();

    expect(onSelect).toHaveBeenCalledWith({ providerID: 'openai', modelID: 'gpt-5' });
  });

  it('labels the Claude Fast lightning symbol on hover', async () => {
    setState('providers', [
      createProvider('anthropic', 'Anthropic', {
        fast: createModel('fast', 'Claude Opus 5 Fast'),
        standard: createModel('standard', 'Claude Opus 5'),
      }),
    ]);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    const fastLabel = Array.from(container?.querySelectorAll('.dropdown-name') ?? []).find(
      (item) => item.textContent === 'Claude Opus 5 ⚡'
    );
    const fastSymbol = fastLabel?.querySelector(
      '[aria-label="Fast mode may consume usage limits faster and cost more."]'
    );
    expect(fastSymbol?.textContent).toBe('⚡');
    expect(
      container?.querySelectorAll(
        '[aria-label="Fast mode may consume usage limits faster and cost more."]'
      )
    ).toHaveLength(1);
  });

  it('shows model details only while hovering when there is room on the right', async () => {
    vi.useFakeTimers();
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        detailed: createModel('detailed', 'GPT-5 Detailed', {
          release_date: '2026-01-01',
          limit: { context: 400_000, output: 32_000 },
          capabilities: { toolcall: true, reasoning: true, input: ['text', 'image', 'pdf'] },
        }),
      }),
    ]);
    setState('providerDefaults', { openai: 'detailed' });

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    expect(container?.querySelector('.model-picker-item')?.textContent).toContain('GPT-5 Detailed');
    expect(container?.querySelector('.model-picker-item')?.textContent).not.toContain('400k');
    expect(container?.querySelector('.model-picker-details')).toBeNull();

    const row = container?.querySelector<HTMLElement>('.model-picker-row');
    const menu = container?.querySelector<HTMLElement>('.model-picker-menu');
    vi.spyOn(menu!, 'getBoundingClientRect').mockReturnValue({
      ...menu!.getBoundingClientRect(),
      right: 300,
    });
    row?.dispatchEvent(new MouseEvent('mouseenter'));
    await flushMicrotasks();

    expect(container?.querySelector('.model-picker-details')).toBeNull();
    vi.advanceTimersByTime(499);
    expect(container?.querySelector('.model-picker-details')).toBeNull();
    vi.advanceTimersByTime(1);
    await flushMicrotasks();

    expect(container?.querySelector('.model-picker-details')?.textContent).toContain('OpenAI');
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain(
      'text, image, pdf'
    );
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain(
      'Allows reasoning'
    );
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain('400k');

    row?.dispatchEvent(new MouseEvent('mouseleave'));
    expect(container?.querySelector('.model-picker-details')).toBeNull();
  });

  it('shows model details above the picker on narrow screens', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(600);
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        detailed: createModel('detailed', 'GPT-5 Detailed', {
          limit: { context: 400_000, output: 32_000 },
          capabilities: { toolcall: true, reasoning: true, input: ['text', 'image'] },
        }),
      }),
    ]);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    container
      ?.querySelector<HTMLElement>('.model-picker-row')
      ?.dispatchEvent(new MouseEvent('mouseenter'));
    await flushMicrotasks();

    expect(container?.querySelector('.model-picker-details')).toBeNull();
    vi.advanceTimersByTime(1_999);
    expect(container?.querySelector('.model-picker-details')).toBeNull();
    vi.advanceTimersByTime(1);
    await flushMicrotasks();

    const anchor = container?.querySelector('.model-picker-anchor');
    const details = container?.querySelector('.model-picker-details');
    expect(anchor?.classList).toContain('details-on-top');
    expect(details?.classList).toContain('top');
    expect(details?.textContent).toContain('OpenAI');
    expect(details?.compareDocumentPosition(container!.querySelector('.model-picker-menu')!)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING
    );
  });

  it.each([
    {
      name: 'all supplied rates',
      cost: { input: 4, output: 20, cache: { read: 0.4, write: 5 } },
      expected: ['Input$4.00', 'Output$20.00', 'Cache read$0.40', 'Cache write$5.00'],
    },
    {
      name: 'zero and fractional rates without cache pricing',
      cost: { input: 0, output: 0.025 },
      expected: ['Input$0.00', 'Output$0.025'],
    },
    {
      name: 'missing pricing',
      cost: undefined,
      expected: [],
    },
    {
      name: 'invalid rates',
      cost: { input: Number.NaN, output: Number.POSITIVE_INFINITY, cache: { read: -1, write: 0 } },
      expected: [],
    },
    {
      name: 'all-zero OpenCode pricing',
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      expected: [],
    },
  ])('shows only available model pricing: $name', async ({ cost, expected }) => {
    vi.useFakeTimers();
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        detailed: createModel('detailed', 'Detailed', { cost }),
      }),
    ]);
    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    container
      ?.querySelector<HTMLElement>('.model-picker-row')
      ?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2_000);
    await flushMicrotasks();

    const heading = container?.querySelector('.model-picker-cost-heading');
    if (expected.length === 0) {
      expect(heading).toBeNull();
    } else {
      expect(heading?.textContent).toBe('Cost ($/1M tokens)');
      expect(Array.from(heading!.nextElementSibling!.children, (row) => row.textContent)).toEqual(
        expected
      );
    }
  });

  it('shows catalog rates when OpenCode zeroes subscription model costs', async () => {
    vi.useFakeTimers();
    vi.mocked(client.config.modelPricing).mockResolvedValue({
      input: 4,
      output: 20,
      cache_read: 0.4,
      cache_write: 5,
    });
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        sol: createModel('sol', 'Sol', {
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        }),
      }),
    ]);
    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();
    container
      ?.querySelector<HTMLElement>('.model-picker-row')
      ?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2_000);
    await flushMicrotasks(6);

    expect(client.config.modelPricing).toHaveBeenCalledWith('openai', 'sol');
    const heading = container?.querySelector('.model-picker-cost-heading');
    expect(Array.from(heading!.nextElementSibling!.children, (row) => row.textContent)).toEqual([
      'Input$4.00',
      'Output$20.00',
      'Cache read$0.40',
      'Cache write$5.00',
    ]);
  });

  it('orders models by release date without prioritizing the provider default', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        older: createModel('older', 'Older', { release_date: '2025-01-01' }),
        default: createModel('default', 'Default', { release_date: '2024-01-01' }),
        newer: createModel('newer', 'Newer', { release_date: '2026-01-01' }),
      }),
    ]);
    setState('providerDefaults', { openai: 'default' });

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Newer', 'Older', 'Default']);
  });

  it('prioritizes mainstream providers, then orders providers alphabetically', async () => {
    setState('providers', [
      createProvider('zulu', 'Zulu', { zulu: createModel('zulu', 'Zulu model') }),
      createProvider('google', 'Google', { google: createModel('google', 'Google model') }),
      createProvider('alpha', 'Alpha', { alpha: createModel('alpha', 'Alpha model') }),
      createProvider('openai', 'OpenAI', { openai: createModel('openai', 'OpenAI model') }),
      createProvider('beta', 'Beta', { beta: createModel('beta', 'Beta model') }),
    ]);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-group-header') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['OpenAI', 'Google', 'Alpha', 'Beta', 'Zulu']);
  });

  it('pins models in a top group without selecting or closing the picker', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        sol: createModel('sol', 'GPT-5.6 Sol'),
      }),
      createProvider('github-copilot', 'GitHub Copilot', {
        luna: createModel('luna', 'GPT-5.6 Luna'),
      }),
    ]);

    cleanup = render(() => ModelPicker({ onSelect, onClose }), container!);
    await flushMicrotasks();

    const pinButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Pin GPT-5.6 Luna"]'
    );
    pinButton?.click();
    await flushMicrotasks();

    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(
      Array.from(container?.querySelectorAll('.dropdown-group-header') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['Pinned', 'OpenAI']);
    expect(container?.querySelectorAll('.dropdown-name')).toHaveLength(2);
    const pinnedRow = container?.querySelector('.model-picker-row.pinned');
    expect(pinnedRow?.textContent).toContain('GPT-5.6 Luna');
    expect(pinnedRow?.querySelector('.model-picker-provider-name')?.textContent).toBe(
      'GitHub Copilot'
    );
    expect(pinnedRow?.querySelector('[aria-label="Unpin GPT-5.6 Luna"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([
      'github-copilot:luna',
    ]);

    pinnedRow?.querySelector<HTMLButtonElement>('[aria-label="Unpin GPT-5.6 Luna"]')?.click();
    await flushMicrotasks();

    expect(container?.querySelector('.dropdown-group-header')?.textContent).toBe('OpenAI');
    expect(container?.textContent).toContain('GitHub Copilot');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([]);
  });

  it('hides providers that require re-authentication', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
      createProvider('github-copilot', 'GitHub Copilot', {
        'gpt-5': createModel('gpt-5', 'GPT-5 Copilot'),
      }),
    ]);
    markProviderAuthFailure('github-copilot', 'failed-message');

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    await flushMicrotasks();

    expect(container?.textContent).toContain('OpenAI');
    expect(container?.textContent).toContain('GPT-5');
    expect(container?.textContent).not.toContain('GitHub Copilot');
    expect(container?.textContent).not.toContain('GPT-5 Copilot');
  });

  it('always shows search and filters by provider or model query', async () => {
    const alphaModels = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => {
        const id = `alpha-${index + 1}`;
        return [id, createModel(id, `Alpha ${index + 1}`)];
      })
    );

    setState('providers', [
      createProvider('alpha', 'Alpha Cloud', alphaModels),
      createProvider('beta', 'Beta Host', {
        owl: createModel('owl', 'Night Owl'),
      }),
    ]);

    cleanup = render(
      () =>
        ModelPicker({
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      container!
    );
    await flushMicrotasks();

    const searchInput = container?.querySelector('input[aria-label="Search models"]');
    expect(searchInput).toBeInstanceOf(HTMLInputElement);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (searchInput as HTMLInputElement).value = 'Alpha Cloud';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    const providerHeaders = Array.from(
      container?.querySelectorAll('.dropdown-group-header') ?? []
    ).map((item) => item.textContent?.trim());
    const modelNames = Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map((item) =>
      item.textContent?.trim()
    );
    expect(providerHeaders).toEqual(['Alpha Cloud']);
    expect(modelNames).toContain('Alpha 1');
    expect(modelNames).toContain('Alpha 10');
    expect(modelNames).not.toContain('Night Owl');

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (searchInput as HTMLInputElement).value = 'Night Owl';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Night Owl']);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (searchInput as HTMLInputElement).value = 'missing';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    expect(container?.textContent).toContain('No matching models');
  });

  it('focuses search and selects the wrapped keyboard target from the current selection', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
        'gpt-5-mini': createModel('gpt-5-mini', 'GPT-5 mini'),
      }),
    ]);
    setState('selectedModel', { providerID: 'openai', modelID: 'gpt-5-mini' });

    cleanup = render(() => ModelPicker({ onSelect, onClose }), container!);
    await flushMicrotasks();

    const menu = container?.querySelector('.dropdown-menu');
    const search = container?.querySelector<HTMLInputElement>('[aria-label="Search models"]');
    expect(menu).toBeInstanceOf(HTMLDivElement);
    expect(search).toBeInstanceOf(HTMLInputElement);
    expect(document.activeElement).toBe(search);
    const searchIcon = container?.querySelector<HTMLElement>('.ui-icon.dropdown-search-icon');
    expect(searchIcon).toBeInstanceOf(HTMLSpanElement);
    expect(searchIcon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    expect(searchIcon?.style.getPropertyValue('--ui-icon-height')).toBe('12px');

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    );
    await flushMicrotasks();

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );

    expect(onSelect).toHaveBeenCalledWith({ providerID: 'openai', modelID: 'gpt-5' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('opens Models from the footer action and closes the picker', () => {
    const onClose = vi.fn();

    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);

    cleanup = render(
      () =>
        ModelPicker({
          onSelect: vi.fn(),
          onClose,
        }),
      container!
    );

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const manageButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Manage models')
    ) as HTMLButtonElement | undefined;
    expect(manageButton).toBeInstanceOf(HTMLButtonElement);

    manageButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(showModels()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('animates Manage models only on the first eligible open', () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);

    const manageButton = container?.querySelector('.manage-models-attention');
    expect(manageButton).toBeInstanceOf(HTMLButtonElement);
    expect(manageButton?.querySelector('.dropdown-footer-label')?.classList).toContain(
      'shimmer-progress'
    );
    expect(manageButton?.querySelector('.dropdown-footer-icon')?.classList).toContain(
      'manage-models-attention-icon'
    );
    expect(window.localStorage.getItem(STORAGE_KEYS.modelPickerOpened)).toBe('true');

    cleanup();
    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);

    expect(container?.querySelector('.manage-models-attention')).toBeNull();
  });

  it.each([
    { hiddenProviders: ['openai'], hiddenModels: [] },
    { hiddenProviders: [], hiddenModels: ['openai:gpt-5'] },
  ])('does not animate Manage models when models or providers are hidden', (visibility) => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);
    setState('hiddenProviders', visibility.hiddenProviders);
    setState('hiddenModels', visibility.hiddenModels);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);

    expect(container?.querySelector('.manage-models-attention')).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.modelPickerOpened)).toBe('true');
  });

  it('can hide the manage models footer and customize the popup gap', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);

    cleanup = render(
      () =>
        ModelPicker({
          onSelect: vi.fn(),
          onClose: vi.fn(),
          showManageModels: false,
          popupGap: 6,
        }),
      container!
    );
    await flushMicrotasks();

    const list = container?.querySelector('.model-picker-list');
    expect(list?.classList.contains('pb-1')).toBe(true);
    expect(list?.classList.contains('py-1')).toBe(false);
    expect(container?.textContent).not.toContain('Manage models');
  });

  it('uses compact dimensions and a constrained height', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);

    cleanup = render(
      () =>
        ModelPicker({
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      container!
    );
    await flushMicrotasks();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.firstElementChild as HTMLDivElement | null;
    const menu = container?.querySelector<HTMLElement>('.model-picker-menu');
    expect(anchor?.style.bottom).toBe('100%');
    expect(anchor?.classList).toContain('model-picker-anchor');
    expect(menu?.classList).toContain('model-picker-menu');
  });

  it('opens toward the left when the default width would cross the viewport edge', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(320);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    const anchor = container?.querySelector<HTMLElement>('.model-picker-anchor');
    const button = document.createElement('button');
    button.className = 'model-picker-btn';
    container?.appendChild(button);
    vi.spyOn(anchor!, 'offsetParent', 'get').mockReturnValue(container);
    vi.spyOn(container!, 'getBoundingClientRect').mockReturnValue({
      ...container!.getBoundingClientRect(),
      left: 0,
      right: 320,
      bottom: 500,
    });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      ...button.getBoundingClientRect(),
      left: 260,
      right: 300,
      top: 450,
    });
    await flushMicrotasks();

    expect(anchor?.style.width).toBe('256.5px');
    expect(anchor?.style.left).toBe('44px');
  });

  it('reduces its width before opening toward the left', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(320);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    const anchor = container?.querySelector<HTMLElement>('.model-picker-anchor');
    const button = document.createElement('button');
    button.className = 'model-picker-btn';
    container?.appendChild(button);
    vi.spyOn(anchor!, 'offsetParent', 'get').mockReturnValue(container);
    vi.spyOn(container!, 'getBoundingClientRect').mockReturnValue({
      ...container!.getBoundingClientRect(),
      left: 0,
      right: 320,
      bottom: 500,
    });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      ...button.getBoundingClientRect(),
      left: 80,
      right: 120,
      top: 450,
    });
    await flushMicrotasks();

    expect(anchor?.style.width).toBe('232px');
    expect(anchor?.style.left).toBe('80px');
  });

  it('shrinks to the viewport when the default width cannot fit', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(240);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    const anchor = container?.querySelector<HTMLElement>('.model-picker-anchor');
    const button = document.createElement('button');
    button.className = 'model-picker-btn';
    container?.appendChild(button);
    vi.spyOn(anchor!, 'offsetParent', 'get').mockReturnValue(container);
    vi.spyOn(container!, 'getBoundingClientRect').mockReturnValue({
      ...container!.getBoundingClientRect(),
      left: 0,
      right: 240,
      bottom: 500,
    });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      ...button.getBoundingClientRect(),
      left: 200,
      right: 230,
      top: 450,
    });
    await flushMicrotasks();

    expect(anchor?.style.width).toBe('224px');
    expect(anchor?.style.left).toBe('8px');
  });

  it('limits its width and position to the input host', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(600);

    cleanup = render(() => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn() }), container!);
    const anchor = container?.querySelector<HTMLElement>('.model-picker-anchor');
    const button = document.createElement('button');
    button.className = 'model-picker-btn';
    container?.appendChild(button);
    vi.spyOn(anchor!, 'offsetParent', 'get').mockReturnValue(container);
    vi.spyOn(container!, 'getBoundingClientRect').mockReturnValue({
      ...container!.getBoundingClientRect(),
      left: 100,
      right: 350,
      bottom: 500,
    });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      ...button.getBoundingClientRect(),
      left: 300,
      right: 340,
      top: 450,
    });
    await flushMicrotasks();

    expect(anchor?.style.width).toBe('250px');
    expect(anchor?.style.left).toBe('0px');
  });

  it('can match the model trigger width', async () => {
    setState('providers', [
      createProvider('openai', 'OpenAI', {
        'gpt-5': createModel('gpt-5', 'GPT-5'),
      }),
    ]);
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(600);

    cleanup = render(
      () => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn(), matchTriggerWidth: true }),
      container!
    );
    const anchor = container?.querySelector<HTMLElement>('.model-picker-anchor');
    const button = document.createElement('button');
    button.className = 'model-picker-btn';
    container?.appendChild(button);
    vi.spyOn(anchor!, 'offsetParent', 'get').mockReturnValue(container);
    vi.spyOn(container!, 'getBoundingClientRect').mockReturnValue({
      ...container!.getBoundingClientRect(),
      left: 100,
      right: 500,
      bottom: 500,
    });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      ...button.getBoundingClientRect(),
      left: 120,
      right: 480,
      width: 360,
      top: 450,
    });
    await flushMicrotasks();

    expect(anchor?.style.width).toBe('360px');
    expect(anchor?.style.left).toBe('20px');
  });
});
