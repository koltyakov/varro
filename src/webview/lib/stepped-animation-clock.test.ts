import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSteppedAnimationClock } from './stepped-animation-clock';

function dispatchAnimationEvent(target: Element, type: string, animationName: string) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'animationName', { value: animationName });
  target.dispatchEvent(event);
}

function steps() {
  const root = document.documentElement;
  return [root.getAttribute('data-shimmer-step'), root.getAttribute('data-ellipsis-step')];
}

let stopClock: (() => void) | undefined;

afterEach(() => {
  stopClock?.();
  stopClock = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('startSteppedAnimationClock', () => {
  it('publishes shimmer and ellipsis steps at their own boundaries', () => {
    vi.useFakeTimers();
    document.body.innerHTML =
      '<div class="interactive-item-container"><span class="shimmer-progress loading-verb">Working<span class="chat-animated-ellipsis"></span></span></div>';
    stopClock = startSteppedAnimationClock();
    expect(steps()).toEqual([null, null]);

    dispatchAnimationEvent(
      document.querySelector('.shimmer-progress')!,
      'animationstart',
      'chat-thinking-shimmer'
    );
    expect(steps()).toEqual(['0', '0']);

    vi.advanceTimersByTime(167);
    expect(steps()).toEqual(['1', '0']);
    vi.advanceTimersByTime(83);
    expect(steps()).toEqual(['1', '1']);
    vi.advanceTimersByTime(1750);
    expect(steps()).toEqual(['0', '0']);
    vi.advanceTimersByTime(2000 / 12);
    expect(steps()).toEqual(['1', '0']);
  });

  it('stops and clears the steps once no stepped indicator remains', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="shimmer-progress">Thinking</span>';
    stopClock = startSteppedAnimationClock();
    dispatchAnimationEvent(document.body, 'animationstart', 'chat-thinking-shimmer');
    expect(steps()).toEqual(['0', '0']);

    document.body.replaceChildren();
    vi.advanceTimersByTime(250);
    expect(steps()).toEqual([null, null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves independently timed and paused indicators to their CSS animations', () => {
    vi.useFakeTimers();
    document.body.innerHTML = [
      '<div class="chat-tool-invocation-part"><span class="shimmer-progress">Running</span></div>',
      '<div class="manage-models-attention"><span class="shimmer-progress">Manage</span></div>',
      '<div class="interactive-item-container interactive-item-off-core"><span class="shimmer-progress">Working<span class="chat-animated-ellipsis"></span></span></div>',
    ].join('');
    stopClock = startSteppedAnimationClock();

    dispatchAnimationEvent(document.body, 'animationstart', 'chat-thinking-shimmer');
    expect(steps()).toEqual([null, null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores unrelated animations and restarts from an iteration event', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="shimmer-progress">Thinking</span>';
    stopClock = startSteppedAnimationClock();

    dispatchAnimationEvent(document.body, 'animationstart', 'tool-activity-wave');
    expect(steps()).toEqual([null, null]);

    dispatchAnimationEvent(document.body, 'animationiteration', 'chat-thinking-shimmer');
    expect(steps()).toEqual(['0', '0']);
  });

  it('removes its listeners and steps when disposed', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<span class="shimmer-progress">Thinking</span>';
    const stop = startSteppedAnimationClock();
    dispatchAnimationEvent(document.body, 'animationstart', 'chat-thinking-shimmer');
    expect(steps()).toEqual(['0', '0']);

    stop();
    expect(steps()).toEqual([null, null]);
    expect(vi.getTimerCount()).toBe(0);
    dispatchAnimationEvent(document.body, 'animationstart', 'chat-thinking-shimmer');
    expect(steps()).toEqual([null, null]);
  });
});
