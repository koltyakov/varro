import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { Provider } from '../types';
import { ModelPicker } from './ModelPicker';
import { resetDefaultAppState, setShowSettings, setState, showSettings } from '../lib/state';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined;

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
  resetDefaultAppState();
  container = document.createElement('div');
  document.body.appendChild(container);
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  setShowSettings(false);
  resetDefaultAppState();
  vi.restoreAllMocks();
});

describe('ModelPicker', () => {
  it('shows the provider default first and newer models before older models', async () => {
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
    ).toEqual(['Default', 'Newer', 'Older']);
  });

  it('shows search only when more than ten models are visible and filters by provider or model query', async () => {
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

    (searchInput as HTMLInputElement).value = 'Night Owl';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    expect(
      Array.from(container?.querySelectorAll('.dropdown-name') ?? []).map((item) =>
        item.textContent?.trim()
      )
    ).toEqual(['Night Owl']);

    (searchInput as HTMLInputElement).value = 'missing';
    searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
    await flushMicrotasks();

    expect(container?.textContent).toContain('No matching models');
  });

  it('focuses the menu and selects the wrapped keyboard target from the current selection', async () => {
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
    expect(menu).toBeInstanceOf(HTMLDivElement);
    expect(document.activeElement).toBe(menu);

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

  it('opens settings from the footer action and closes the picker', () => {
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

    const manageButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Manage Models')
    ) as HTMLButtonElement | undefined;
    expect(manageButton).toBeInstanceOf(HTMLButtonElement);

    manageButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(showSettings()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
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

    const anchor = container?.firstElementChild as HTMLDivElement | null;
    expect(anchor?.style.paddingBottom).toBe('6px');
    expect(container?.textContent).not.toContain('Manage Models');
  });

  it('keeps the original popup gap', async () => {
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

    const anchor = container?.firstElementChild as HTMLDivElement | null;
    expect(anchor?.style.bottom).toBe('100%');
    expect(anchor?.style.paddingBottom).toBe('10px');
  });
});
