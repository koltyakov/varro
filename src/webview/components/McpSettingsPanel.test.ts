import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { McpDefaults } from '../../shared/protocol';
import {
  getSelectedMcpsForSession,
  resetDefaultAppState,
  setMcpDefaults,
  setShowMcpSettings,
  setState,
  showMcpSettings,
  state,
} from '../lib/state';
import { McpSettingsPanel } from './McpSettingsPanel';

const mocks = vi.hoisted(() => ({
  defaults: vi.fn<() => Promise<McpDefaults>>(),
  setDefault:
    vi.fn<
      (name: string, scope: 'global' | 'project', enabled: boolean | null) => Promise<McpDefaults>
    >(),
  refreshSessionMcps: vi.fn<(sessionId?: string | null) => Promise<void>>(),
}));

/* oxlint-disable anti-slop/no-module-mocking -- Exercise settings against the client and connection reconciliation boundaries. */
vi.mock('../lib/client', () => ({
  client: { mcp: { defaults: mocks.defaults, setDefault: mocks.setDefault } },
}));
vi.mock('../hooks/useOpenCode', () => ({ refreshSessionMcps: mocks.refreshSessionMcps }));

const defaults: McpDefaults = {
  global: { rare: false, docs: true },
  project: { rare: true },
  effective: { rare: true, docs: true },
  editable: true,
};

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

async function flush() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

function openTab(label: 'This project' | 'Global') {
  const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (element) => element.textContent === label
  );
  if (!tab) throw new Error(`Missing ${label} tab`);
  tab.click();
}

function serverRow(name: string) {
  const row = [...container.querySelectorAll<HTMLElement>('.mcp-settings-server')].find(
    (element) => element.querySelector('label span')?.textContent === name
  );
  if (!row) throw new Error(`Missing row for ${name}`);
  return row;
}

function checkbox(name: string) {
  return serverRow(name).querySelector<HTMLInputElement>('input[type="checkbox"]')!;
}

function toggle(name: string) {
  checkbox(name).click();
}

function useGlobalButton(name: string) {
  return serverRow(name).querySelector<HTMLButtonElement>('.mcp-settings-reset');
}

beforeEach(() => {
  localStorage.clear();
  resetDefaultAppState();
  setShowMcpSettings(true);
  setState('editorContext', 'workspacePath', '/repo');
  setState('activeSessionId', 'current');
  mocks.defaults.mockReset().mockImplementation(async () => structuredClone(defaults));
  mocks.setDefault.mockReset();
  mocks.refreshSessionMcps.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  localStorage.clear();
  resetDefaultAppState();
});

describe('McpSettingsPanel', () => {
  it('shows one scope at a time on a separate screen with a back button', async () => {
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    expect(container.querySelector('h1')?.textContent).toBe('MCP settings');
    expect(container.querySelector('.dropdown-menu')).toBeNull();
    expect(container.querySelector('select')).toBeNull();
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('Global');
    expect(checkbox('rare').checked).toBe(false);
    openTab('This project');
    expect(container.querySelector('[aria-selected="true"]')?.textContent).toBe('This project');
    expect(checkbox('rare').checked).toBe(true);
    const back = container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!;
    expect(document.activeElement).toBe(back);
    back.click();
    expect(showMcpSettings()).toBe(false);
  });

  it('shows a loading indicator until settings arrive', async () => {
    let completeLoad!: (value: McpDefaults) => void;
    mocks.defaults.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeLoad = resolve;
        })
    );
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    const indicator = '[role="status"][aria-label="Loading MCP settings"]';
    expect(container.querySelector(indicator)).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    completeLoad(structuredClone(defaults));
    await flush();
    expect(container.querySelector(indicator)).toBeNull();
    expect(checkbox('rare').checked).toBe(false);
  });

  it('switches tabs with the arrow keys', async () => {
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    const tab = container.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const selected = container.querySelector<HTMLButtonElement>('[aria-selected="true"]')!;
    expect(selected.textContent).toBe('This project');
    expect(document.activeElement).toBe(selected);
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(
      selected.id
    );
  });

  it('saves a global default without replacing a project or session override', async () => {
    setState('sessionSelectedMcps', { current: [] });
    mocks.setDefault.mockResolvedValue({ ...defaults, global: { ...defaults.global, rare: true } });
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    openTab('Global');
    toggle('rare');
    await flush();
    expect(mocks.setDefault).toHaveBeenCalledWith('rare', 'global', true);
    expect(mocks.refreshSessionMcps).toHaveBeenCalledWith('current');
    expect(getSelectedMcpsForSession('current')).toEqual([]);
    expect(checkbox('rare').checked).toBe(true);
    openTab('This project');
    expect(checkbox('rare').checked).toBe(true);
  });

  it('saves a project override without changing its global default', async () => {
    mocks.setDefault.mockResolvedValue({
      ...defaults,
      project: { rare: false },
      effective: { ...defaults.effective, rare: false },
    });
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    openTab('This project');
    toggle('rare');
    await flush();
    expect(mocks.setDefault).toHaveBeenCalledWith('rare', 'project', false);
    expect(checkbox('rare').checked).toBe(false);
    openTab('Global');
    expect(checkbox('rare').checked).toBe(false);
  });

  it('keeps the new checkbox state while a save is pending', async () => {
    let completeSave!: (value: McpDefaults) => void;
    mocks.setDefault.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        })
    );
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    openTab('This project');
    toggle('docs');
    expect(checkbox('docs').checked).toBe(false);
    expect(checkbox('docs').disabled).toBe(true);
    expect(container.textContent).toContain('Saving...');
    completeSave({
      ...defaults,
      project: { ...defaults.project, docs: false },
      effective: { ...defaults.effective, docs: false },
    });
    await flush();
    expect(checkbox('docs').checked).toBe(false);
    expect(checkbox('docs').disabled).toBe(false);
  });

  it('offers Use global only for project overrides and clears them', async () => {
    mocks.setDefault.mockResolvedValue({
      global: { rare: false, docs: true },
      project: {},
      effective: { rare: false, docs: true },
      editable: true,
    });
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    openTab('This project');
    expect(useGlobalButton('docs')).toBeNull();
    useGlobalButton('rare')!.click();
    await flush();
    expect(mocks.setDefault).toHaveBeenCalledWith('rare', 'project', null);
    expect(useGlobalButton('rare')).toBeNull();
    expect(checkbox('rare').checked).toBe(false);
    expect(mocks.refreshSessionMcps).toHaveBeenCalledWith('current');
  });

  it('explains on the Global tab when this project differs', async () => {
    mocks.defaults.mockResolvedValue({
      global: { rare: false, docs: true, same: true },
      project: { rare: true, docs: false, same: true },
      effective: { rare: true, docs: false, same: true },
      editable: true,
    });
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    openTab('This project');
    expect(container.textContent).not.toContain('in this project');
    openTab('Global');
    expect(serverRow('rare').textContent).toContain('On in this project');
    expect(serverRow('docs').textContent).toContain('Off in this project');
    expect(serverRow('same').textContent).not.toContain('in this project');
  });

  it.each([null, 'current'])(
    'keeps session-specific controls and footer text out of settings for %s',
    async (id) => {
      setState('activeSessionId', id);
      if (id) setState('sessionSelectedMcps', { [id]: [] });
      else setState('draftSelectedMcps', []);
      cleanup = render(() => McpSettingsPanel(), container);
      await flush();
      expect(container.textContent).not.toContain('This session');
      expect(container.textContent).not.toContain('Use defaults');
      expect(container.textContent).not.toContain('Connections are shared');
      expect(container.textContent).not.toContain('Defaults save automatically');
      expect(getSelectedMcpsForSession(id)).toEqual([]);
      expect(mocks.refreshSessionMcps).not.toHaveBeenCalled();
      expect(mocks.setDefault).not.toHaveBeenCalled();
    }
  );

  it('disables configuration changes while shared sessions are running', async () => {
    setState('sessionStatus', { background: { type: 'busy' } });
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    openTab('This project');
    expect(checkbox('rare').disabled).toBe(true);
    expect(useGlobalButton('rare')?.disabled).toBe(true);
    expect(container.textContent).toContain('when running sessions finish');
    setState('sessionStatus', { background: { type: 'idle' } });
    expect(checkbox('rare').disabled).toBe(false);
  });

  it('shows attached-server configuration as a read-only list without tabs', async () => {
    mocks.defaults.mockResolvedValue({ ...defaults, global: {}, project: {}, editable: false });
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    expect(container.textContent).toContain('OpenCode server host');
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(checkbox('rare').checked).toBe(true);
    expect(checkbox('rare').disabled).toBe(true);
    expect(useGlobalButton('rare')).toBeNull();
  });

  it('does not offer a global default for project-only servers', async () => {
    mocks.defaults.mockResolvedValue({ ...defaults, global: { docs: true } });
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    openTab('This project');
    expect(checkbox('rare').disabled).toBe(false);
    expect(useGlobalButton('rare')).toBeNull();
    openTab('Global');
    expect(checkbox('rare').disabled).toBe(true);
    expect(serverRow('rare').textContent).toContain('Only configured in this project');
  });

  it('shows connection problems but not healthy status', async () => {
    setState('mcpStatus', {
      rare: { status: 'failed', error: 'spawn ENOENT' },
      docs: { status: 'connected' },
    });
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    expect(container.querySelector('.mcp-settings-server-error')?.textContent).toBe('spawn ENOENT');
    expect(serverRow('docs').textContent).toBe('docs');
  });

  it('reports save errors and restores the previous checkbox state', async () => {
    mocks.setDefault.mockRejectedValue(new Error('Configuration has unsaved changes'));
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    openTab('Global');
    toggle('rare');
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('unsaved changes');
    expect(checkbox('rare').checked).toBe(false);
    expect(mocks.refreshSessionMcps).not.toHaveBeenCalled();
  });

  it('retries a failed settings load without showing stale controls', async () => {
    mocks.defaults.mockRejectedValueOnce(new Error('Server unavailable'));
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    container.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    await flush();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(checkbox('rare').checked).toBe(false);
  });

  describe('settings loaded at startup', () => {
    const startup: McpDefaults = {
      global: { rare: false, docs: true, removed: true },
      project: { rare: true },
      effective: { rare: true, docs: true, removed: true },
      editable: true,
    };

    function deferRefresh() {
      let resolve!: (value: McpDefaults) => void;
      let reject!: (cause: Error) => void;
      mocks.defaults.mockImplementation(
        () =>
          new Promise((onResolve, onReject) => {
            resolve = onResolve;
            reject = onReject;
          })
      );
      return { resolve: (value: McpDefaults) => resolve(value), reject: (e: Error) => reject(e) };
    }

    function serverNames() {
      return [...container.querySelectorAll('.mcp-settings-server label span')].map(
        (element) => element.textContent
      );
    }

    beforeEach(() => {
      setMcpDefaults(structuredClone(startup));
    });

    it('shows startup values immediately and keeps checkboxes disabled while refreshing', async () => {
      deferRefresh();
      cleanup = render(() => McpSettingsPanel(), container);
      expect(container.querySelector('[aria-label="Loading MCP settings"]')).toBeNull();
      expect(serverNames()).toEqual(['docs', 'rare', 'removed']);
      expect(checkbox('docs').checked).toBe(true);
      expect(checkbox('docs').disabled).toBe(true);
      expect(container.querySelector('.mcp-settings-saving')?.textContent).toBe('Refreshing...');
      expect(container.querySelector('.mcp-settings-servers')?.getAttribute('aria-busy')).toBe(
        'true'
      );
      openTab('This project');
      expect(checkbox('rare').checked).toBe(true);
      expect(checkbox('rare').disabled).toBe(true);
      expect(useGlobalButton('rare')?.disabled).toBe(true);
      toggle('rare');
      useGlobalButton('rare')?.click();
      await flush();
      expect(mocks.setDefault).not.toHaveBeenCalled();
    });

    it('enables checkboxes after an unchanged refresh without touching connections', async () => {
      const refresh = deferRefresh();
      cleanup = render(() => McpSettingsPanel(), container);
      await flush();
      refresh.resolve(structuredClone(startup));
      await flush();
      expect(checkbox('docs').disabled).toBe(false);
      expect(checkbox('docs').checked).toBe(true);
      expect(container.querySelector('.mcp-settings-saving')).toBeNull();
      expect(container.querySelector('.mcp-settings-servers')?.getAttribute('aria-busy')).toBe(
        'false'
      );
      expect(mocks.refreshSessionMcps).not.toHaveBeenCalled();
    });

    it('updates values, servers and overrides that changed since startup', async () => {
      const refresh = deferRefresh();
      cleanup = render(() => McpSettingsPanel(), container);
      await flush();
      openTab('This project');
      expect(checkbox('docs').checked).toBe(true);
      expect(useGlobalButton('rare')).not.toBeNull();
      refresh.resolve({
        global: { rare: true, docs: false, added: true },
        project: {},
        effective: { rare: true, docs: false, added: true },
        editable: true,
      });
      await flush();
      expect(serverNames()).toEqual(['added', 'docs', 'rare']);
      expect(checkbox('docs').checked).toBe(false);
      expect(checkbox('added').checked).toBe(true);
      expect(checkbox('docs').disabled).toBe(false);
      expect(useGlobalButton('rare')).toBeNull();
      openTab('Global');
      expect(checkbox('rare').checked).toBe(true);
      expect(checkbox('docs').checked).toBe(false);
    });

    it('saves against refreshed values rather than startup values', async () => {
      const refresh = deferRefresh();
      cleanup = render(() => McpSettingsPanel(), container);
      await flush();
      refresh.resolve({
        global: { docs: false },
        project: {},
        effective: { docs: false },
        editable: true,
      });
      await flush();
      mocks.setDefault.mockResolvedValue({
        global: { docs: true },
        project: {},
        effective: { docs: true },
        editable: true,
      });
      toggle('docs');
      await flush();
      expect(mocks.setDefault).toHaveBeenCalledWith('docs', 'global', true);
      expect(checkbox('docs').checked).toBe(true);
    });

    it('switches to the read-only list when the refresh reports an attached server', async () => {
      const refresh = deferRefresh();
      cleanup = render(() => McpSettingsPanel(), container);
      await flush();
      expect(container.querySelector('[role="tablist"]')).not.toBeNull();
      refresh.resolve({ global: {}, project: {}, effective: { docs: true }, editable: false });
      await flush();
      expect(container.querySelector('[role="tablist"]')).toBeNull();
      expect(serverNames()).toEqual(['docs']);
      expect(checkbox('docs').checked).toBe(true);
      expect(checkbox('docs').disabled).toBe(true);
    });

    it('keeps startup values read-only after a failed refresh until a retry succeeds', async () => {
      const refresh = deferRefresh();
      cleanup = render(() => McpSettingsPanel(), container);
      await flush();
      refresh.reject(new Error('Server unavailable'));
      await flush();
      const alert = container.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain('Server unavailable');
      expect(alert?.textContent).toContain('Showing the last loaded settings');
      expect(serverNames()).toEqual(['docs', 'rare', 'removed']);
      expect(checkbox('docs').disabled).toBe(true);
      expect(container.querySelector('.mcp-settings-saving')).toBeNull();
      const retry = deferRefresh();
      alert?.querySelector('button')?.click();
      await flush();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(checkbox('docs').disabled).toBe(true);
      expect(container.querySelector('.mcp-settings-saving')?.textContent).toBe('Refreshing...');
      retry.resolve(structuredClone(startup));
      await flush();
      expect(checkbox('docs').disabled).toBe(false);
    });

    it('does not show one workspace values under another while refreshing', async () => {
      const first = deferRefresh();
      cleanup = render(() => McpSettingsPanel(), container);
      await flush();
      const next = deferRefresh();
      setState('editorContext', 'workspacePath', '/next');
      await flush();
      expect(container.querySelector('[aria-label="Loading MCP settings"]')).not.toBeNull();
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
      first.resolve(structuredClone(startup));
      await flush();
      expect(container.querySelector('input[type="checkbox"]')).toBeNull();
      next.resolve({
        global: { next: true },
        project: {},
        effective: { next: true },
        editable: true,
      });
      await flush();
      expect(serverNames()).toEqual(['next']);
      expect(checkbox('next').disabled).toBe(false);
    });

    it('ignores a refresh that finishes after the screen closes', async () => {
      const refresh = deferRefresh();
      cleanup = render(() => McpSettingsPanel(), container);
      await flush();
      cleanup();
      cleanup = undefined;
      refresh.resolve({ global: {}, project: {}, effective: {}, editable: true });
      await flush();
      expect(state.mcpDefaults?.effective).toEqual(startup.effective);
    });
  });

  it('ignores a pending save after the workspace changes', async () => {
    let completeSave!: (value: McpDefaults) => void;
    mocks.setDefault.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeSave = resolve;
        })
    );
    cleanup = render(() => McpSettingsPanel(), container);
    await flush();
    toggle('rare');
    mocks.defaults.mockResolvedValue({
      global: { next: false },
      project: {},
      effective: { next: false },
      editable: true,
    });
    setState('editorContext', 'workspacePath', '/next');
    await flush();
    completeSave({ ...defaults, global: { ...defaults.global, rare: true } });
    await flush();
    expect(state.mcpDefaults?.effective).toEqual({ next: false });
    expect(mocks.refreshSessionMcps).not.toHaveBeenCalled();
  });
});
