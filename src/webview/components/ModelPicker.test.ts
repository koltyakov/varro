import { flush as flushSolid, createComponent, Loading } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
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

function applyState(setter: Parameters<typeof setState>[0]) {
  setState(setter);
  flushSolid();
}

function renderPicker(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  cleanup = render(
    () => ModelPicker({ onSelect: vi.fn(), onClose: vi.fn(), ...props }),
    container!
  );
  flushSolid();
}

/** Hovers the first model row and advances fake timers past the details hover delay. */
function hoverFirstRowUntilDetailsOpen() {
  container
    ?.querySelector<HTMLElement>('.model-picker-row')
    ?.dispatchEvent(new MouseEvent('mouseenter'));
  flushSolid();
  vi.advanceTimersByTime(2_000);
  flushSolid();
}

async function flushMicrotasks(count = 2) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

/** Clears persisted picker preferences, app state, and provider connection state. */
function resetPickerState() {
  window.localStorage.removeItem(STORAGE_KEYS.pinnedModels);
  flushSolid();
  window.localStorage.removeItem(STORAGE_KEYS.modelDisplayNames);
  flushSolid();
  resetDefaultAppState();
  flushSolid();
  resetProviderConnectionState();
  flushSolid();
}

beforeEach(() => {
  vi.spyOn(client.config, 'modelPricing').mockResolvedValue(null);
  refreshProviderLimit.mockClear();
  restoreRuntime = installOpenCodeRuntime({ ...createOpenCodeRuntime(), refreshProviderLimit });
  flushSolid();
  resetPickerState();
  window.localStorage.removeItem(STORAGE_KEYS.modelPickerOpened);
  flushSolid();
  container = document.createElement('div');
  document.body.appendChild(container);
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  restoreRuntime?.();
  flushSolid();
  vi.useRealTimers();
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container?.remove();
  flushSolid();
  container = null;
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  flushSolid();
  setShowModels(false);
  flushSolid();
  resetPickerState();
  vi.restoreAllMocks();
  flushSolid();
});

describe('ModelPicker', () => {
  it('focuses search after positioning without scrolling the initial anchor into view', async () => {
    const focus = vi.spyOn(HTMLInputElement.prototype, 'focus');
    renderPicker();
    const menu = container!.querySelector<HTMLElement>('.model-picker-menu')!;

    expect(menu.hasAttribute('data-popup-position-pending')).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    await flushMicrotasks();
    flushSolid();

    expect(menu.hasAttribute('data-popup-position-pending')).toBe(false);
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(document.activeElement).toBe(container!.querySelector('.dropdown-search-input'));

    const other = document.createElement('button');
    container!.append(other);
    other.focus();
    window.dispatchEvent(new Event('resize'));
    await flushMicrotasks();
    expect(document.activeElement).toBe(other);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('preserves focus moved by the user before the picker is revealed', async () => {
    renderPicker();
    const menu = container!.querySelector<HTMLElement>('.model-picker-menu')!;
    expect(menu.hasAttribute('data-popup-position-pending')).toBe(true);
    const other = document.createElement('button');
    container!.append(other);
    other.focus();

    await flushMicrotasks();
    expect(menu.hasAttribute('data-popup-position-pending')).toBe(false);
    expect(document.activeElement).toBe(other);
  });

  it('clears the model highlight when the pointer leaves and restores keyboard navigation', async () => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          alpha: createModel('alpha', 'Alpha'),
          beta: createModel('beta', 'Beta'),
        }),
      ])
    );
    renderPicker();
    await flushMicrotasks();
    flushSolid();

    const row = container!.querySelector<HTMLElement>('.model-picker-row')!;
    row.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    expect(row.querySelector('.keyboard-focus')).not.toBeNull();

    row.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    container!.querySelector('.dropdown-group-header')!.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    expect(container!.querySelector('.keyboard-focus')).toBeNull();
    expect(container!.querySelector('.model-picker-details')).toBeNull();

    container!
      .querySelector('.dropdown-menu')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    flushSolid();
    expect(row.querySelector('.keyboard-focus')).not.toBeNull();
  });

  it('keeps the dropdown visible inside Loading while hover pricing loads', async () => {
    vi.useFakeTimers();
    let resolvePricing!: (pricing: ModelPricing | null) => void;
    const pending = new Promise<ModelPricing | null>((resolve) => {
      resolvePricing = resolve;
    });
    vi.mocked(client.config.modelPricing).mockReturnValue(pending);
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          sol: createModel('sol', 'Sol', { cost: { input: 0, output: 0 } }),
        }),
      ])
    );
    const onSelect = vi.fn();
    cleanup = render(
      () =>
        createComponent(Loading, {
          fallback: 'Loading picker',
          get children() {
            return ModelPicker({ onSelect, onClose: vi.fn() });
          },
        }),
      container!
    );
    flushSolid();
    await flushMicrotasks();
    flushSolid();
    hoverFirstRowUntilDetailsOpen();
    await flushMicrotasks(6);
    flushSolid();

    expect(client.config.modelPricing).toHaveBeenCalledWith('openai', 'sol');
    expect(container?.querySelector('.model-picker-menu')).not.toBeNull();
    expect(container?.textContent).not.toContain('Loading picker');
    expect(container?.querySelector('.model-picker-cost-heading')).toBeNull();
    container?.querySelector<HTMLButtonElement>('.model-picker-item')?.click();
    flushSolid();
    expect(onSelect).toHaveBeenCalledWith({ providerID: 'openai', modelID: 'sol' });

    resolvePricing({ input: 4, output: 20 });
    flushSolid();
    await flushMicrotasks(6);
    flushSolid();
    expect(container?.querySelector('.model-picker-menu')).not.toBeNull();
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain('$4.00');
  });

  it('loads provider quotas and updates remaining percentages without labeling pinned groups', async () => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          alpha: createModel('alpha', 'Alpha'),
          beta: createModel('beta', 'Beta'),
        }),
        createProvider('custom', 'Custom', { custom: createModel('custom', 'Custom') }),
      ])
    );
    applyState(storePath('pinnedModels', ['openai:alpha']));
    renderPicker();
    await flushMicrotasks();
    flushSolid();

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
    flushSolid();
    await flushMicrotasks();
    flushSolid();

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
    flushSolid();
    await flushMicrotasks();
    flushSolid();
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
    flushSolid();
    await flushMicrotasks();
    flushSolid();
    expect(container?.querySelector('.model-picker-provider-limit')).toBeNull();
  });

  it('uses manually ordered providers and models', async () => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          alpha: createModel('alpha', 'Alpha model'),
          zeta: createModel('zeta', 'Zeta model'),
        }),
        createProvider('custom', 'Custom', {
          custom: createModel('custom', 'Custom model'),
        }),
      ])
    );
    applyState(storePath('providerOrder', ['custom', 'openai']));
    applyState(storePath('modelOrder', ['openai:zeta', 'openai:alpha']));

    renderPicker();
    await flushMicrotasks();
    flushSolid();

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
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
      ])
    );
    applyState(storePath('providerDefaults', { openai: 'gpt-5' }));

    renderPicker();
    await flushMicrotasks();
    flushSolid();

    expect(container?.querySelector('.model-default-label')).toBeNull();
    expect(container?.querySelector('.model-picker-item')?.textContent).not.toContain('(default)');
  });

  it('shows and searches a renamed model while selecting its original ID', async () => {
    const onSelect = vi.fn();
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
      ])
    );
    applyState(storePath('modelDisplayNames', { 'openai:gpt-5': 'Primary coder' }));

    renderPicker({ onSelect });
    await flushMicrotasks();
    flushSolid();

    expect(container?.querySelector('.dropdown-name')?.textContent).toBe('Primary coder');
    const search = container?.querySelector<HTMLInputElement>('[aria-label="Search models"]');
    if (search) {
      search.value = 'primary';
      search.dispatchEvent(new InputEvent('input', { bubbles: true }));
      flushSolid();
    }
    flushSolid();
    container?.querySelector<HTMLButtonElement>('.model-picker-item')?.click();
    flushSolid();

    expect(onSelect).toHaveBeenCalledWith({ providerID: 'openai', modelID: 'gpt-5' });
  });

  it.each(['Fast', 'Ultrafast'])('shows a dimmed %s label after the flash icons', async (speed) => {
    applyState(
      storePath('providers', [
        createProvider('anthropic', 'Anthropic', {
          fast: createModel('fast', `Claude Opus 5 ${speed}`),
          standard: createModel('standard', 'Claude Opus 5'),
        }),
      ])
    );

    renderPicker();
    await flushMicrotasks();
    flushSolid();

    const fastLabel = Array.from(container?.querySelectorAll('.dropdown-name') ?? []).find(
      (item) => item.textContent === `Claude Opus 5 ${speed}`
    );
    const fastSymbol = fastLabel?.querySelector(
      '[aria-label="Fast mode may consume usage limits faster and cost more."]'
    );
    expect(fastSymbol?.querySelectorAll('.model-speed-icon')).toHaveLength(
      speed === 'Ultrafast' ? 2 : 1
    );
    expect(fastSymbol?.nextElementSibling?.classList.contains('model-speed-label')).toBe(true);
    expect(fastSymbol?.nextElementSibling?.textContent).toBe(speed);
    expect(
      container?.querySelectorAll(
        '[aria-label="Fast mode may consume usage limits faster and cost more."]'
      )
    ).toHaveLength(1);
  });

  it('shows model details only while hovering when there is room on the right', async () => {
    vi.useFakeTimers();
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          detailed: createModel('detailed', 'GPT-5 Detailed', {
            release_date: '2026-01-01',
            limit: { context: 400_000, output: 32_000 },
            capabilities: { toolcall: true, reasoning: true, input: ['text', 'image', 'pdf'] },
          }),
        }),
      ])
    );
    applyState(storePath('providerDefaults', { openai: 'detailed' }));

    renderPicker();
    await flushMicrotasks();
    flushSolid();

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
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(container?.querySelector('.model-picker-details')).toBeNull();
    vi.advanceTimersByTime(499);
    flushSolid();
    expect(container?.querySelector('.model-picker-details')).toBeNull();
    vi.advanceTimersByTime(1);
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(container?.querySelector('.model-picker-details')?.textContent).toContain('OpenAI');
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain(
      'Released2026/01/01'
    );
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain(
      'text, image, pdf'
    );
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain(
      'Allows reasoning'
    );
    expect(container?.querySelector('.model-picker-details')?.textContent).toContain('400k');

    row?.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();
    expect(container?.querySelector('.model-picker-details')).toBeNull();
  });

  it('shows model details above the picker on narrow screens', async () => {
    vi.useFakeTimers();
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(600);
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          detailed: createModel('detailed', 'GPT-5 Detailed', {
            limit: { context: 400_000, output: 32_000 },
            capabilities: { toolcall: true, reasoning: true, input: ['text', 'image'] },
          }),
        }),
      ])
    );

    renderPicker();
    await flushMicrotasks();
    flushSolid();

    container
      ?.querySelector<HTMLElement>('.model-picker-row')
      ?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(container?.querySelector('.model-picker-details')).toBeNull();
    vi.advanceTimersByTime(1_999);
    flushSolid();
    expect(container?.querySelector('.model-picker-details')).toBeNull();
    vi.advanceTimersByTime(1);
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    const anchor = container?.querySelector('.model-picker-anchor');
    const details = container?.querySelector('.model-picker-details');
    expect(details?.textContent).not.toContain('Released');
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
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          detailed: createModel('detailed', 'Detailed', { cost }),
        }),
      ])
    );
    renderPicker();
    await flushMicrotasks();
    flushSolid();

    hoverFirstRowUntilDetailsOpen();
    await flushMicrotasks();
    flushSolid();

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
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          sol: createModel('sol', 'Sol', {
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          }),
        }),
      ])
    );
    renderPicker();
    await flushMicrotasks();
    flushSolid();
    hoverFirstRowUntilDetailsOpen();
    await flushMicrotasks(6);
    flushSolid();

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
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          older: createModel('older', 'Older', { release_date: '2025-01-01' }),
          default: createModel('default', 'Default', { release_date: '2024-01-01' }),
          newer: createModel('newer', 'Newer', { release_date: '2026-01-01' }),
        }),
      ])
    );
    applyState(storePath('providerDefaults', { openai: 'default' }));

    renderPicker();
    await flushMicrotasks();
    flushSolid();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Newer', 'Older', 'Default']);
  });

  it('prioritizes mainstream providers, then orders providers alphabetically', async () => {
    applyState(
      storePath('providers', [
        createProvider('zulu', 'Zulu', { zulu: createModel('zulu', 'Zulu model') }),
        createProvider('google', 'Google', { google: createModel('google', 'Google model') }),
        createProvider('alpha', 'Alpha', { alpha: createModel('alpha', 'Alpha model') }),
        createProvider('openai', 'OpenAI', { openai: createModel('openai', 'OpenAI model') }),
        createProvider('beta', 'Beta', { beta: createModel('beta', 'Beta model') }),
      ])
    );

    renderPicker();
    await flushMicrotasks();
    flushSolid();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-group-header') ?? []).map(
        (item) => item.textContent
      )
    ).toEqual(['OpenAI', 'Google', 'Alpha', 'Beta', 'Zulu']);
  });

  it('only renders a checkmark for the selected model and updates it with the selection', async () => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          alpha: createModel('alpha', 'Alpha'),
          beta: createModel('beta', 'Beta'),
        }),
      ])
    );
    applyState(storePath('pinnedModels', ['openai:alpha']));
    applyState(storePath('selectedModel', { providerID: 'openai', modelID: 'alpha' }));
    renderPicker();
    await flushMicrotasks();
    flushSolid();

    const alpha = container!.querySelector('[data-model-id="alpha"]')!;
    const beta = container!.querySelector('[data-model-id="beta"]')!;
    expect(alpha.querySelector('.dropdown-check .ui-icon')).not.toBeNull();
    expect(beta.querySelector('.dropdown-check')).toBeNull();

    applyState(storePath('selectedModel', { providerID: 'openai', modelID: 'beta' }));
    await flushMicrotasks();
    flushSolid();
    expect(alpha.querySelector('.dropdown-check')).toBeNull();
    expect(beta.querySelector('.dropdown-check .ui-icon')).not.toBeNull();
  });

  it('pins models in a top group without selecting or closing the picker', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          sol: createModel('sol', 'GPT-5.6 Sol'),
        }),
        createProvider('github-copilot', 'GitHub Copilot', {
          luna: createModel('luna', 'GPT-5.6 Luna'),
        }),
      ])
    );

    renderPicker({ onSelect, onClose });
    await flushMicrotasks();
    flushSolid();

    const pinButton = container?.querySelector<HTMLButtonElement>(
      '[aria-label="Pin GPT-5.6 Luna"]'
    );
    pinButton?.click();
    flushSolid();
    await flushMicrotasks();
    flushSolid();

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
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(container?.querySelector('.dropdown-group-header')?.textContent).toBe('OpenAI');
    expect(container?.textContent).toContain('GitHub Copilot');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.pinnedModels)!)).toEqual([]);
  });

  it('hides providers that require re-authentication', async () => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
        createProvider('github-copilot', 'GitHub Copilot', {
          'gpt-5': createModel('gpt-5', 'GPT-5 Copilot'),
        }),
      ])
    );
    markProviderAuthFailure('github-copilot', 'failed-message');
    flushSolid();

    renderPicker();
    await flushMicrotasks();
    flushSolid();

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

    applyState(
      storePath('providers', [
        createProvider('alpha', 'Alpha Cloud', alphaModels),
        createProvider('beta', 'Beta Host', {
          owl: createModel('owl', 'Night Owl'),
        }),
      ])
    );

    renderPicker();
    await flushMicrotasks();
    flushSolid();

    const searchInput = container?.querySelector('input[aria-label="Search models"]');
    expect(searchInput).toBeInstanceOf(HTMLInputElement);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (searchInput as HTMLInputElement).value = 'Alpha Cloud';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    await flushMicrotasks();
    flushSolid();

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
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Night Owl']);

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    (searchInput as HTMLInputElement).value = 'missing';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    expect(container?.textContent).toContain('No matching models');
  });

  it('focuses search and selects the wrapped keyboard target from the current selection', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();

    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
          'gpt-5-mini': createModel('gpt-5-mini', 'GPT-5 mini'),
        }),
      ])
    );
    applyState(storePath('selectedModel', { providerID: 'openai', modelID: 'gpt-5-mini' }));

    renderPicker({ onSelect, onClose });
    await flushMicrotasks();
    flushSolid();

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
    flushSolid();
    await flushMicrotasks();
    flushSolid();

    menu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );
    flushSolid();

    expect(onSelect).toHaveBeenCalledWith({ providerID: 'openai', modelID: 'gpt-5' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('opens Models from the footer action and closes the picker', () => {
    const onClose = vi.fn();

    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
      ])
    );

    renderPicker({ onClose });

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const manageButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Manage models')
    ) as HTMLButtonElement | undefined;
    expect(manageButton).toBeInstanceOf(HTMLButtonElement);

    manageButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    expect(showModels()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('animates Manage models only on the first eligible open', () => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
      ])
    );

    renderPicker();

    const manageButton = container?.querySelector('.manage-models-attention');
    expect(manageButton).toBeInstanceOf(HTMLButtonElement);
    expect(manageButton?.querySelector('.dropdown-footer-label')?.classList).toContain(
      'shimmer-progress'
    );
    expect(manageButton?.querySelector('.dropdown-footer-icon')?.classList).toContain(
      'manage-models-attention-icon'
    );
    expect(window.localStorage.getItem(STORAGE_KEYS.modelPickerOpened)).toBe('true');

    cleanup!();
    flushSolid();
    renderPicker();

    expect(container?.querySelector('.manage-models-attention')).toBeNull();
  });

  it.each([
    { hiddenProviders: ['openai'], hiddenModels: [] },
    { hiddenProviders: [], hiddenModels: ['openai:gpt-5'] },
  ])('does not animate Manage models when models or providers are hidden', (visibility) => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
      ])
    );
    applyState(storePath('hiddenProviders', visibility.hiddenProviders));
    applyState(storePath('hiddenModels', visibility.hiddenModels));

    renderPicker();

    expect(container?.querySelector('.manage-models-attention')).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEYS.modelPickerOpened)).toBe('true');
  });

  it('can hide the manage models footer and customize the popup gap', async () => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
      ])
    );

    renderPicker({ showManageModels: false, popupGap: 6 });
    await flushMicrotasks();
    flushSolid();

    const list = container?.querySelector('.model-picker-list');
    expect(list?.classList.contains('pb-1')).toBe(true);
    expect(list?.classList.contains('py-1')).toBe(false);
    expect(container?.textContent).not.toContain('Manage models');
  });

  it('uses compact dimensions and a constrained height', async () => {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
      ])
    );

    renderPicker();
    await flushMicrotasks();
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const anchor = container?.firstElementChild as HTMLDivElement | null;
    const menu = container?.querySelector<HTMLElement>('.model-picker-menu');
    expect(anchor?.style.bottom).toBe('100%');
    expect(anchor?.classList).toContain('model-picker-anchor');
    expect(menu?.classList).toContain('model-picker-menu');
  });

  /**
   * Renders a single-model picker inside a host and beside a trigger with mocked geometry.
   * Callers flush microtasks afterwards so the popup positioning pass runs.
   */
  function renderPositionedPicker(
    viewportWidth: number,
    host: { left: number; right: number },
    trigger: { left: number; right: number; width?: number },
    props: Partial<Parameters<typeof ModelPicker>[0]> = {}
  ) {
    applyState(
      storePath('providers', [
        createProvider('openai', 'OpenAI', {
          'gpt-5': createModel('gpt-5', 'GPT-5'),
        }),
      ])
    );
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(viewportWidth);

    renderPicker(props);
    const anchor = container?.querySelector<HTMLElement>('.model-picker-anchor');
    const button = document.createElement('button');
    button.className = 'model-picker-btn';
    container?.appendChild(button);
    vi.spyOn(anchor!, 'offsetParent', 'get').mockReturnValue(container);
    vi.spyOn(container!, 'getBoundingClientRect').mockReturnValue({
      ...container!.getBoundingClientRect(),
      ...host,
      bottom: 500,
    });
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      ...button.getBoundingClientRect(),
      ...trigger,
      top: 450,
    });
    return anchor;
  }

  it('opens toward the left when the default width would cross the viewport edge', async () => {
    const anchor = renderPositionedPicker(320, { left: 0, right: 320 }, { left: 260, right: 300 });
    await flushMicrotasks();
    flushSolid();

    expect(anchor?.style.width).toBe('256.5px');
    expect(anchor?.style.left).toBe('44px');
  });

  it('reduces its width before opening toward the left', async () => {
    const anchor = renderPositionedPicker(320, { left: 0, right: 320 }, { left: 80, right: 120 });
    await flushMicrotasks();
    flushSolid();

    expect(anchor?.style.width).toBe('232px');
    expect(anchor?.style.left).toBe('80px');
  });

  it('shrinks to the viewport when the default width cannot fit', async () => {
    const anchor = renderPositionedPicker(240, { left: 0, right: 240 }, { left: 200, right: 230 });
    await flushMicrotasks();
    flushSolid();

    expect(anchor?.style.width).toBe('224px');
    expect(anchor?.style.left).toBe('8px');
  });

  it('limits its width and position to the input host', async () => {
    const anchor = renderPositionedPicker(
      600,
      { left: 100, right: 350 },
      { left: 300, right: 340 }
    );
    await flushMicrotasks();
    flushSolid();

    expect(anchor?.style.width).toBe('250px');
    expect(anchor?.style.left).toBe('0px');
  });

  it('can match the model trigger width', async () => {
    const anchor = renderPositionedPicker(
      600,
      { left: 100, right: 500 },
      { left: 120, right: 480, width: 360 },
      { matchTriggerWidth: true }
    );
    await flushMicrotasks();
    flushSolid();

    expect(anchor?.style.width).toBe('360px');
    expect(anchor?.style.left).toBe('20px');
  });
});
