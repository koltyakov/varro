import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureStartupPhase, withStartupDeadline } from './startup';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startup deadlines and timing', () => {
  it('cancels a stalled read and handles its late rejection', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let fail!: (error: Error) => void;
    const read = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const operation = withStartupDeadline(
      (value) => {
        signal = value;
        return read;
      },
      100,
      'Credential lookup'
    );
    const rejected = expect(operation).rejects.toThrow('Credential lookup timed out after 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(signal?.aborted).toBe(true);
    fail(new Error('late vault failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards cancellation and does not start an already cancelled read', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const read = vi.fn((_signal: AbortSignal) => new Promise<never>(() => {}));
    const operation = withStartupDeadline(read, 100, 'Health', controller.signal);
    const rejected = expect(operation).rejects.toThrow('cancelled');
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await rejected;
    expect(read.mock.calls[0]?.[0]?.aborted).toBe(true);
    read.mockClear();
    await expect(withStartupDeadline(read, 100, 'Health', controller.signal)).rejects.toThrow(
      'cancelled'
    );
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears deadlines after success or synchronous failure', async () => {
    vi.useFakeTimers();
    await expect(withStartupDeadline(async () => 42, 100, 'Health')).resolves.toBe(42);
    await expect(
      withStartupDeadline(
        () => {
          throw new Error('failed');
        },
        100,
        'Health'
      )
    ).rejects.toThrow('failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('records monotonic durations without operation results or errors', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(35);
    const record = vi.fn();
    await measureStartupPhase('credentials', async () => 'private-password', record);
    expect(record).toHaveBeenCalledExactlyOnceWith({
      phase: 'credentials',
      durationMs: 25,
      state: 'completed',
    });
    record.mockClear();
    await expect(
      measureStartupPhase(
        'health',
        async () => {
          throw new Error('secret');
        },
        record
      )
    ).rejects.toThrow('secret');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'health', state: 'failed' })
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('secret');
  });
});
