import { flush as flushSolid } from 'solid-js';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from '../test-fixtures';
import { isSubagentCardVisible, observeSubagentCard } from './subagent-visibility';

afterEach(() => vi.unstubAllGlobals());

it('tracks clipped headers and retains visibility until every visible copy unmounts', () => {
  let notify: IntersectionObserverCallback | undefined;
  const observe = vi.fn();
  const unobserve = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        notify = callback;
      }
      observe = observe;
      unobserve = unobserve;
      disconnect = disconnect;
    }
  );
  const first = document.createElement('button');
  const second = document.createElement('button');
  const removeFirst = observeSubagentCard(first, 'child');
  flushSolid();
  const removeSecond = observeSubagentCard(second, 'child');
  flushSolid();
  const intersect = (target: Element, intersectionRatio: number) =>
    notify?.(
      [
        fixture<IntersectionObserverEntry>({
          target,
          isIntersecting: intersectionRatio > 0,
          intersectionRatio,
        }),
      ],
      fixture<IntersectionObserver>({})
    );
  try {
    expect(observe).toHaveBeenCalledTimes(2);
    expect(isSubagentCardVisible('child')).toBe(false);
    intersect(first, 0.2);
    flushSolid();
    expect(isSubagentCardVisible('child')).toBe(false);
    intersect(first, 1);
    flushSolid();
    intersect(second, 1);
    flushSolid();
    expect(isSubagentCardVisible('child')).toBe(true);
    removeFirst();
    flushSolid();
    expect(isSubagentCardVisible('child')).toBe(true);
    intersect(second, 0);
    flushSolid();
    expect(isSubagentCardVisible('child')).toBe(false);
    intersect(second, 1);
    flushSolid();
    removeSecond();
    flushSolid();
    expect(isSubagentCardVisible('child')).toBe(false);
    expect(disconnect).toHaveBeenCalledOnce();
    intersect(second, 1);
    flushSolid();
    expect(isSubagentCardVisible('child')).toBe(false);
  } finally {
    removeFirst();
    flushSolid();
    removeSecond();
    flushSolid();
  }
});

it('keeps the waiting status eligible when viewport observation is unavailable', () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const remove = observeSubagentCard(document.createElement('button'), 'child');
  flushSolid();
  expect(isSubagentCardVisible('child')).toBe(false);
  remove();
  flushSolid();
});
