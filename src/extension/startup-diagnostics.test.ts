import { describe, expect, it, vi } from 'vitest';
import type { OpenCodeServer } from './server';
import { StartupDiagnostics } from './startup-diagnostics';

describe('startup addon diagnostics', () => {
  it('reports only named failures without forwarding addon stderr or transport configuration', async () => {
    const request = vi
      .fn<OpenCodeServer['request']>()
      .mockImplementation(async (_method, route) => ({
        data:
          route === '/api/plugin'
            ? [
                { id: 'plugin-a', state: { status: 'failed', error: 'secret stderr' } },
                { id: 'active', state: { status: 'active' } },
              ]
            : [
                {
                  name: 'atlassian',
                  command: ['node', 'secret'],
                  status: { status: 'failed', error: 'Request timed out with secret credentials' },
                },
                { name: 'pending', status: { status: 'pending' } },
              ],
      }));
    const failures = await new StartupDiagnostics({ apiVersion: 2, request }).read('/workspace');
    expect(failures).toEqual([
      { kind: 'plugin', name: 'plugin-a', timedOut: false },
      { kind: 'mcp', name: 'atlassian', timedOut: true },
    ]);
    expect(JSON.stringify(failures)).not.toContain('secret');
    expect(request).toHaveBeenCalledWith('GET', '/api/mcp', undefined, {
      directory: '/workspace',
      signal: expect.any(AbortSignal),
    });
  });

  it('does not probe unsupported V1 endpoints', async () => {
    const request = vi.fn<OpenCodeServer['request']>();
    await expect(
      new StartupDiagnostics({ apiVersion: 1, request }).read('/workspace')
    ).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('does not infer a slow plugin from an active inventory or malformed response', async () => {
    const request = vi
      .fn<OpenCodeServer['request']>()
      .mockResolvedValueOnce({ data: [{ id: 'not-proven-slow', state: { status: 'active' } }] })
      .mockResolvedValueOnce({
        data: [{ name: 'unknown', status: { status: 'failed' } }, { status: { status: 'failed' } }],
      });
    await expect(
      new StartupDiagnostics({ apiVersion: 2, request }).read('/workspace')
    ).resolves.toEqual([{ kind: 'mcp', name: 'unknown', timedOut: false }]);
  });

  it('bounds unavailable inventories and cancels their underlying reads', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const request = vi
        .fn<OpenCodeServer['request']>()
        .mockImplementation((_method, _route, _body, options) => {
          if (options?.signal) signals.push(options.signal);
          return new Promise(() => {});
        });
      const reading = new StartupDiagnostics({ apiVersion: 2, request }).read('/workspace');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(reading).resolves.toEqual([]);
      expect(signals).toHaveLength(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
