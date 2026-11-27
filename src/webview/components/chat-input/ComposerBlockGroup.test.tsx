import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSignal, flush } from 'solid-js';
import { render } from '@solidjs/web';
import {
  ComposerBlockGroup,
  type ComposerBlock,
  type ComposerBlockKind,
  type ComposerBlockStatus,
} from './ComposerBlockGroup';

let container: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
});

function mount(initial: Partial<Record<ComposerBlockKind, number | null>>) {
  const signals = {
    queue: createSignal(initial.queue ?? null),
    goal: createSignal(initial.goal ?? null),
    todos: createSignal(initial.todos ?? null),
    background: createSignal(initial.background ?? null),
    files: createSignal(initial.files ?? null),
  };
  const [goalStatus, setGoalStatus] = createSignal<ComposerBlockStatus>('running');
  const kinds: ComposerBlockKind[] = ['queue', 'goal', 'todos', 'background', 'files'];
  const blocks: ComposerBlock[] = kinds.map((kind) => ({
    kind,
    count: () => signals[kind][0](),
    countLabel:
      kind === 'todos' ? () => `1/${signals.todos[0]()}` : kind === 'goal' ? () => null : undefined,
    status: kind === 'goal' ? goalStatus : undefined,
    render: () => <div data-testid={kind}>{kind}</div>,
  }));
  dispose = render(() => <ComposerBlockGroup blocks={blocks} />, container);
  flush();
  const set = (kind: ComposerBlockKind, value: number | null) => {
    signals[kind][1](value);
    flush();
  };
  const setGoal = (status: ComposerBlockStatus) => {
    setGoalStatus(status);
    flush();
  };
  return { set, setGoal };
}

const tabs = () =>
  Array.from(
    container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    (tab) => tab.textContent
  );
const selectedTab = () =>
  container.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-kind');
const visibleSlots = () =>
  Array.from(
    container.querySelectorAll<HTMLElement>('.composer-block-slot:not([hidden])'),
    (slot) => slot.dataset.kind
  );

describe('ComposerBlockGroup', () => {
  it('hides the group without content and shows up to two blocks without tabs', () => {
    const { set } = mount({});
    expect(container.querySelector('.composer-block-group')?.hasAttribute('hidden')).toBe(true);

    set('todos', 3);
    expect(container.querySelector('.composer-block-group')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelector('[role="tablist"]')).toBeNull();

    set('files', 2);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(visibleSlots()).toEqual(['queue', 'goal', 'todos', 'background', 'files']);

    set('goal', 1);
    expect(tabs()).toEqual(['Goal', 'Todos 1/3', 'Files 2']);
    expect(visibleSlots()).toEqual(['goal']);
  });

  it('lists present blocks in order with counters and shows only the active one', () => {
    mount({ files: 4, todos: 5, goal: 1 });
    expect(tabs()).toEqual(['Goal', 'Todos 1/5', 'Files 4']);
    expect(selectedTab()).toBe('goal');
    expect(visibleSlots()).toEqual(['goal']);

    container.querySelector<HTMLButtonElement>('[data-kind="files"][role="tab"]')!.click();
    flush();
    expect(selectedTab()).toBe('files');
    expect(visibleSlots()).toEqual(['files']);
  });

  it('shows the goal status instead of a counter', () => {
    const { setGoal } = mount({ goal: 1, queue: 2, files: 1 });
    const goalTab = () => container.querySelector('[data-kind="goal"][role="tab"]')!;
    const status = () =>
      goalTab().querySelector('.composer-block-tab-status')?.getAttribute('aria-label');
    expect(goalTab().querySelector('.composer-block-tab-count')).toBeNull();
    expect(status()).toBe('running');
    setGoal('paused');
    expect(status()).toBe('paused');
    setGoal('achieved');
    expect(status()).toBe('achieved');
  });

  it('keeps the active block shown when its tab is selected again', () => {
    mount({ queue: 1, files: 2, todos: 3 });
    const queueTab = container.querySelector<HTMLButtonElement>('[data-kind="queue"][role="tab"]')!;
    queueTab.click();
    flush();
    expect(selectedTab()).toBe('queue');
    expect(visibleSlots()).toEqual(['queue']);
    expect(container.querySelector('.composer-block-panel')?.hasAttribute('hidden')).toBe(false);
  });

  it('falls back to the first tab when the selected block goes away', () => {
    const { set } = mount({ goal: 1, background: 2, files: 1 });
    container.querySelector<HTMLButtonElement>('[data-kind="background"][role="tab"]')!.click();
    flush();
    set('background', null);
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(visibleSlots()).toContain('goal');
  });

  it('switches to Queue when a message is queued', () => {
    const { set } = mount({ queue: 1, todos: 3, files: 1 });
    container.querySelector<HTMLButtonElement>('[data-kind="todos"][role="tab"]')!.click();
    flush();
    expect(selectedTab()).toBe('todos');

    set('queue', 2);
    expect(selectedTab()).toBe('queue');

    set('queue', 1);
    container.querySelector<HTMLButtonElement>('[data-kind="todos"][role="tab"]')!.click();
    flush();
    set('queue', null);
    set('queue', 1);
    expect(selectedTab()).toBe('queue');
  });
});
