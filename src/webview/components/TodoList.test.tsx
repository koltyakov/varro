import { flush as flushSolid, Show } from 'solid-js';
import { storePath } from '@solidjs/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { TodoList } from './TodoList';
import { DEFAULT_TOOLTIP_DELAY } from './Tooltip';
import { resetDefaultAppState, setState, state } from '../lib/state';
import { createTodoSyncOperations } from '../hooks/todo-sync';
import { STORAGE_KEYS, readStored, writeStored } from '../lib/state-storage';
import type { MessageEntry, NormalizedTodo, UserMessage } from '../types';
import { fixture } from '../test-fixtures';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;
let originalResizeObserver: typeof globalThis.ResizeObserver | undefined;
let originalScrollIntoView: PropertyDescriptor | undefined;

describe('TodoList', () => {
  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver;
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollIntoView'
    );
    resetDefaultAppState();
    flushSolid();
    writeStored(STORAGE_KEYS.todoListCollapsed, null);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    flushSolid();
    cleanup?.();
    flushSolid();
    cleanup = undefined;
    container?.remove();
    flushSolid();
    container = null;
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    }
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
      delete (
        HTMLElement.prototype as { scrollIntoView?: typeof HTMLElement.prototype.scrollIntoView }
      ).scrollIntoView;
    }
    resetDefaultAppState();
    flushSolid();
    writeStored(STORAGE_KEYS.todoListCollapsed, null);
  });

  it('renders an empty todo list with accessible list semantics', () => {
    cleanup = render(() => TodoList(), container!);
    flushSolid();

    const toggle = container?.querySelector('button.todo-block-header');
    const list = container?.querySelector('ul.todo-block-list');
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const progressFill = container?.querySelector(
      '.todo-block-progress-fill'
    ) as HTMLDivElement | null;

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.textContent).toContain('Todos');
    expect(container?.textContent).toContain('0/0');
    expect(list).toBeInstanceOf(HTMLUListElement);
    expect(list?.hasAttribute('tabindex')).toBe(false);
    expect(list?.querySelectorAll('li')).toHaveLength(0);
    expect(progressFill?.style.width).toBe('0%');
  });

  it('keeps the expanded panel mounted when an empty native snapshot falls back to message todos', async () => {
    const todos: NormalizedTodo[] = [
      {
        id: 'task-1',
        content: 'Keep the replay panel visible',
        status: 'in_progress',
        priority: 'high',
      },
    ];
    const messages: MessageEntry[] = [
      fixture<MessageEntry>({
        info: {
          id: 'assistant-1',
          sessionID: 'session-1',
          role: 'assistant',
          time: { created: 1 },
        },
        parts: [
          {
            id: 'todo-part',
            messageID: 'assistant-1',
            sessionID: 'session-1',
            type: 'tool',
            tool: 'todowrite',
            callID: 'todo-call',
            state: {
              status: 'completed',
              input: { todos },
              output: '',
              title: 'Todos',
              metadata: {},
              time: { start: 1, end: 2 },
            },
          },
        ],
      }),
    ];
    setState(storePath('activeSessionId', 'session-1'));
    flushSolid();
    setState(storePath('todos', todos));
    flushSolid();
    cleanup = render(
      () => (
        <Show when={state.todos.length > 0}>
          <TodoList />
        </Show>
      ),
      container!
    );
    flushSolid();
    const panel = container!.querySelector('.todo-block');
    const list = container!.querySelector('.todo-block-list');
    expect(list).not.toBeNull();
    const operations = createTodoSyncOperations({ loadSessionTodos: async () => [] });
    await operations.syncTodosForSession('session-1', messages);
    flushSolid();
    await operations.syncTodosForSession('session-1', messages);
    flushSolid();
    expect(container!.querySelector('.todo-block')).toBe(panel);
    expect(container!.querySelector('.todo-block-list')).toBe(list);
    expect(container!.querySelector('.todo-block-header')?.getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  it('makes an overflowing todo list keyboard-scrollable', async () => {
    vi.spyOn(HTMLUListElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    vi.spyOn(HTMLUListElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Working task', status: 'in_progress', priority: 'high' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('ul.todo-block-list')?.getAttribute('tabindex')).toBe('0');
  });

  it('renders pending, in-progress, completed, and cancelled todos and toggles collapse', () => {
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Pending task', status: 'pending', priority: 'low' },
        {
          id: 'todo-2',
          content: 'Working task',
          status: 'in_progress',
          priority: 'medium',
        },
        { id: 'todo-3', content: 'Done task', status: 'completed', priority: 'high' },
        { id: 'todo-4', content: 'Cancelled task', status: 'cancelled', priority: 'low' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const toggle = container?.querySelector('button.todo-block-header') as HTMLButtonElement | null;
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.textContent).toContain('2/4');

    let items = container?.querySelectorAll('li.todo-block-item');
    expect(items).toHaveLength(4);
    expect(container?.querySelector('.status-pending .todo-block-item-text')?.textContent).toBe(
      'Pending task'
    );
    expect(container?.querySelector('.status-in_progress .todo-block-item-text')?.textContent).toBe(
      'Working task'
    );
    expect(container?.querySelector('.status-completed .todo-block-item-text')?.textContent).toBe(
      'Done task'
    );
    expect(container?.querySelector('.status-cancelled .todo-block-item-text')?.textContent).toBe(
      'Cancelled task'
    );

    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('ul.todo-block-list')).toBeNull();
    expect(container?.querySelector('.todo-block-active')?.textContent).toBe('Working task');
    expect(container?.querySelectorAll('.todo-block-active-dot')).toHaveLength(1);

    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelector('.todo-block-active')).toBeNull();
    items = container?.querySelectorAll('li.todo-block-item');
    expect(items).toHaveLength(4);
  });

  it('remembers a manual collapse for active todos until the list is expanded', async () => {
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Working task', status: 'in_progress', priority: 'high' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    let toggle = container?.querySelector('button.todo-block-header') as HTMLButtonElement;
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    expect(readStored(STORAGE_KEYS.todoListCollapsed)).toBe(true);

    cleanup();
    flushSolid();
    cleanup = undefined;
    container?.replaceChildren();
    flushSolid();
    cleanup = render(() => TodoList(), container!);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    toggle = container?.querySelector('button.todo-block-header') as HTMLButtonElement;

    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    setState(
      storePath('todos', (todos) => [
        ...todos,
        { id: 'todo-2', content: 'Next task', status: 'pending', priority: 'medium' },
      ])
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(readStored(STORAGE_KEYS.todoListCollapsed)).toBeNull();

    cleanup();
    flushSolid();
    cleanup = undefined;
    container?.replaceChildren();
    flushSolid();
    cleanup = render(() => TodoList(), container!);
    flushSolid();

    expect(container?.querySelector('.todo-block-header')?.getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  it('keeps resolved todos visible on the next prompt and expands for new work', async () => {
    setState(
      storePath('messages', [
        {
          info: userMessage('user-current'),
          parts: [],
        },
      ])
    );
    flushSolid();
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Working task', status: 'in_progress', priority: 'high' },
        { id: 'todo-2', content: 'Cancelled task', status: 'cancelled', priority: 'low' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();

    expect(container?.querySelector('.todo-block')).not.toBeNull();

    setState(
      storePath('messages', (messages) => [
        ...messages,
        {
          info: userMessage('user-while-unfinished'),
          parts: [],
        },
      ])
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.todo-block')).not.toBeNull();
    expect(container?.textContent).toContain('Working task');

    setState(storePath('todos', 0, 'status', 'completed'));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.todo-block')).not.toBeNull();
    expect(container?.textContent).toContain('2/2');

    setState(
      storePath('messages', (messages) => [
        ...messages,
        {
          info: userMessage('user-next'),
          parts: [],
        },
      ])
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.todo-block')).not.toBeNull();
    expect(container?.querySelector('.todo-block-header')?.getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(container?.textContent).toContain('2/2');

    setState(
      storePath('todos', (todos) => [
        ...todos,
        { id: 'todo-3', content: 'New task', status: 'pending', priority: 'medium' },
      ])
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.todo-block')).not.toBeNull();
    expect(container?.textContent).toContain('New task');
  });

  it('shows a dot per running todo and rotates their collapsed labels every five seconds', async () => {
    vi.useFakeTimers();
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'First running task', status: 'in_progress', priority: 'high' },
        { id: 'todo-2', content: 'Second running task', status: 'in_progress', priority: 'medium' },
        { id: 'todo-3', content: 'Later task', status: 'pending', priority: 'low' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const toggle = container?.querySelector('button.todo-block-header') as HTMLButtonElement;
    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    const dots = container?.querySelectorAll('.todo-block-active-dot');
    expect(dots).toHaveLength(2);
    expect(dots?.item(0).classList).toContain('is-current');
    expect(dots?.item(1).classList).not.toContain('is-current');
    expect(container?.querySelector('.todo-block-active-text')?.textContent).toBe(
      'First running task'
    );

    await vi.advanceTimersByTimeAsync(5_000);
    flushSolid();
    expect(dots?.item(0).classList).not.toContain('is-current');
    expect(dots?.item(1).classList).toContain('is-current');
    expect(container?.querySelector('.todo-block-active-text')?.textContent).toBe(
      'Second running task'
    );

    await vi.advanceTimersByTimeAsync(5_000);
    flushSolid();
    expect(dots?.item(0).classList).toContain('is-current');
    expect(dots?.item(1).classList).not.toContain('is-current');
    expect(container?.querySelector('.todo-block-active-text')?.textContent).toBe(
      'First running task'
    );
  });

  it.each(['pending', 'in_progress', 'completed', 'cancelled'])(
    'shows a styled tooltip only for truncated %s todo rows',
    async (status) => {
      vi.useFakeTimers();
      setState(
        storePath('todos', [
          { id: 'todo-1', content: 'Task details', status, priority: 'high' },
          { id: 'todo-2', content: 'Next task', status: 'pending', priority: 'low' },
        ])
      );
      flushSolid();
      cleanup = render(() => TodoList(), container!);
      flushSolid();

      const row = container!.querySelector('[data-todo-id="todo-1"]')!;
      const text = row.querySelector('.todo-block-item-text')!;
      Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 100 });
      Object.defineProperty(text, 'clientWidth', { configurable: true, value: 100 });

      row.dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
      await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      row.dispatchEvent(new MouseEvent('mouseleave'));
      flushSolid();

      Object.defineProperty(text, 'clientWidth', { configurable: true, value: 50 });
      row.dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
      await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY - 1);
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      flushSolid();

      const tooltip = document.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toBe('Task details');
      expect(tooltip?.classList.contains('themed-tooltip')).toBe(true);
      expect(row.getAttribute('title')).toBeNull();
      expect(text.getAttribute('title')).toBeNull();
      expect(row.getAttribute('aria-describedby')).toBe(tooltip?.id);

      row.dispatchEvent(new MouseEvent('mouseleave'));
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      Object.defineProperty(text, 'clientWidth', { configurable: true, value: 150 });
      row.dispatchEvent(new MouseEvent('mouseenter'));
      flushSolid();
      await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
      flushSolid();
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    }
  );

  it('shows a styled tooltip only when the collapsed todo text is truncated', async () => {
    vi.useFakeTimers();
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Working task', status: 'in_progress', priority: 'high' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();
    container
      ?.querySelector('button.todo-block-header')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();

    const active = container?.querySelector('.todo-block-active');
    const text = container?.querySelector('.todo-block-active-text');
    Object.defineProperty(text, 'scrollWidth', { configurable: true, value: 100 });
    Object.defineProperty(text, 'clientWidth', { configurable: true, value: 100 });

    active?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(active?.getAttribute('title')).toBeNull();
    active?.dispatchEvent(new MouseEvent('mouseleave'));
    flushSolid();

    Object.defineProperty(text, 'clientWidth', { configurable: true, value: 50 });
    active?.dispatchEvent(new MouseEvent('mouseenter'));
    flushSolid();
    await vi.advanceTimersByTimeAsync(DEFAULT_TOOLTIP_DELAY);
    flushSolid();

    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Working task');
    expect(active?.getAttribute('title')).toBeNull();

    container?.querySelector<HTMLButtonElement>('.todo-block-header')?.click();
    flushSolid();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('scrolls to the active todo when it changes', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Done task', status: 'completed', priority: 'low' },
        { id: 'todo-2', content: 'Working task', status: 'in_progress', priority: 'high' },
        { id: 'todo-3', content: 'Later task', status: 'pending', priority: 'medium' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const activeItem = container!.querySelector('[data-todo-id="todo-2"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts).toContain(activeItem);

    scrollIntoView.mockClear();
    setState(storePath('todos', 1, 'status', 'completed'));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    const nextActiveItem = container!.querySelector('[data-todo-id="todo-3"]');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scrollIntoView.mock.contexts).toContain(nextActiveItem);
  });

  it('starts collapsed when all todos are completed and expands when a new todo arrives', async () => {
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Done task 1', status: 'completed', priority: 'low' },
        { id: 'todo-2', content: 'Done task 2', status: 'completed', priority: 'medium' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();

    const toggle = container?.querySelector('button.todo-block-header');
    const progressFill = container?.querySelector('.todo-block-progress-fill');

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('ul.todo-block-list')).toBeNull();
    expect(progressFill?.className).toContain('is-complete');
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    expect((progressFill as HTMLDivElement | null)?.style.width).toBe('100%');

    setState(
      storePath('todos', (todos) => [
        ...todos,
        { id: 'todo-3', content: 'New task', status: 'pending', priority: 'high' },
      ])
    );
    flushSolid();

    await Promise.resolve();
    flushSolid();

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('li.todo-block-item')).toHaveLength(3);
    expect(container?.textContent).toContain('2/3');
  });

  it('collapses automatically when all todos become completed', async () => {
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'First task', status: 'in_progress', priority: 'high' },
        { id: 'todo-2', content: 'Second task', status: 'pending', priority: 'medium' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const toggle = container?.querySelector('button.todo-block-header') as HTMLButtonElement | null;
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    setState(storePath('todos', 0, 'status', 'completed'));
    flushSolid();
    await Promise.resolve();
    flushSolid();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    setState(storePath('todos', 1, 'status', 'completed'));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('ul.todo-block-list')).toBeNull();
    expect(readStored(STORAGE_KEYS.todoListCollapsed)).toBeNull();

    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses completed todos for a new prompt and expands when a new todo arrives', async () => {
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Done task', status: 'completed', priority: 'medium' },
      ])
    );
    flushSolid();

    cleanup = render(() => TodoList(), container!);
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const toggle = container?.querySelector('button.todo-block-header') as HTMLButtonElement | null;
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    setState(storePath('messages', [{ info: userMessage('user-1'), parts: [] }]));
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.todo-block')).not.toBeNull();
    expect(container?.querySelector('.todo-block-header')?.getAttribute('aria-expanded')).toBe(
      'false'
    );

    setState(
      storePath('todos', (todos) => [
        ...todos,
        { id: 'todo-2', content: 'New task', status: 'pending', priority: 'high' },
      ])
    );
    flushSolid();
    await Promise.resolve();
    flushSolid();

    expect(container?.querySelector('.todo-block-header')?.getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(container?.querySelectorAll('li.todo-block-item')).toHaveLength(2);
  });

  it('limits the open list to five rows and auto-collapses when chat room is scarce', async () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe() {}
      disconnect() {}
    }
    // SAFETY: The fixture provides the unknown fields read by this statement.
    globalThis.ResizeObserver = fixture<typeof ResizeObserver>(TestResizeObserver);
    setState(
      storePath('todos', [
        { id: 'todo-1', content: 'Working task', status: 'in_progress', priority: 'high' },
        { id: 'todo-2', content: 'Later task', status: 'pending', priority: 'medium' },
      ])
    );
    flushSolid();
    container!.innerHTML = `
      <div class="chat-main-column-shell">
        <div class="interactive-list"></div>
        <div class="todo-mount"></div>
      </div>
    `;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const chatShell = container!.querySelector('.chat-main-column-shell') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const chatView = container!.querySelector('.interactive-list') as HTMLDivElement;
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const mount = container!.querySelector('.todo-mount') as HTMLDivElement;
    Object.defineProperty(chatShell, 'clientHeight', { configurable: true, value: 1_000 });
    Object.defineProperty(chatView, 'clientHeight', { configurable: true, value: 500 });

    cleanup = render(() => TodoList(), mount);
    flushSolid();

    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    const toggle = mount.querySelector('button.todo-block-header') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    expect((mount.querySelector('.todo-block-list') as HTMLUListElement).style.maxHeight).toBe(
      '117px'
    );

    Object.defineProperty(chatShell, 'clientHeight', { configurable: true, value: 320 });
    Object.defineProperty(chatView, 'clientHeight', { configurable: true, value: 100 });
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    resizeCallback?.([], {} as ResizeObserver);
    await Promise.resolve();
    flushSolid();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSolid();
    // SAFETY: The rendered DOM fixture provides the browser shape used by this statement.
    resizeCallback?.([], {} as ResizeObserver);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});

function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: 'session-1',
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-5.4' },
  };
}
