import {
  createEffect,
  createRoot,
  createSignal,
  flush,
  getOwner,
  onCleanup,
  createStore,
} from 'solid-js';
import { storePath } from '@solidjs/signals';
import { render } from '@solidjs/web';
import { describe, expect, it, vi } from 'vitest';

describe('Solid test runtime', () => {
  it('preserves the runtime across application module resets', async () => {
    for (let reset = 0; reset < 2; reset++) {
      vi.resetModules();
      const solid = await import('solid-js');
      const store = await import('solid-js');
      const web = await import('@solidjs/web');

      expect(solid.createRoot).toBe(createRoot);
      expect(solid.createSignal).toBe(createSignal);
      expect(store.createStore).toBe(createStore);
      expect(web.render).toBe(render);

      const cleanup = vi.fn();
      const values: number[] = [];
      const [value, setValue] = createSignal(0);
      const dispose = createRoot((disposeRoot) => {
        expect(solid.getOwner()).toBe(getOwner());
        solid.onCleanup(cleanup);
        solid.createEffect(value, (current) => {
          values.push(current);
        });
        return disposeRoot;
      });

      try {
        flush();
        expect(values).toEqual([0]);
        setValue(1);
        flush();
        expect(values).toEqual([0, 1]);
      } finally {
        dispose();
      }
      expect(cleanup).toHaveBeenCalledOnce();
      setValue(2);
      flush();
      expect(values).toEqual([0, 1]);
    }
  });

  it('shares ownership between DOM rendering, stores, and reset imports', async () => {
    vi.resetModules();
    const solid = await import('solid-js');
    const store = await import('solid-js');
    const web = await import('@solidjs/web');
    const [state, setState] = store.createStore({ text: 'before' });
    const container = document.createElement('div');
    const cleanup = vi.fn();
    const dispose = web.render(() => {
      expect(solid.getOwner()).toBe(getOwner());
      onCleanup(cleanup);
      const element = document.createElement('span');
      createEffect(
        () => state.text,
        (text) => {
          element.textContent = text;
        }
      );
      return element;
    }, container);

    try {
      expect(container.textContent).toBe('before');
      setState(storePath('text', 'after'));
      flush();
      expect(container.textContent).toBe('after');
    } finally {
      dispose();
    }
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
