import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { resetToolCallExpansionState } from '../../lib/tool-call-expansion-state';
import type { FileDiff } from '../../types';
import { DiffSummary } from './DiffSummary';

/* oxlint-disable anti-slop/no-module-mocking -- These tests exercise DiffSummary's DiffView module integration. */
vi.mock('../DiffView', () => ({
  DiffView: () => <div class="diff-view-mock">Diff details</div>,
}));

const diffs: FileDiff[] = [
  {
    file: 'src/app.ts',
    before: 'const value = 1;',
    after: 'const value = 2;',
    additions: 1,
    deletions: 1,
  },
];

let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  resetToolCallExpansionState();
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  resetToolCallExpansionState();
});

describe('DiffSummary', () => {
  it('keeps an expanded summary open when its virtualized row remounts', () => {
    cleanup = render(() => <DiffSummary diffs={diffs} stateKey="session-1:message-1" />, container);

    container.querySelector<HTMLButtonElement>('.diff-summary-btn')?.click();
    expect(container.querySelector('.diff-summary-content')?.textContent).toContain('Diff details');

    cleanup();
    cleanup = undefined;
    container.innerHTML = '';
    cleanup = render(() => <DiffSummary diffs={diffs} stateKey="session-1:message-1" />, container);

    expect(container.querySelector('.diff-summary-btn')?.getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(container.querySelector('.diff-summary-content')?.textContent).toContain('Diff details');
  });

  it('does not share expansion between messages', () => {
    cleanup = render(() => <DiffSummary diffs={diffs} stateKey="session-1:message-1" />, container);
    container.querySelector<HTMLButtonElement>('.diff-summary-btn')?.click();

    cleanup();
    cleanup = undefined;
    container.innerHTML = '';
    cleanup = render(() => <DiffSummary diffs={diffs} stateKey="session-1:message-2" />, container);

    expect(container.querySelector('.diff-summary-btn')?.getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(container.querySelector('.diff-summary-content')).toBeNull();
  });
});
