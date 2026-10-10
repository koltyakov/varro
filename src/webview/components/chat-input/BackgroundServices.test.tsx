import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import type { BackgroundProcess } from '../../../shared/background-process';
import { client } from '../../lib/client';
import {
  backgroundProcessView,
  closeBackgroundProcessView,
} from '../../lib/background-process-view';
import { BackgroundServices } from './BackgroundServices';
import { sessionStore } from '../../lib/stores/session-store';
import { resetDefaultAppState } from '../../lib/state';

const service: BackgroundProcess = {
  id: 'server',
  status: 'running',
  service: true,
  command: 'python3 tools/serve.py 18765',
  cwd: '/repo',
  time: { started: 1 },
};
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;
async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
beforeEach(() => {
  resetDefaultAppState();
  container = document.createElement('div');
  document.body.append(container);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(client.session, 'backgroundProcesses').mockResolvedValue([service]);
  vi.spyOn(client.session, 'backgroundProcessOutput').mockResolvedValue({
    output: '',
    cursor: 0,
    size: 0,
    truncated: false,
  });
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  closeBackgroundProcessView();
  vi.restoreAllMocks();
});

describe('BackgroundServices', () => {
  it('keeps the same command row mounted through send and steering status changes', async () => {
    sessionStore.setSessionStatusEntry('ses_one', { type: 'idle', backgroundServices: 1 });
    cleanup = render(
      () => (
        <BackgroundServices
          sessionID="ses_one"
          count={sessionStore.getBackgroundServiceCount('ses_one')}
        />
      ),
      container
    );
    await settle();
    const row = container.querySelector('.chat-background-service');
    for (const type of ['busy', 'idle', 'busy'] as const) {
      sessionStore.setSessionStatusEntry('ses_one', { type });
      await settle();
      expect(container.querySelector('.chat-background-service')).toBe(row);
      expect(row?.textContent).toContain(service.command);
    }
    expect(client.session.backgroundProcesses).toHaveBeenCalledTimes(1);
    sessionStore.setSessionStatusEntry('ses_one', { type: 'idle', backgroundServices: 0 });
    expect(container.querySelector('.chat-background-service')).toBeNull();
  });
  it('shows only running services in compact queue rows, and opens the selected process without reading logs', async () => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      service,
      { ...service, id: 'job', service: false },
      { ...service, id: 'ended', status: 'exited' },
    ]);
    cleanup = render(
      () => <BackgroundServices sessionID="ses_one" directory="/repo" count={1} />,
      container
    );
    await settle();
    const row = container.querySelector<HTMLButtonElement>('.chat-background-service')!;
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(1);
    expect(row.classList.contains('chat-queue-item')).toBe(true);
    expect(
      row
        .querySelector('.chat-queue-body > .chat-background-service-icon')
        ?.getAttribute('aria-hidden')
    ).toBe('true');
    expect(row.textContent).toContain(service.command);
    row.click();
    expect(backgroundProcessView()).toEqual({
      sessionID: 'ses_one',
      directory: '/repo',
      processID: 'server',
    });
    expect(client.session.backgroundProcessOutput).not.toHaveBeenCalled();
  });
  it('does not fetch processes when there are no services', async () => {
    cleanup = render(() => <BackgroundServices sessionID="ses_one" count={0} />, container);
    await settle();
    expect(container.textContent).toBe('');
    expect(client.session.backgroundProcesses).not.toHaveBeenCalled();
  });
  it('cancels stale session reads and does not carry commands to another chat', async () => {
    const [sessionID, setSessionID] = createSignal('ses_one');
    let resolve!: (processes: BackgroundProcess[]) => void;
    vi.mocked(client.session.backgroundProcesses)
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          })
      )
      .mockResolvedValue([]);
    cleanup = render(() => <BackgroundServices sessionID={sessionID()} count={1} />, container);
    const signal = vi.mocked(client.session.backgroundProcesses).mock.calls[0]?.[1]?.signal;
    setSessionID('ses_two');
    resolve([service]);
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(container.textContent).not.toContain(service.command);
  });
  it('keeps details accessible if loading fails', async () => {
    vi.mocked(client.session.backgroundProcesses).mockRejectedValue(new Error('Offline'));
    cleanup = render(() => <BackgroundServices sessionID="ses_one" count={1} />, container);
    await settle();
    expect(
      container.querySelector('.chat-queue-body > .chat-background-service-icon')
    ).not.toBeNull();
    container.querySelector<HTMLButtonElement>('button')!.click();
    expect(backgroundProcessView()?.sessionID).toBe('ses_one');
  });
});
