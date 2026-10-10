import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { BackgroundProcess, BackgroundProcessOutput } from '../../shared/background-process';
import { client } from '../lib/client';
import { BackgroundProcessDialog } from './BackgroundProcessDialog';
import { recheckSessionStatus, sendMessage } from '../hooks/useOpenCode';
import { error, resetDefaultAppState, setState } from '../lib/state';
import { sessionStore } from '../lib/stores/session-store';

/* oxlint-disable anti-slop/no-module-mocking -- Dialog action tests isolate the status-refresh orchestration while exercising the real controls. */
vi.mock('../hooks/useOpenCode', () => ({
  recheckSessionStatus: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(true),
}));

const process: BackgroundProcess = {
  id: 'shell-1',
  status: 'running',
  command: 'npm test',
  cwd: '/repo',
  pid: 42,
  time: { started: 1000 },
};
const output: BackgroundProcessOutput = {
  output: 'first line\n',
  cursor: 11,
  size: 11,
  truncated: false,
};
let container: HTMLDivElement;
let cleanup: (() => void) | undefined;

async function settle() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}
function mount(processID?: string) {
  const onClose = vi.fn();
  cleanup = render(
    () => (
      <BackgroundProcessDialog
        sessionID="ses_own"
        directory="/repo"
        processID={processID}
        onClose={onClose}
      />
    ),
    container
  );
  return onClose;
}
function dialog() {
  return document.querySelector<HTMLElement>('.background-process-dialog')!;
}

beforeEach(() => {
  resetDefaultAppState();
  vi.useFakeTimers();
  vi.setSystemTime(11_000);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  container = document.createElement('div');
  document.body.append(container);
  vi.spyOn(client.session, 'backgroundProcesses').mockResolvedValue([process]);
  vi.spyOn(client.session, 'backgroundProcessOutput').mockResolvedValue(output);
  vi.spyOn(client.session, 'setBackgroundProcessService').mockResolvedValue(true);
  vi.spyOn(client.session, 'stopBackgroundProcess').mockResolvedValue(true);
  vi.spyOn(client.session, 'status').mockResolvedValue({});
  vi.mocked(recheckSessionStatus).mockClear();
  vi.mocked(sendMessage).mockReset().mockResolvedValue(true);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('BackgroundProcessDialog', () => {
  it('opens the clicked process and groups the stop buttons together', async () => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      process,
      { ...process, id: 'shell-2', command: 'npm run build', pid: 43 },
    ]);
    mount('shell-2');
    await settle();
    expect(dialog().classList.contains('has-process-target')).toBe(true);
    expect(dialog().querySelector('.background-process-detail-command')?.textContent).toBe(
      'npm run build'
    );
    expect(
      [...dialog().querySelectorAll('.background-process-actions button')].map(
        (button) => button.textContent
      )
    ).toEqual(['Stop process', 'Steer stop']);
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledWith(
      'ses_own',
      'shell-2',
      expect.anything()
    );
  });

  it('steers the owning session to stop the selected process and closes without killing directly', async () => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      process,
      { ...process, id: 'shell-2', command: 'npm run build', pid: 43 },
    ]);
    const onClose = mount();
    await settle();
    dialog().querySelectorAll<HTMLButtonElement>('.background-process-list-item')[1]!.click();
    const steer = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Steer stop'
    )!;
    steer.click();
    await settle();
    expect(sendMessage).toHaveBeenCalledWith(
      'Stop the background process with PID 43 running this command:\nnpm run build\nProcess ID: shell-2\nWorking directory: /repo',
      {
        delivery: 'steer',
        targetSessionId: 'ses_own',
        workspaceDirectory: '/repo',
        preserveComposer: true,
        omitContext: true,
      }
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.session.stopBackgroundProcess).not.toHaveBeenCalled();
    expect(client.session.setBackgroundProcessService).not.toHaveBeenCalled();
  });

  it('identifies processes without a PID by command and process ID', async () => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      { ...process, pid: undefined },
    ]);
    const onClose = mount();
    await settle();
    [...dialog().querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Steer stop')!
      .click();
    await settle();
    expect(sendMessage).toHaveBeenCalledWith(
      'Stop the background process running this command:\nnpm test\nProcess ID: shell-1\nWorking directory: /repo',
      expect.anything()
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'closes immediately and reports failed steering in chat, throws=%s',
    async (throws) => {
      if (throws) vi.mocked(sendMessage).mockRejectedValue(new Error('Steering failed'));
      else vi.mocked(sendMessage).mockResolvedValue(false);
      setState('activeSessionId', 'ses_own');
      const onClose = mount();
      await settle();
      const steer = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'Steer stop'
      )!;
      steer.focus();
      steer.click();
      expect(onClose).toHaveBeenCalledTimes(1);
      cleanup?.();
      cleanup = undefined;
      await settle();
      expect(error()).toContain(throws ? 'Steering failed' : 'Could not send the stop request');
    }
  );

  it('closes before sending finishes and does not close twice after unmount', async () => {
    let resolveSend!: (value: boolean) => void;
    vi.mocked(sendMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        })
    );
    const onClose = mount();
    await settle();
    const steer = [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Steer stop'
    )!;
    steer.focus();
    steer.click();
    steer.click();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(steer.disabled).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup?.();
    cleanup = undefined;
    resolveSend(true);
    await settle();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not report a late steering failure in a different session', async () => {
    let rejectSend!: (error: Error) => void;
    vi.mocked(sendMessage).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSend = reject;
        })
    );
    setState('activeSessionId', 'ses_own');
    const onClose = mount();
    await settle();
    [...dialog().querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === 'Steer stop')!
      .click();
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup?.();
    cleanup = undefined;
    setState('activeSessionId', 'ses_other');
    rejectSend(new Error('Steering failed'));
    await settle();
    expect(error()).toBeNull();
  });

  it('disables steer stop for completed and removed processes', async () => {
    mount();
    await settle();
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      { ...process, status: 'exited' },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'Steer stop'
      )!.disabled
    ).toBe(true);
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      [...dialog().querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'Steer stop'
      )!.disabled
    ).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('publishes a fresh service count immediately after the acknowledged choice', async () => {
    vi.mocked(client.session.status).mockResolvedValue({
      ses_own: { type: 'idle', backgroundServices: 1 },
    });
    mount();
    await settle();
    const wait = dialog().querySelector<HTMLInputElement>('.background-process-controls input')!;
    wait.focus();
    wait.click();
    await settle();
    expect(client.session.status).toHaveBeenCalledWith({
      fresh: true,
      signal: expect.any(AbortSignal),
    });
    expect(sessionStore.getBackgroundServiceCount('ses_own')).toBe(1);
    expect(document.activeElement).toBe(wait);
  });
  it('detaches and reattaches waiting without stopping the process or losing output', async () => {
    mount();
    await settle();
    const wait = dialog().querySelector<HTMLInputElement>('.background-process-controls input')!;
    expect(wait.checked).toBe(true);
    wait.click();
    await settle();
    expect(wait.checked).toBe(false);
    expect(client.session.setBackgroundProcessService).toHaveBeenLastCalledWith(
      'ses_own',
      'shell-1',
      true,
      { directory: '/repo', signal: expect.any(AbortSignal) }
    );
    expect(dialog().textContent).toContain('Chat does not wait for this process');
    expect(dialog().querySelector('pre')?.textContent).toBe('first line\n');
    wait.click();
    await settle();
    expect(wait.checked).toBe(true);
    expect(client.session.setBackgroundProcessService).toHaveBeenLastCalledWith(
      'ses_own',
      'shell-1',
      false,
      expect.anything()
    );
    expect(client.session.stopBackgroundProcess).not.toHaveBeenCalled();
    expect(recheckSessionStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps the last acknowledged choice when an update fails', async () => {
    vi.mocked(client.session.setBackgroundProcessService).mockRejectedValue(
      new Error('Could not save choice')
    );
    mount();
    await settle();
    const wait = dialog().querySelector<HTMLInputElement>('.background-process-controls input')!;
    wait.click();
    await settle();
    expect(wait.checked).toBe(true);
    expect(wait.disabled).toBe(false);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save choice'
    );
    expect(recheckSessionStatus).not.toHaveBeenCalled();
  });

  it('keeps the dialog and loaded log when another process is still running', async () => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      { ...process, service: true },
      { ...process, id: 'shell-2', time: { started: 500 } },
    ]);
    const onClose = mount();
    await settle();
    const stop = dialog().querySelector<HTMLButtonElement>('.background-process-controls button')!;
    expect(client.session.stopBackgroundProcess).not.toHaveBeenCalled();
    stop.click();
    await settle();
    expect(client.session.stopBackgroundProcess).toHaveBeenCalledWith('ses_own', 'shell-1', {
      directory: '/repo',
      signal: expect.any(AbortSignal),
    });
    expect(stop.disabled).toBe(true);
    expect(dialog().querySelector('pre')?.textContent).toBe('first line\n');
    expect(dialog().textContent).toContain('No longer available');
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'closes after stopping the last running process, refresh fails=%s',
    async (refreshFails) => {
      vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
        { ...process, service: true },
        { ...process, id: 'shell-old', status: 'exited', time: { started: 500, completed: 900 } },
      ]);
      let resolveStop!: (value: boolean) => void;
      vi.mocked(client.session.stopBackgroundProcess).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveStop = resolve;
          })
      );
      if (refreshFails)
        vi.mocked(client.session.status).mockRejectedValue(new Error('Refresh failed'));
      const onClose = mount();
      await settle();
      dialog().querySelector<HTMLButtonElement>('.background-process-controls button')!.click();
      await settle();
      expect(onClose).not.toHaveBeenCalled();
      resolveStop(true);
      await settle();
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps the dialog open when stopping fails', async () => {
    vi.mocked(client.session.stopBackgroundProcess).mockRejectedValue(new Error('Stop failed'));
    const onClose = mount();
    await settle();
    const stop = dialog().querySelector<HTMLButtonElement>('.background-process-controls button')!;
    stop.click();
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(stop.disabled).toBe(false);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Stop failed');
  });

  it('ignores a stale process list that resolves during a choice update', async () => {
    mount();
    await settle();
    let resolveList!: (value: BackgroundProcess[]) => void;
    vi.mocked(client.session.backgroundProcesses).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(1000);
    const wait = dialog().querySelector<HTMLInputElement>('.background-process-controls input')!;
    wait.click();
    await settle();
    resolveList([process]);
    await settle();
    expect(wait.checked).toBe(false);
  });
  it('toggles wrapping and following without fetching more output', async () => {
    mount();
    await settle();
    const wrap = dialog().querySelector<HTMLButtonElement>('[aria-label="Wrap output lines"]')!;
    const follow = dialog().querySelector<HTMLButtonElement>('[aria-label="Follow output"]')!;
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    wrap.click();
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    expect(dialog().querySelector('pre')?.classList.contains('is-wrapped')).toBe(true);
    wrap.click();
    follow.click();
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    follow.click();
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    expect(dialog().querySelector('pre')?.textContent).toBe('first line\n');
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(1);
  });
  it('shows command, status, cwd, PID, duration and safe plain-text output', async () => {
    vi.mocked(client.session.backgroundProcessOutput).mockResolvedValue({
      ...output,
      output: '<script>bad()</script>\n',
    });
    mount();
    await settle();
    expect(dialog().textContent).toContain('npm test');
    expect(dialog().textContent).toContain('Running · 10s');
    expect(dialog().textContent).toContain('/repo · PID 42');
    expect(dialog().querySelector('pre')?.textContent).toContain('<script>bad()</script>');
    expect(dialog().querySelector('script')).toBeNull();
    expect(client.session.backgroundProcesses).toHaveBeenCalledWith('ses_own', {
      directory: '/repo',
      signal: expect.any(AbortSignal),
    });
  });

  it('updates elapsed time in the selected details and freezes it on completion', async () => {
    mount('shell-1');
    await settle();
    const duration = () =>
      dialog().querySelector('.background-process-detail .background-process-duration')
        ?.textContent;
    expect(duration()).toBe('10s');
    await vi.advanceTimersByTimeAsync(1000);
    expect(duration()).toBe('11s');
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      { ...process, status: 'exited', exit: 0, time: { started: 1000, completed: 12_000 } },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(duration()).toBe('11s');
    await vi.advanceTimersByTimeAsync(2000);
    expect(duration()).toBe('11s');
  });

  it('appends cursor-based output without overlapping requests and keeps process buttons mounted', async () => {
    vi.mocked(client.session.backgroundProcessOutput)
      .mockResolvedValueOnce(output)
      .mockResolvedValue({ output: 'next\n', cursor: 16, size: 16, truncated: false });
    mount();
    await settle();
    const button = dialog().querySelector('.background-process-list-item');
    await vi.advanceTimersByTimeAsync(1000);
    expect(dialog().querySelector('pre')?.textContent).toBe('first line\nnext\n');
    expect(dialog().querySelector('.background-process-list-item')).toBe(button);
    expect(client.session.backgroundProcessOutput).toHaveBeenLastCalledWith('ses_own', 'shell-1', {
      directory: '/repo',
      cursor: 11,
      signal: expect.any(AbortSignal),
    });
  });

  it('keeps completed and removed process output available', async () => {
    mount();
    await settle();
    const button = dialog().querySelector<HTMLButtonElement>('.background-process-list-item')!;
    button.focus();
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      { ...process, status: 'exited', exit: 0, time: { started: 1000, completed: 11_000 } },
    ]);
    vi.mocked(client.session.backgroundProcessOutput).mockResolvedValue({
      output: 'done\n',
      cursor: 16,
      size: 16,
      truncated: false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(dialog().textContent).toContain('Exited (0)');
    expect(dialog().querySelector('.background-process-list-item')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(dialog().querySelector('pre')?.textContent).toContain('done');
    const reads = vi.mocked(client.session.backgroundProcessOutput).mock.calls.length;
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dialog().textContent).toContain('No longer available');
    expect(dialog().querySelector('pre')?.textContent).toContain('done');
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(reads);
  });

  it('loads output only for the selected process and preserves each log on switching', async () => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      process,
      { ...process, id: 'shell-2', command: 'npm run build' },
    ]);
    vi.mocked(client.session.backgroundProcessOutput).mockImplementation(
      async (_session, id, options) =>
        id === 'shell-2'
          ? { output: 'build\n', cursor: 6, size: 6, truncated: false }
          : options?.cursor === undefined
            ? output
            : { ...output, output: '' }
    );
    mount();
    await settle();
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(1);
    const buttons = dialog().querySelectorAll<HTMLButtonElement>('.background-process-list-item');
    buttons[1]!.click();
    await settle();
    expect(dialog().querySelector('pre')?.textContent).toBe('build\n');
    buttons[0]!.click();
    await settle();
    expect(dialog().querySelector('pre')?.textContent).toBe('first line\n');
  });

  it('exposes errors with retry and does not discard an already loaded log', async () => {
    mount();
    await settle();
    vi.mocked(client.session.backgroundProcessOutput).mockRejectedValueOnce(
      new Error('Log read failed')
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(dialog().textContent).toContain('Log read failed');
    expect(dialog().querySelector('pre')?.textContent).toBe('first line\n');
    dialog().querySelector<HTMLButtonElement>('.background-process-error button')!.click();
    await settle();
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
  });

  it('shows initial list errors and recovers an empty list on retry', async () => {
    vi.mocked(client.session.backgroundProcesses)
      .mockRejectedValueOnce(new Error('Server unavailable'))
      .mockResolvedValue([]);
    mount();
    await settle();
    expect(dialog().textContent).toContain('Server unavailable');
    dialog().querySelector<HTMLButtonElement>('.background-process-error button')!.click();
    await settle();
    expect(dialog().textContent).toContain('No background processes are available');
  });

  it('bounds retained output and marks omitted history', async () => {
    vi.mocked(client.session.backgroundProcessOutput)
      .mockResolvedValueOnce({
        output: 'a'.repeat(100_000),
        cursor: 100_000,
        size: 100_000,
        truncated: true,
      })
      .mockResolvedValue({
        output: 'b'.repeat(64_000),
        cursor: 164_000,
        size: 164_000,
        truncated: false,
      });
    mount();
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dialog().querySelector('pre')?.textContent?.length).toBe(128 * 1024);
    expect(dialog().textContent).toContain('Earlier output omitted');
  });

  it('cancels in-flight reads on unmount and ignores late responses', async () => {
    let resolve!: (value: BackgroundProcessOutput) => void;
    vi.mocked(client.session.backgroundProcessOutput).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    mount();
    await settle();
    const signal = vi.mocked(client.session.backgroundProcessOutput).mock.calls[0]?.[2]?.signal;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(1);
    cleanup?.();
    cleanup = undefined;
    expect(signal?.aborted).toBe(true);
    resolve(output);
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(document.querySelector('.background-process-dialog')).toBeNull();
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(1);
  });

  it('pauses reads while hidden and supports Escape and close with focus restoration', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const onClose = mount();
    await settle();
    const reads = vi.mocked(client.session.backgroundProcessOutput).mock.calls.length;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(reads);
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    dialog().querySelector<HTMLButtonElement>('.background-process-close')!.click();
    expect(onClose).toHaveBeenCalledTimes(2);
    cleanup?.();
    cleanup = undefined;
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
