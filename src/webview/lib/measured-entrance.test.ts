import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareMeasuredEntrance } from './measured-entrance';

describe('prepareMeasuredEntrance', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('measures the target height and releases temporary layout constraints afterward', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {
          disconnect();
        }
      }
    );
    const element = document.createElement('div');
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 84 });
    document.body.appendChild(element);
    const onFinish = vi.fn();

    const dispose = prepareMeasuredEntrance(element, {
      animationName: 'test-entrance',
      heightProperty: '--test-entrance-height',
      onFinish,
    });
    await Promise.resolve();

    expect(element.classList).toContain('measured-entrance-active');
    expect(element.style.getPropertyValue('--test-entrance-height')).toBe('84px');

    const event = new Event('animationend') as AnimationEvent;
    Object.defineProperty(event, 'animationName', { value: 'test-entrance' });
    element.dispatchEvent(event);

    expect(element.classList).not.toContain('measured-entrance-active');
    expect(element.style.getPropertyValue('--test-entrance-height')).toBe('');
    expect(disconnect).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledOnce();

    dispose();
    element.dispatchEvent(event);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it('can be disposed idempotently before deferred setup', async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {
          observe();
        }
        disconnect() {
          disconnect();
        }
      }
    );
    const element = document.createElement('div');
    document.body.appendChild(element);
    const onFinish = vi.fn();

    const dispose = prepareMeasuredEntrance(element, {
      animationName: 'test-entrance',
      heightProperty: '--test-entrance-height',
      onFinish,
    });
    dispose();
    dispose();
    await Promise.resolve();

    expect(observe).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(element.classList).not.toContain('measured-entrance-active');
    expect(element.style.getPropertyValue('--test-entrance-height')).toBe('');
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('cleans up setup exactly once when manually disposed', async () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {
          disconnect();
        }
      }
    );
    const element = document.createElement('div');
    document.body.appendChild(element);
    const removeEventListener = vi.spyOn(element, 'removeEventListener');
    const onFinish = vi.fn();
    const dispose = prepareMeasuredEntrance(element, {
      animationName: 'test-entrance',
      heightProperty: '--test-entrance-height',
      onFinish,
    });
    await Promise.resolve();

    dispose();
    dispose();
    const event = new Event('animationcancel') as AnimationEvent;
    Object.defineProperty(event, 'animationName', { value: 'test-entrance' });
    element.dispatchEvent(event);

    expect(disconnect).toHaveBeenCalledOnce();
    expect(removeEventListener).toHaveBeenCalledTimes(2);
    expect(element.classList).not.toContain('measured-entrance-active');
    expect(element.style.getPropertyValue('--test-entrance-height')).toBe('');
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('does not start a nested entrance when its row is already entering', async () => {
    const row = document.createElement('div');
    row.className = 'interactive-item-entering';
    const element = document.createElement('div');
    row.appendChild(element);
    document.body.appendChild(row);

    prepareMeasuredEntrance(element, {
      animationName: 'test-entrance',
      heightProperty: '--test-entrance-height',
      skipWithin: '.interactive-item-entering',
    });
    await Promise.resolve();

    expect(element.classList).not.toContain('measured-entrance-active');
  });

  it('starts at zero height so an initially empty row can grow during the animation', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      }
    );
    const element = document.createElement('div');
    document.body.appendChild(element);

    prepareMeasuredEntrance(element, {
      animationName: 'test-entrance',
      heightProperty: '--test-entrance-height',
    });
    await Promise.resolve();

    expect(element.style.getPropertyValue('--test-entrance-height')).toBe('0px');
    expect(element.classList).toContain('measured-entrance-active');
  });
});
