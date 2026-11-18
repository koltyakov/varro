import { flush as flushSolid } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import { resetToolCallExpansionState } from '../../lib/tool-call-expansion-state';
import type { FileDiff } from '../../types';
import { navArrowRightIcon } from '../../lib/ui-icons';
import { toCssUrl } from '../UiIcon';
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
  flushSolid();
});

afterEach(() => {
  cleanup?.();
  flushSolid();
  cleanup = undefined;
  container.remove();
  flushSolid();
  resetToolCallExpansionState();
  flushSolid();
});

describe('DiffSummary', () => {
  it('keeps an expanded summary open when its virtualized row remounts', () => {
    cleanup = render(() => <DiffSummary diffs={diffs} stateKey="session-1:message-1" />, container);
    flushSolid();

    const icon = container.querySelector<HTMLElement>('.diff-summary-btn .ui-icon');
    expect(icon).toBeInstanceOf(HTMLSpanElement);
    expect(icon?.style.getPropertyValue('--ui-icon-width')).toBe('10px');
    expect(icon?.style.getPropertyValue('--ui-icon-mask')).toBe(toCssUrl(navArrowRightIcon));
    container.querySelector<HTMLButtonElement>('.diff-summary-btn')?.click();
    flushSolid();
    expect(container.querySelector('.diff-summary-content')?.textContent).toContain('Diff details');

    cleanup();
    flushSolid();
    cleanup = undefined;
    container.innerHTML = '';
    cleanup = render(() => <DiffSummary diffs={diffs} stateKey="session-1:message-1" />, container);
    flushSolid();

    expect(container.querySelector('.diff-summary-btn')?.getAttribute('aria-expanded')).toBe(
      'true'
    );
    expect(container.querySelector('.diff-summary-content')?.textContent).toContain('Diff details');
  });

  it('does not share expansion between messages', () => {
    cleanup = render(() => <DiffSummary diffs={diffs} stateKey="session-1:message-1" />, container);
    flushSolid();
    container.querySelector<HTMLButtonElement>('.diff-summary-btn')?.click();
    flushSolid();

    cleanup();
    flushSolid();
    cleanup = undefined;
    container.innerHTML = '';
    cleanup = render(() => <DiffSummary diffs={diffs} stateKey="session-1:message-2" />, container);
    flushSolid();

    expect(container.querySelector('.diff-summary-btn')?.getAttribute('aria-expanded')).toBe(
      'false'
    );
    expect(container.querySelector('.diff-summary-content')).toBeNull();
  });
});
