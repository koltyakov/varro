import { flush as flushSolid, createSignal } from 'solid-js';
/* oxlint-disable anti-slop/no-module-mocking -- The bridge is substituted to test explicit user opt-in and failure presentation. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { DecisionProviderStatus } from '../../shared/protocol';
import { NativeDecisionProviderSection } from './NativeDecisionProviderSection';

const update = vi.hoisted(() => vi.fn());
vi.mock('../lib/client', () => ({ client: { varro: { decisionProviders: { update } } } }));
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  flushSolid();
  document.body.replaceChildren();
  flushSolid();
  vi.clearAllMocks();
  flushSolid();
});
const initial: NonNullable<DecisionProviderStatus['native']> = {
  supported: true,
  model: null,
  models: [{ providerID: 'typesafe-ai', modelID: 'jev', name: 'Jev' }],
};
function mount(initialStatus = initial) {
  const container = document.createElement('div');
  document.body.append(container);
  cleanup = render(() => {
    const [status, setStatus] = createSignal(initialStatus);
    return (
      <NativeDecisionProviderSection
        status={status()}
        onStatusChange={(next) => {
          if (next.native) setStatus(next.native);
        }}
      />
    );
  }, container);
  const select = container.querySelector('select');
  if (!select) throw new Error('Missing native decision selector');
  return { container, select };
}

describe('native decision model selection', () => {
  it('stays off until explicitly selected and can be turned off again', async () => {
    const { select } = mount();
    flushSolid();
    expect(select.value).toBe('');
    expect(update).not.toHaveBeenCalled();
    update.mockResolvedValueOnce({
      native: { ...initial, model: { providerID: 'typesafe-ai', modelID: 'jev' } },
    });
    select.value = 'typesafe-ai/jev';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSolid();
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    flushSolid();
    expect(update).toHaveBeenCalledWith({ action: 'native', model: 'typesafe-ai/jev' });
    expect(select.value).toBe('typesafe-ai/jev');
    update.mockResolvedValueOnce({ native: initial });
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSolid();
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    flushSolid();
    expect(update).toHaveBeenLastCalledWith({ action: 'native', model: '' });
    expect(select.value).toBe('');
  });
  it('allows turning off a saved model when the server no longer advertises it', async () => {
    const { container, select } = mount({
      supported: false,
      models: [],
      model: {
        providerID: 'typesafe-ai',
        modelID: 'jev',
      },
    });
    flushSolid();
    expect(select.value).toBe('typesafe-ai/jev');
    expect(container.textContent).toContain('(unavailable)');
    update.mockResolvedValueOnce({ native: { supported: false, models: [], model: null } });
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSolid();
    await vi.waitFor(() => expect(select.disabled).toBe(false));
    flushSolid();
    expect(update).toHaveBeenCalledWith({ action: 'native', model: '' });
    expect(select.value).toBe('');
  });
  it('keeps the confirmed selection and shows a failed setting update', async () => {
    update.mockRejectedValueOnce(new Error('Selection not saved'));
    const { container, select } = mount();
    flushSolid();
    select.value = 'typesafe-ai/jev';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    flushSolid();
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Selection not saved'
      )
    );
    flushSolid();
    expect(select.value).toBe('');
    expect(select.disabled).toBe(false);
  });
});
