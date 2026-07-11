import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'solid-js/web';
import { TodoList } from './TodoList';
import { resetDefaultAppState, setState } from '../lib/state';
import type { UserMessage } from '../types';

let container: HTMLDivElement | null = null;
let cleanup: (() => void) | undefined;

describe('TodoList', () => {
  beforeEach(() => {
    resetDefaultAppState();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    container?.remove();
    container = null;
    resetDefaultAppState();
  });

  it('renders an empty todo list with accessible list semantics', () => {
    cleanup = render(() => TodoList(), container!);

    const toggle = container?.querySelector('button.todo-block-header');
    const list = container?.querySelector('ul.todo-block-list');
    const progressFill = container?.querySelector(
      '.todo-block-progress-fill'
    ) as HTMLDivElement | null;

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.textContent).toContain('Todos');
    expect(container?.textContent).toContain('0/0');
    expect(list).toBeInstanceOf(HTMLUListElement);
    expect(list?.querySelectorAll('li')).toHaveLength(0);
    expect(progressFill?.style.width).toBe('0%');
  });

  it('renders pending, in-progress, completed, and cancelled todos and toggles collapse', () => {
    setState('todos', [
      { id: 'todo-1', content: 'Pending task', status: 'pending', priority: 'low' },
      {
        id: 'todo-2',
        content: 'Working task',
        status: 'in_progress',
        priority: 'medium',
      },
      { id: 'todo-3', content: 'Done task', status: 'completed', priority: 'high' },
      { id: 'todo-4', content: 'Cancelled task', status: 'cancelled', priority: 'low' },
    ]);

    cleanup = render(() => TodoList(), container!);

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
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('ul.todo-block-list')).toBeNull();

    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    items = container?.querySelectorAll('li.todo-block-item');
    expect(items).toHaveLength(4);
  });

  it('starts collapsed when all todos are completed and expands when a new todo arrives', async () => {
    setState('todos', [
      { id: 'todo-1', content: 'Done task 1', status: 'completed', priority: 'low' },
      { id: 'todo-2', content: 'Done task 2', status: 'completed', priority: 'medium' },
    ]);

    cleanup = render(() => TodoList(), container!);

    const toggle = container?.querySelector('button.todo-block-header');
    const progressFill = container?.querySelector('.todo-block-progress-fill');

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('ul.todo-block-list')).toBeNull();
    expect(progressFill?.className).toContain('is-complete');
    expect((progressFill as HTMLDivElement | null)?.style.width).toBe('100%');

    setState('todos', (todos) => [
      ...todos,
      { id: 'todo-3', content: 'New task', status: 'pending', priority: 'high' },
    ]);

    await Promise.resolve();

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('li.todo-block-item')).toHaveLength(3);
    expect(container?.textContent).toContain('2/3');
  });

  it('collapses automatically when all todos become completed', async () => {
    setState('todos', [
      { id: 'todo-1', content: 'First task', status: 'in_progress', priority: 'high' },
      { id: 'todo-2', content: 'Second task', status: 'pending', priority: 'medium' },
    ]);

    cleanup = render(() => TodoList(), container!);

    const toggle = container?.querySelector('button.todo-block-header') as HTMLButtonElement | null;
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    setState('todos', 0, 'status', 'completed');
    await Promise.resolve();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    setState('todos', 1, 'status', 'completed');
    await Promise.resolve();

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('ul.todo-block-list')).toBeNull();

    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });

  it('collapses completed todos for a new prompt and expands when a new todo arrives', async () => {
    setState('todos', [
      { id: 'todo-1', content: 'Done task', status: 'completed', priority: 'medium' },
    ]);

    cleanup = render(() => TodoList(), container!);

    const toggle = container?.querySelector('button.todo-block-header') as HTMLButtonElement | null;
    toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    setState('messages', [{ info: userMessage('user-1'), parts: [] }]);
    await Promise.resolve();

    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container?.querySelector('ul.todo-block-list')).toBeNull();

    setState('todos', (todos) => [
      ...todos,
      { id: 'todo-2', content: 'New task', status: 'pending', priority: 'high' },
    ]);
    await Promise.resolve();

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container?.querySelectorAll('li.todo-block-item')).toHaveLength(2);
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
