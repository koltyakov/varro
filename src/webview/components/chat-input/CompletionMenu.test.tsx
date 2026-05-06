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
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {
      disconnectObserverMock();
    }
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container?.remove();
  container = null;
  if (originalResizeObserver) {
    globalThis.ResizeObserver = originalResizeObserver;
  } else {
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
      () =>
        CompletionMenu({
          items: items(),
          selectedIndex: 0,
          onSelect,
        }),
      container!
    );

    expect(container?.querySelectorAll('button')).toHaveLength(2);

    setItems([]);
    await flushMicrotasks();

    expect(container?.querySelector('.composer-completion-header')).toBeNull();
    expect(container?.querySelectorAll('button')).toHaveLength(0);
  });

  it('scrolls the selected item into view and enables marquee overflow only on hover for files', async () => {
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
    vi.spyOn(HTMLSpanElement.prototype, 'clientWidth', 'get').mockImplementation(
      function (this: HTMLSpanElement) {
        return this.classList.contains('composer-completion-title-shell') ? 40 : 0;
      }
    );
    vi.spyOn(HTMLSpanElement.prototype, 'scrollWidth', 'get').mockImplementation(
      function (this: HTMLSpanElement) {
        return this.classList.contains('composer-completion-title') ? 140 : 0;
      }
    );

    const [selectedIndex, setSelectedIndex] = createSignal(1);

    cleanup = render(
      () =>
        CompletionMenu({
          items: [slashItem, fileItem],
          selectedIndex: selectedIndex(),
          onSelect: vi.fn(),
        }),
      container!
    );

    await flushMicrotasks();

    const menu = container?.querySelector<HTMLDivElement>('.composer-completion-menu');
    const fileTitle = Array.from(
      container?.querySelectorAll<HTMLSpanElement>('.composer-completion-title') ?? []
    ).find((element) => element.getAttribute('title') === fileItem.label);

    expect(menu?.scrollTop).toBe(40);
    expect(fileTitle?.className).toContain('marquee');
    expect(fileTitle?.style.getPropertyValue('--marquee-distance')).toBe('100px');
    expect(fileTitle?.className).not.toContain('selected');

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

    const icon = container?.querySelector('.composer-completion-icon svg');
    expect(icon?.getAttribute('viewBox')).toBe('0 0 16 16');
  });
});
