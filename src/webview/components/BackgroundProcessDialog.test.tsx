import { flush as flushSolid } from 'solid-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@solidjs/web';
import type { BackgroundProcess, BackgroundProcessOutput } from '../../shared/background-process';
import { client } from '../lib/client';
import { BackgroundProcessDialog } from './BackgroundProcessDialog';
import { recheckSessionStatus, sendMessage } from '../hooks/useOpenCode';
import { resetDefaultAppState } from '../lib/state';
import { sessionStore } from '../lib/stores/session-store';
import * as clipboard from '../lib/write-clipboard';

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
  flushSolid();
  vi.useFakeTimers();
  vi.setSystemTime(11_000);
  flushSolid();
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
  flushSolid();
  cleanup = undefined;
  container.remove();
  flushSolid();
  vi.restoreAllMocks();
  flushSolid();
  vi.useRealTimers();
});

describe('BackgroundProcessDialog', () => {
  it('collapses the command by default and allows expanding and collapsing it', async () => {
    const command = "python3 - <<'PY'\nimport subprocess\nprint('done')\nPY";
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([{ ...process, command }]);
    mount();
    flushSolid();
    await settle();
    flushSolid();
    const toggle = dialog().querySelector<HTMLButtonElement>('.background-process-command-toggle')!;
    const preview = dialog().querySelector('.background-process-detail-command')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Expand command');
    expect(dialog().querySelector('[aria-label="Full command"]')).toBeNull();
    expect(preview.textContent).toBe(command);
    toggle.click();
    flushSolid();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Collapse command');
    expect(dialog().querySelector('[aria-label="Full command"]')?.textContent).toBe(command);
    expect(dialog().querySelector('[aria-label="Full command"]')?.closest('[id]')?.id).toBe(
      toggle.getAttribute('aria-controls')
    );
    flushSolid();
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    flushSolid();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(dialog().querySelector('[aria-label="Full command"]')).toBeNull();
  });

  it('copies the full command while collapsed or expanded without toggling the card', async () => {
    const writeClipboard = vi.spyOn(clipboard, 'writeClipboard').mockResolvedValue(true);
    const command = "python3 - <<'PY'\nprint('full command')\nPY";
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      { ...process, command },
      { ...process, id: 'shell-2', command: 'npm run build' },
    ]);
    mount();
    flushSolid();
    await settle();
    flushSolid();
    const toggle = dialog().querySelector<HTMLButtonElement>('.background-process-command-toggle')!;
    const copy = dialog().querySelector<HTMLButtonElement>('.tool-copy-button')!;
    expect(toggle.contains(copy)).toBe(false);
    copy.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(writeClipboard).toHaveBeenLastCalledWith(command);
    expect(copy.getAttribute('aria-label')).toBe('Copied');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await vi.advanceTimersByTimeAsync(1500);
    flushSolid();
    expect(copy.getAttribute('aria-label')).toBe(`Copy command: ${command}`);
    toggle.click();
    flushSolid();
    copy.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(writeClipboard).toHaveBeenLastCalledWith(command);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    dialog().querySelectorAll<HTMLButtonElement>('.background-process-list-item')[1]!.click();
    flushSolid();
    dialog().querySelector<HTMLButtonElement>('.tool-copy-button')!.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(writeClipboard).toHaveBeenLastCalledWith('npm run build');
  });

  it('collapses the command when switching processes', async () => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      process,
      { ...process, id: 'shell-2', command: 'npm run build' },
    ]);
    mount();
    flushSolid();
    await settle();
    flushSolid();
    dialog().querySelector<HTMLButtonElement>('.background-process-command-toggle')!.click();
    flushSolid();
    dialog().querySelectorAll<HTMLButtonElement>('.background-process-list-item')[1]!.click();
    flushSolid();
    expect(
      dialog().querySelector('.background-process-command-toggle')?.getAttribute('aria-expanded')
    ).toBe('false');
    expect(dialog().querySelector('.background-process-detail-command')?.textContent).toBe(
      'npm run build'
    );
  });

  it('opens the clicked process with only the direct stop action', async () => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      process,
      { ...process, id: 'shell-2', command: 'npm run build', pid: 43 },
    ]);
    mount('shell-2');
    flushSolid();
    await settle();
    flushSolid();
    expect(dialog().classList.contains('has-process-target')).toBe(true);
    expect(dialog().querySelector('.background-process-detail-command')?.textContent).toBe(
      'npm run build'
    );
    expect(
      [...dialog().querySelectorAll('.background-process-actions button')].map(
        (button) => button.textContent
      )
    ).toEqual(['Stop process']);
    expect(dialog().textContent).not.toContain('Steer stop');
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledWith(
      'ses_own',
      'shell-2',
      expect.anything()
    );
  });

  it.each([43, undefined])('stops the selected process directly with PID %s', async (pid) => {
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      process,
      { ...process, id: 'shell-2', command: 'npm run build', pid },
    ]);
    const onClose = mount();
    flushSolid();
    await settle();
    flushSolid();
    dialog().querySelectorAll<HTMLButtonElement>('.background-process-list-item')[1]!.click();
    flushSolid();
    const stop = dialog().querySelector<HTMLButtonElement>('.background-process-actions button')!;
    stop.click();
    flushSolid();
    stop.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(client.session.stopBackgroundProcess).toHaveBeenCalledExactlyOnceWith(
      'ses_own',
      'shell-2',
      {
        directory: '/repo',
        signal: expect.any(AbortSignal),
      }
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(client.session.setBackgroundProcessService).not.toHaveBeenCalled();
  });

  it('disables stop for completed and removed processes', async () => {
    mount();
    flushSolid();
    await settle();
    flushSolid();
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      { ...process, status: 'exited' },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    expect(
      dialog().querySelector<HTMLButtonElement>('.background-process-actions button')!.disabled
    ).toBe(true);
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    expect(
      dialog().querySelector<HTMLButtonElement>('.background-process-actions button')!.disabled
    ).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('publishes a fresh service count immediately after the acknowledged choice', async () => {
    vi.mocked(client.session.status).mockResolvedValue({
      ses_own: { type: 'idle', backgroundServices: 1 },
    });
    mount();
    flushSolid();
    await settle();
    flushSolid();
    const wait = dialog().querySelector<HTMLInputElement>('.background-process-controls input')!;
    wait.focus();
    flushSolid();
    wait.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(client.session.status).toHaveBeenCalledWith({
      fresh: true,
      signal: expect.any(AbortSignal),
    });
    expect(sessionStore.getBackgroundServiceCount('ses_own')).toBe(1);
    expect(document.activeElement).toBe(wait);
  });
  it('detaches and reattaches waiting without stopping the process or losing output', async () => {
    mount();
    flushSolid();
    await settle();
    flushSolid();
    const wait = dialog().querySelector<HTMLInputElement>('.background-process-controls input')!;
    expect(wait.checked).toBe(true);
    wait.click();
    flushSolid();
    await settle();
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
    const wait = dialog().querySelector<HTMLInputElement>('.background-process-controls input')!;
    wait.click();
    flushSolid();
    await settle();
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
    const stop = dialog().querySelector<HTMLButtonElement>('.background-process-controls button')!;
    expect(client.session.stopBackgroundProcess).not.toHaveBeenCalled();
    stop.click();
    flushSolid();
    await settle();
    flushSolid();
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
      flushSolid();
      await settle();
      flushSolid();
      dialog().querySelector<HTMLButtonElement>('.background-process-controls button')!.click();
      flushSolid();
      await settle();
      flushSolid();
      expect(onClose).not.toHaveBeenCalled();
      resolveStop(true);
      flushSolid();
      await settle();
      flushSolid();
      expect(onClose).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps the dialog open when stopping fails', async () => {
    vi.mocked(client.session.stopBackgroundProcess).mockRejectedValue(new Error('Stop failed'));
    const onClose = mount();
    flushSolid();
    await settle();
    flushSolid();
    const stop = dialog().querySelector<HTMLButtonElement>('.background-process-controls button')!;
    stop.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(onClose).not.toHaveBeenCalled();
    expect(stop.disabled).toBe(false);
    expect(dialog().querySelector('[role="alert"]')?.textContent).toContain('Stop failed');
  });

  it('ignores a stale process list that resolves during a choice update', async () => {
    mount();
    flushSolid();
    await settle();
    flushSolid();
    let resolveList!: (value: BackgroundProcess[]) => void;
    vi.mocked(client.session.backgroundProcesses).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    const wait = dialog().querySelector<HTMLInputElement>('.background-process-controls input')!;
    wait.click();
    flushSolid();
    await settle();
    flushSolid();
    resolveList([process]);
    flushSolid();
    await settle();
    flushSolid();
    expect(wait.checked).toBe(false);
  });
  it('toggles wrapping and following without fetching more output', async () => {
    mount();
    flushSolid();
    await settle();
    flushSolid();
    const wrap = dialog().querySelector<HTMLButtonElement>('[aria-label="Wrap output lines"]')!;
    const follow = dialog().querySelector<HTMLButtonElement>('[aria-label="Follow output"]')!;
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    expect(follow.getAttribute('aria-pressed')).toBe('true');
    wrap.click();
    flushSolid();
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    expect(dialog().querySelector('pre')?.classList.contains('is-wrapped')).toBe(true);
    wrap.click();
    flushSolid();
    follow.click();
    flushSolid();
    expect(follow.getAttribute('aria-pressed')).toBe('false');
    follow.click();
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
    const duration = () =>
      dialog().querySelector('.background-process-detail .background-process-duration')
        ?.textContent;
    expect(duration()).toBe('10s');
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    expect(duration()).toBe('11s');
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([
      { ...process, status: 'exited', exit: 0, time: { started: 1000, completed: 12_000 } },
    ]);
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    expect(duration()).toBe('11s');
    await vi.advanceTimersByTimeAsync(2000);
    flushSolid();
    expect(duration()).toBe('11s');
  });

  it('appends cursor-based output without overlapping requests and keeps process buttons mounted', async () => {
    vi.mocked(client.session.backgroundProcessOutput)
      .mockResolvedValueOnce(output)
      .mockResolvedValue({ output: 'next\n', cursor: 16, size: 16, truncated: false });
    mount();
    flushSolid();
    await settle();
    flushSolid();
    const button = dialog().querySelector('.background-process-list-item');
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
    const button = dialog().querySelector<HTMLButtonElement>('.background-process-list-item')!;
    button.focus();
    flushSolid();
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
    flushSolid();
    expect(dialog().textContent).toContain('Exited (0)');
    expect(dialog().querySelector('.background-process-list-item')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(dialog().querySelector('pre')?.textContent).toContain('done');
    const reads = vi.mocked(client.session.backgroundProcessOutput).mock.calls.length;
    vi.mocked(client.session.backgroundProcesses).mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(1);
    const buttons = dialog().querySelectorAll<HTMLButtonElement>('.background-process-list-item');
    buttons[1]!.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(dialog().querySelector('pre')?.textContent).toBe('build\n');
    buttons[0]!.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(dialog().querySelector('pre')?.textContent).toBe('first line\n');
  });

  it('exposes errors with retry and does not discard an already loaded log', async () => {
    mount();
    flushSolid();
    await settle();
    flushSolid();
    vi.mocked(client.session.backgroundProcessOutput).mockRejectedValueOnce(
      new Error('Log read failed')
    );
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
    expect(dialog().textContent).toContain('Log read failed');
    expect(dialog().querySelector('pre')?.textContent).toBe('first line\n');
    dialog().querySelector<HTMLButtonElement>('.background-process-error button')!.click();
    flushSolid();
    await settle();
    flushSolid();
    expect(dialog().querySelector('[role="alert"]')).toBeNull();
  });

  it('shows initial list errors and recovers an empty list on retry', async () => {
    vi.mocked(client.session.backgroundProcesses)
      .mockRejectedValueOnce(new Error('Server unavailable'))
      .mockResolvedValue([]);
    mount();
    flushSolid();
    await settle();
    flushSolid();
    expect(dialog().textContent).toContain('Server unavailable');
    dialog().querySelector<HTMLButtonElement>('.background-process-error button')!.click();
    flushSolid();
    await settle();
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
    await vi.advanceTimersByTimeAsync(1000);
    flushSolid();
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
    flushSolid();
    await settle();
    flushSolid();
    const signal = vi.mocked(client.session.backgroundProcessOutput).mock.calls[0]?.[2]?.signal;
    await vi.advanceTimersByTimeAsync(5000);
    flushSolid();
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(1);
    cleanup?.();
    flushSolid();
    cleanup = undefined;
    expect(signal?.aborted).toBe(true);
    resolve(output);
    flushSolid();
    await settle();
    flushSolid();
    await vi.advanceTimersByTimeAsync(2000);
    flushSolid();
    expect(document.querySelector('.background-process-dialog')).toBeNull();
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(1);
  });

  it('pauses reads while hidden and supports Escape and close with focus restoration', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    flushSolid();
    const onClose = mount();
    flushSolid();
    await settle();
    flushSolid();
    const reads = vi.mocked(client.session.backgroundProcessOutput).mock.calls.length;
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5000);
    flushSolid();
    expect(client.session.backgroundProcessOutput).toHaveBeenCalledTimes(reads);
    dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSolid();
    expect(onClose).toHaveBeenCalledTimes(1);
    dialog().querySelector<HTMLButtonElement>('.background-process-close')!.click();
    flushSolid();
    expect(onClose).toHaveBeenCalledTimes(2);
    cleanup?.();
    flushSolid();
    cleanup = undefined;
    expect(document.activeElement).toBe(opener);
    opener.remove();
    flushSolid();
  });
});
