import { describe, expect, it, vi } from 'vitest';
import { readMaximumTestedOpenCodeVersion } from './extension-manifest';
import {
  createServer,
  createSidebarProviderInstance,
  getVscodeMock,
} from './sidebar-provider.test-support';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = new Date('2026-10-01T12:00:00Z').getTime();

function getVersionItem() {
  const createStatusBarItem = getVscodeMock().window.createStatusBarItem;
  const index = createStatusBarItem.mock.calls.findIndex(([id]) => id === 'varro.opencode-version');
  return createStatusBarItem.mock.results[index]!.value;
}

describe('SidebarProvider server uptime', () => {
  it.each([
    [0, 'less than a min'],
    [59_999, 'less than a min'],
    [MINUTE, '1 min'],
    [42 * MINUTE + 59_999, '42 min'],
    [HOUR, '1 hr'],
    [HOUR + MINUTE, '1 hr 1 min'],
    [2 * HOUR + 35 * MINUTE, '2 hrs 35 min'],
    [DAY, '1 day'],
    [DAY + HOUR + 45 * MINUTE, '1 day 1 hr'],
    [2 * DAY + 10 * HOUR + 45 * MINUTE, '2 days 10 hrs'],
    [WEEK, '1 week'],
    [WEEK + DAY + HOUR, '1 week 1 day'],
    [2 * WEEK + 3 * DAY + 10 * HOUR, '2 weeks 3 days'],
  ])('formats %i ms of uptime as %s', async (duration, expected) => {
    const version = readMaximumTestedOpenCodeVersion(undefined, 2);
    const server = createServer({
      readServerInfo: vi.fn(async () => ({
        cliVersion: version,
        health: { healthy: true, version },
        connections: { startedAt: NOW - duration },
      })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    try {
      const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
      statusHandler?.({ state: 'running', url: server.url });
      await vi.waitFor(() =>
        expect(getVersionItem().tooltip).toContain(
          `Server port: 4096\nServer uptime: ${expected}\n\nVarro extension:`
        )
      );
    } finally {
      await provider.dispose();
      now.mockRestore();
    }
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])(
    'omits uptime when the actual start time is unavailable or invalid: %s',
    async (startedAt) => {
      const version = readMaximumTestedOpenCodeVersion(undefined, 2);
      const server = createServer({
        isAttachOnly: true,
        readServerInfo: vi.fn(async () => ({
          health: { healthy: true, version },
          connections: { startedAt },
        })),
      });
      const { provider } = await createSidebarProviderInstance({ server });
      try {
        const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
        statusHandler?.({ state: 'running', url: server.url });
        await vi.waitFor(() => expect(getVersionItem().text).toBe(`$(robot) OpenCode ${version}`));
        expect(getVersionItem().tooltip).not.toContain('Server uptime:');
      } finally {
        await provider.dispose();
      }
    }
  );

  it('refreshes uptime while idle, clears it on stop, resets after restart, and disposes its timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const version = readMaximumTestedOpenCodeVersion(undefined, 2);
    let startedAt = NOW - HOUR - 59 * MINUTE;
    const server = createServer({
      readServerInfo: vi.fn(async () => ({
        cliVersion: version,
        health: { healthy: true, version },
        connections: { startedAt },
      })),
    });
    const { provider } = await createSidebarProviderInstance({ server });
    try {
      const statusHandler = server.on.mock.calls.findLast(([event]) => event === 'status')?.[1];
      const item = getVersionItem();
      statusHandler?.({ state: 'running', url: server.url });
      await vi.waitFor(() => expect(item.tooltip).toContain('Server uptime: 1 hr 59 min'));

      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(item.tooltip).toContain('Server uptime: 2 hrs');
      expect(server.readServerInfo).toHaveBeenCalledTimes(1);

      statusHandler?.({ state: 'stopped' });
      expect(item.tooltip).not.toContain('Server uptime:');
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(item.tooltip).not.toContain('Server uptime:');

      startedAt = Date.now();
      statusHandler?.({ state: 'running', url: server.url });
      await vi.waitFor(() => expect(item.tooltip).toContain('Server uptime: less than a min'));
      await vi.advanceTimersByTimeAsync(MINUTE);
      expect(item.tooltip).toContain('Server uptime: 1 min');
      expect(server.readServerInfo).toHaveBeenCalledTimes(2);

      await provider.dispose();
      const tooltip = item.tooltip;
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(item.tooltip).toBe(tooltip);
    } finally {
      await provider.dispose();
      vi.useRealTimers();
    }
  });
});
