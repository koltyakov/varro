import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { setState } from '../lib/state';
import { SettingsPanel } from './SettingsPanel';

const clientMocks = vi.hoisted(() => ({
  openCodeConfig: vi.fn(),
  saveModelRouting: vi.fn(),
}));

const refreshRoutingStateMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../lib/client', () => ({
  client: {
    varro: {
      openCodeConfig: clientMocks.openCodeConfig,
      saveModelRouting: clientMocks.saveModelRouting,
    },
  },
}));

vi.mock('../hooks/useOpenCode', () => ({
  refreshRoutingState: refreshRoutingStateMock,
}));

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  clientMocks.openCodeConfig.mockResolvedValue({
    smallModel: { providerID: 'openai', modelID: 'gpt-5-mini' },
    agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
  });
  clientMocks.saveModelRouting.mockResolvedValue({
    smallModel: { providerID: 'openai', modelID: 'gpt-5' },
    agentModels: { build: { providerID: 'openai', modelID: 'gpt-5' } },
  });
  setState('providers', [
    {
      id: 'openai',
      name: 'OpenAI',
      source: 'api',
      models: {
        'gpt-5': {
          id: 'gpt-5',
          name: 'GPT-5',
          capabilities: { toolcall: true },
          cost: { input: 1, output: 1 },
          limit: { context: 400000, output: 32000 },
        },
        'gpt-5-mini': {
          id: 'gpt-5-mini',
          name: 'GPT-5 mini',
          capabilities: { toolcall: true },
          cost: { input: 1, output: 1 },
          limit: { context: 128000, output: 16000 },
        },
      },
    },
  ]);
  setState('agents', [
    {
      name: 'build',
      mode: 'primary',
      builtIn: true,
      permission: { edit: 'allow', bash: { '*': 'allow' } },
      tools: {},
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
  ]);
  setState('allAgents', [
    {
      name: 'build',
      mode: 'primary',
      builtIn: true,
      permission: { edit: 'allow', bash: { '*': 'allow' } },
      tools: {},
      model: { providerID: 'openai', modelID: 'gpt-5' },
    },
    {
      name: 'review',
      mode: 'subagent',
      builtIn: true,
      permission: { edit: 'allow', bash: { '*': 'allow' } },
      tools: {},
      model: { providerID: 'openai', modelID: 'gpt-5-mini' },
    },
  ]);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  setState('providers', []);
  setState('agents', []);
  setState('allAgents', []);
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  }
  vi.restoreAllMocks();
});

describe('SettingsPanel', () => {
  it('shows routing tags loaded from opencode config and agents', async () => {
    cleanup = render(() => SettingsPanel(), container!);
    await Promise.resolve();

    expect(container?.textContent).toContain('small_model');
    expect(container?.textContent).toContain('agent: build');
  });

  it('opens the model context menu and saves a routing assignment', async () => {
    cleanup = render(() => SettingsPanel(), container!);
    await Promise.resolve();

    const row = Array.from(container?.querySelectorAll('.settings-model-row') || []).find(
      (item) => item.querySelector('.settings-model-name')?.textContent === 'GPT-5'
    ) as HTMLElement;
    expect(row).toBeTruthy();

    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 50,
      })
    );

    const menuItems = Array.from(document.querySelectorAll('.settings-context-menu-item'));
    expect(menuItems.some((item) => item.textContent?.includes('Use for agent: build'))).toBe(
      false
    );
    expect(menuItems.some((item) => item.textContent?.includes('Use for agent: review'))).toBe(
      true
    );

    const button = menuItems.find((item) =>
      item.textContent?.includes('Use for small_model')
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();
    button.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(clientMocks.saveModelRouting).toHaveBeenCalledWith({
      target: 'small_model',
      providerID: 'openai',
      modelID: 'gpt-5',
    });
    expect(refreshRoutingStateMock).toHaveBeenCalled();
  });
});
