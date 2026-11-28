import { flush as flushSolid, createSignal } from 'solid-js';
/* oxlint-disable anti-slop/no-module-mocking -- The bridge is substituted to hold an update in flight. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { DecisionProviderStatus } from '../../shared/protocol';
import { DecisionProviderSection, type JevStatus } from './DecisionProviderSection';

const update = vi.hoisted(() => vi.fn());
vi.mock('../lib/client', () => ({ client: { varro: { decisionProviders: { update } } } }));

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  flushSolid();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

const connected: JevStatus = {
  connected: true,
  credentialSource: 'secret',
  model: 'jev',
  autoApprove: false,
};

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  cleanup = render(() => {
    const [status, setStatus] = createSignal(connected);
    return (
      <DecisionProviderSection status={status()} onStatusChange={(next) => setStatus(next.jev)} />
    );
  }, container);
  flushSolid();
  const checkbox = container.querySelector<HTMLInputElement>('.decision-provider-checkbox');
  if (!checkbox) throw new Error('Missing auto-approve checkbox');
  return { container, checkbox };
}

function deferredUpdate() {
  let resolve!: (value: DecisionProviderStatus) => void;
  let reject!: (reason: Error) => void;
  update.mockReturnValueOnce(
    new Promise<DecisionProviderStatus>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    })
  );
  return { resolve, reject };
}

describe('Jev auto-approve', () => {
  it('keeps the clicked state while the update is pending', async () => {
    const pending = deferredUpdate();
    const { checkbox } = mount();

    checkbox.click();
    flushSolid();
    expect(update).toHaveBeenCalledWith({ action: 'update', autoApprove: true });
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.checked).toBe(true);

    pending.resolve({ jev: { ...connected, autoApprove: true } });
    await vi.waitFor(() => {
      flushSolid();
      expect(checkbox.disabled).toBe(false);
    });
    expect(checkbox.checked).toBe(true);
  });

  it('returns to the confirmed state when the update fails', async () => {
    const pending = deferredUpdate();
    const { container, checkbox } = mount();

    checkbox.click();
    flushSolid();
    expect(checkbox.checked).toBe(true);

    pending.reject(new Error('Jev is unavailable'));
    await vi.waitFor(() => {
      flushSolid();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('Jev is unavailable');
    });
    expect(checkbox.checked).toBe(false);
  });
});
