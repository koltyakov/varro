import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionMenu, type CompletionItem } from './CompletionMenu';

const slashItem: CompletionItem = {
  key: 'slash-plan',
  type: 'slash',
  name: 'plan',
  aliases: ['p'],
  description: 'Show the current plan',
  action: vi.fn(),
};

const agentItem: CompletionItem = {
  key: 'agent-review',
  type: 'agent',
  label: 'reviewer',
  detail: 'Review recent changes',
  value: '@reviewer',
};

const fileItem: CompletionItem = {
  key: 'file-plan',
  type: 'file',
  label: 'src/features/coverage/really-long-plan-file-name.ts',
  detail: 'Workspace file',
  value: '@src/features/coverage/really-long-plan-file-name.ts',
  file: {
    path: '/workspace/src/features/coverage/really-long-plan-file-name.ts',
    relativePath: 'src/features/coverage/really-long-plan-file-name.ts',
    type: 'file',
  },
};

const directoryItem: CompletionItem = {
  key: 'file-docs',
  type: 'file',
  label: 'docs',
  detail: 'Folder',
  value: '@docs/',
  file: {
    path: '/workspace/docs',
    relativePath: 'docs',
    type: 'directory',
  },
};

const sessionItem: CompletionItem = {
  key: 'session-auth',
  type: 'session',
  label: 'Investigate authentication',
  detail: '',
  value: 'session:ses_auth ',
  session: {
    id: 'ses_auth',
    projectID: 'project-1',
    directory: '/workspace',
    title: 'Investigate authentication',
    version: '1.0.0',
    time: { created: 1, updated: 2 },
  },
};

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let disconnectObserverMock = vi.fn();

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  originalResizeObserver = globalThis.ResizeObserver;
  disconnectObserverMock = vi.fn();
  // SAFETY: The fixture provides the unknown fields read by this statement.
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {
      disconnectObserverMock();
    }
  } as typeof ResizeObserver;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  } else {
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  }
  vi.restoreAllMocks();
});

describe('CompletionMenu', () => {
  it('renders completion items, marks the selected entry, and forwards selection', () => {
    const onSelect = vi.fn();

    cleanup = render(
      () =>
        CompletionMenu({
          items: [slashItem, agentItem, fileItem],
          selectedIndex: 1,
          onSelect,
          header: 'Suggestions',
        }),
      container!
    );

    const header = container?.querySelector('.composer-completion-header');
    const buttons = container?.querySelectorAll<HTMLButtonElement>('button') ?? [];

    expect(header?.textContent).toBe('Suggestions');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.textContent).toContain('/plan');
    expect(buttons[1]?.className).toContain('selected');
    expect(buttons[1]?.querySelector('.completion-agent-icon')).toBeInstanceOf(HTMLImageElement);
    expect(buttons[2]?.querySelector('.composer-completion-title')?.getAttribute('title')).toBe(
      fileItem.label
    );

    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    buttons[0]?.dispatchEvent(mouseDown);
    buttons[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(mouseDown.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(fileItem);
  });

  it('removes stale item refs when the list rerenders to empty results', async () => {
    const onSelect = vi.fn();
    const [items, setItems] = createSignal<CompletionItem[]>([slashItem, agentItem]);

    cleanup = render(
      () => <CompletionMenu items={items()} selectedIndex={0} onSelect={onSelect} />,
      container!
    );

    expect(container?.querySelectorAll('button')).toHaveLength(2);

    setItems([]);
    await flushMicrotasks();

    expect(container?.querySelector('.composer-completion-header')).toBeNull();
    expect(container?.querySelectorAll('button')).toHaveLength(0);
  });

  it('scrolls the selected item into view without animating long file names', async () => {
    vi.spyOn(HTMLButtonElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLButtonElement) {
        return this.textContent?.includes('/plan') ? 0 : 60;
      }
    );
    vi.spyOn(HTMLButtonElement.prototype, 'offsetHeight', 'get').mockReturnValue(20);
    vi.spyOn(HTMLDivElement.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: HTMLDivElement) {
        return this.classList.contains('composer-completion-menu') ? 40 : 0;
      }
    );
    vi.spyOn(HTMLDivElement.prototype, 'offsetWidth', 'get').mockImplementation(
      function (this: HTMLDivElement) {
        return this.classList.contains('composer-completion-menu') ? 100 : 0;
      }
    );
    vi.spyOn(HTMLDivElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLDivElement) {
        return this.classList.contains('composer-completion-menu') ? 90 : 0;
      }
    );
    vi.spyOn(HTMLDivElement.prototype, 'clientLeft', 'get').mockImplementation(
      function (this: HTMLDivElement) {
        return this.classList.contains('composer-completion-menu') ? 1 : 0;
      }
    );

    const [selectedIndex, setSelectedIndex] = createSignal(1);

    cleanup = render(
      () => (
        <CompletionMenu
          items={[slashItem, fileItem]}
          selectedIndex={selectedIndex()}
          onSelect={vi.fn()}
        />
      ),
      container!
    );

    await flushMicrotasks();

    const menu = container?.querySelector<HTMLDivElement>('.composer-completion-menu');
    const fileTitle = Array.from(
      container?.querySelectorAll<HTMLSpanElement>('.composer-completion-title') ?? []
    ).find((element) => element.getAttribute('title') === fileItem.label);

    expect(menu?.scrollTop).toBe(44);
    expect(menu?.style.getPropertyValue('--composer-completion-scrollbar-inset')).toBe('8px');
    expect(fileTitle?.classList.contains('marquee')).toBe(false);
    expect(fileTitle?.getAttribute('style')).toBeNull();

    if (!menu) {
      throw new Error('Expected completion menu to render');
    }

    menu.scrollTop = 24;
    setSelectedIndex(0);
    await flushMicrotasks();

    expect(menu.scrollTop).toBe(0);

    cleanup?.();
    cleanup = undefined;
    expect(disconnectObserverMock).toHaveBeenCalled();
  });

  it('renders a folder icon for directory mention completions', () => {
    cleanup = render(
      () =>
        CompletionMenu({
          items: [directoryItem],
          selectedIndex: 0,
          onSelect: vi.fn(),
        }),
      container!
    );

    const icon = container?.querySelector<HTMLElement>('.composer-completion-icon .ui-icon');
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('12px');
    expect(icon?.style.getPropertyValue('--ui-icon-height')).toBe('12px');
  });

  it('renders a Material file-type icon for file mention completions', () => {
    cleanup = render(
      () =>
        CompletionMenu({
          items: [fileItem],
          selectedIndex: 0,
          onSelect: vi.fn(),
        }),
      container!
    );

    const icon = container?.querySelector('.composer-completion-icon img');
    expect(icon).toBeInstanceOf(HTMLImageElement);
    expect(icon?.classList).toContain('file-type-icon');
    expect(icon?.classList).toContain('completion-file-type-icon');
  });

  it('renders a session icon for session completions', () => {
    const now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const recentSessionItem: CompletionItem = {
      ...sessionItem,
      session: {
        ...sessionItem.session,
        time: { ...sessionItem.session.time, updated: now - 5 * 60_000 },
      },
    };
    cleanup = render(
      () => <CompletionMenu items={[recentSessionItem]} selectedIndex={0} onSelect={vi.fn()} />,
      container!
    );

    const icon = container?.querySelector('.composer-completion-icon img');
    const age = container?.querySelector('.composer-completion-age');
    expect(icon).toBeInstanceOf(HTMLImageElement);
    expect(icon?.classList).toContain('material-chip-icon');
    expect(icon?.classList).toContain('completion-session-icon');
    expect(age?.textContent).toBe('5m');
    expect(age?.getAttribute('title')).toBeNull();
  });
});
