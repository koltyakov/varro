import { afterEach, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import { HostActions } from './HostActions';
import { registerHostExtension } from '../host/extensions';
import { error, setError } from '../lib/state';

let disposeView: (() => void) | undefined;
let disposeHost: (() => void) | undefined;
let container: HTMLDivElement;
afterEach(() => {
  disposeView?.();
  disposeHost?.();
  container?.remove();
  setError(null);
});

it('renders only the requested slot and supplies a stable session target', async () => {
  const run = vi.fn();
  const onComplete = vi.fn();
  disposeHost = registerHostExtension({
    apiVersion: 1,
    id: 'example.host',
    actions: [
      { id: 'example.inspect', label: 'Inspect issue', slot: 'session.actions', run },
      { id: 'example.create', label: 'Create issue', slot: 'chat.new', run },
    ],
  });
  container = document.createElement('div');
  document.body.append(container);
  disposeView = render(
    () => (
      <HostActions
        slot="session.actions"
        sessionId="session-1"
        directory="/repo"
        onComplete={onComplete}
      />
    ),
    container
  );
  expect(container.textContent).toBe('Inspect issue');
  container.querySelector('button')!.click();
  await Promise.resolve();
  expect(run).toHaveBeenCalledWith({ sessionId: 'session-1', directory: '/repo' });
  expect(onComplete).toHaveBeenCalledOnce();
});

it('reports failed actions and leaves the menu available for retry', async () => {
  const onComplete = vi.fn();
  disposeHost = registerHostExtension({
    apiVersion: 1,
    id: 'example.host',
    actions: [
      {
        id: 'example.inspect',
        label: 'Inspect issue',
        slot: 'session.actions',
        run: () => Promise.reject(new Error('Tracker offline')),
      },
    ],
  });
  container = document.createElement('div');
  document.body.append(container);
  disposeView = render(
    () => <HostActions slot="session.actions" onComplete={onComplete} />,
    container
  );
  container.querySelector('button')!.click();
  await Promise.resolve();
  await Promise.resolve();
  expect(error()).toContain('Tracker offline');
  expect(container.querySelector('button')!.disabled).toBe(false);
  expect(onComplete).not.toHaveBeenCalled();
});
