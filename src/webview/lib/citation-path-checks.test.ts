import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CitationPathChecks } from './citation-path-checks';

describe('CitationPathChecks', () => {
  const scope = { directory: '/repo', sessionID: 'session-1' };
  let checks: CitationPathChecks;
  const request =
    vi.fn<
      (
        body: { paths: string[]; directory?: string; sessionID?: string },
        signal: AbortSignal
      ) => Promise<Array<string | null>>
    >();

  beforeEach(() => {
    vi.useFakeTimers();
    request
      .mockReset()
      .mockImplementation(async ({ paths }) => paths.map((path) => `/repo/${path}`));
    checks = new CitationPathChecks(request);
  });

  afterEach(() => {
    checks.clear();
    vi.useRealTimers();
  });

  it('defers work and batches duplicate citations independently of Markdown rendering', async () => {
    const first = checks.check('src/app.ts', scope);
    const duplicate = checks.check('src/app.ts', scope);
    const second = checks.check('app.ts', scope);
    expect(request).not.toHaveBeenCalled();
    expect(duplicate).toBe(first);
    expect(checks.peek('src/app.ts', scope)).toBeUndefined();
    await vi.runAllTimersAsync();
    await expect(Promise.all([first, second])).resolves.toEqual([
      '/repo/src/app.ts',
      '/repo/app.ts',
    ]);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      { ...scope, paths: ['src/app.ts', 'app.ts'] },
      expect.any(AbortSignal)
    );
    expect(checks.peek('src/app.ts', scope)).toBe('/repo/src/app.ts');
  });

  it('caches missing paths and separates identical paths in different projects', async () => {
    request.mockResolvedValue([null]);
    const first = checks.check('app.ts', scope);
    await vi.runAllTimersAsync();
    await expect(first).resolves.toBeNull();
    expect(checks.peek('app.ts', scope)).toBeNull();
    await checks.check('app.ts', scope);
    expect(request).toHaveBeenCalledOnce();
    const other = checks.check('app.ts', { directory: '/other', sessionID: 'other-session' });
    await vi.runAllTimersAsync();
    await other;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refreshes both positive and negative results after expiry', async () => {
    request.mockResolvedValueOnce([null]).mockResolvedValueOnce(['/repo/app.ts']);
    const missing = checks.check('app.ts', scope);
    await vi.runAllTimersAsync();
    await missing;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(checks.peek('app.ts', scope)).toBeUndefined();
    const existing = checks.check('app.ts', scope);
    await vi.runAllTimersAsync();
    await expect(existing).resolves.toBe('/repo/app.ts');
    await vi.advanceTimersByTimeAsync(15_001);
    expect(checks.peek('app.ts', scope)).toBeUndefined();
    const refreshed = checks.check('app.ts', scope);
    await vi.runAllTimersAsync();
    await expect(refreshed).resolves.toBe('/repo/app.ts');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('bounds batches and does not mix owning directories', async () => {
    const pending = Array.from({ length: 70 }, (_, index) =>
      checks.check(`file-${index}.ts`, scope)
    );
    pending.push(checks.check('other.ts', { directory: '/other' }));
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(request.mock.calls.map(([body]) => body.paths.length)).toEqual([64, 6, 1]);
    expect(request.mock.calls[2]![0].directory).toBe('/other');
  });

  it.each([{ value: ['relative.ts'] }, { value: [] }])(
    'leaves invalid results inert: $value',
    async ({ value }) => {
      request.mockResolvedValue(value);
      const result = checks.check('app.ts', scope);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toBeNull();
    }
  );

  it('resolves pending subscribers when cleared and ignores late responses', async () => {
    let finish!: (value: string[]) => void;
    request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const result = checks.check('app.ts', scope);
    await vi.advanceTimersByTimeAsync(0);
    const signal = request.mock.calls[0]![1];
    checks.clear();
    await expect(result).resolves.toBeNull();
    expect(signal.aborted).toBe(true);
    finish(['/repo/app.ts']);
    await Promise.resolve();
    expect(checks.peek('app.ts', scope)).toBeUndefined();
  });
});
