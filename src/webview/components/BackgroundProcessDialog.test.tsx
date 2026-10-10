import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'solid-js/web';
import type { BackgroundProcess, BackgroundProcessOutput } from '../../shared/background-process';
import { client } from '../lib/client';
import { BackgroundProcessDialog } from './BackgroundProcessDialog';

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
function mount() {
  const onClose = vi.fn();
  cleanup = render(
    () => <BackgroundProcessDialog sessionID="ses_own" directory="/repo" onClose={onClose} />,
    container
  );
  return onClose;
}
function dialog() {
  return document.querySelector<HTMLElement>('.background-process-dialog')!;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(11_000);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  container = document.createElement('div');
  document.body.append(container);
  vi.spyOn(client.session, 'backgroundProcesses').mockResolvedValue([process]);
  vi.spyOn(client.session, 'backgroundProcessOutput').mockResolvedValue(output);
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('BackgroundProcessDialog', () => {
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
