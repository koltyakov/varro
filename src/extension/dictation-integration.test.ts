/* oxlint-disable anti-slop/no-module-mocking -- Provider routing must not discover installed dictation apps in unit tests. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DictationAction, DictationStatus } from '../shared/protocol';

interface TestEnvironment {
  remoteName?: string;
}

const mocks = vi.hoisted(() => {
  const env: TestEnvironment = {};
  return { env };
});
vi.mock('vscode', () => ({
  env: mocks.env,
}));

import { DictationIntegration } from './dictation-integration';
import { HandyIntegration } from './handy-integration';
import { HexIntegration } from './hex-integration';

const handy = vi.spyOn(HandyIntegration.prototype, 'request');
const hex = vi.spyOn(HexIntegration.prototype, 'request');
const disposeHandy = vi.spyOn(HandyIntegration.prototype, 'dispose').mockImplementation(() => {});
const disposeHex = vi.spyOn(HexIntegration.prototype, 'dispose').mockImplementation(() => {});

function status(running: boolean, available = true): DictationStatus {
  return { available, running, state: 'idle' };
}

function respond(action: DictationAction): Promise<DictationStatus> {
  return Promise.resolve({
    available: true,
    running: true,
    state: action === 'start' ? 'recording' : 'idle',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.remoteName = undefined;
  handy.mockImplementation(respond);
  hex.mockImplementation(respond);
});
afterEach(() => {
  handy.mockReset();
  hex.mockReset();
});

describe('DictationIntegration', () => {
  it.each([
    [true, true, true, true, 'hex'],
    [true, true, false, true, 'handy'],
    [false, true, true, true, 'hex'],
    [false, true, false, true, 'hex'],
    [false, true, false, false, 'handy'],
    [false, false, false, true, 'hex'],
    [false, false, false, false, 'handy'],
  ] as const)(
    'selects %s/%s Handy and %s/%s Hex as %s',
    async (handyRunning, handyAvailable, hexRunning, hexAvailable, provider) => {
      handy.mockResolvedValue(status(handyRunning, handyAvailable));
      hex.mockResolvedValue(status(hexRunning, hexAvailable));
      expect(await new DictationIntegration().request('status')).toMatchObject({ provider });
      expect(handy).toHaveBeenCalledExactlyOnceWith('status');
      expect(hex).toHaveBeenCalledExactlyOnceWith('status');
    }
  );

  it('automatically starts Hex when both apps are running', async () => {
    const integration = new DictationIntegration();
    expect(await integration.request('start')).toMatchObject({
      provider: 'hex',
      state: 'recording',
    });
    expect(handy).toHaveBeenCalledExactlyOnceWith('status');
    expect(hex.mock.calls.map(([action]) => action)).toEqual(['status', 'start']);
  });

  it('keeps finish and cancel on the app that accepted start', async () => {
    const integration = new DictationIntegration();
    hex.mockResolvedValueOnce(status(false));
    expect(await integration.request('start')).toMatchObject({
      provider: 'handy',
      state: 'recording',
    });
    // Hex is now running, but cancellation still belongs to Handy.
    expect(await integration.request('cancel', undefined, 'hex')).toMatchObject({
      provider: 'handy',
    });
    expect(handy.mock.calls.map(([action]) => action)).toEqual(['status', 'start', 'cancel']);
    expect(hex.mock.calls.map(([action]) => action)).toEqual(['status']);

    expect(await integration.request('start')).toMatchObject({ provider: 'hex' });
    expect(await integration.request('status')).toMatchObject({ provider: 'hex' });
    // The fake status says idle, so the queued view's explicit provider also
    // preserves stop intent when the recording was already ended externally.
    expect(await integration.request('stop', undefined, 'hex')).toMatchObject({ provider: 'hex' });
    expect(hex.mock.calls.map(([action]) => action)).toEqual([
      'status',
      'status',
      'start',
      'status',
      'stop',
    ]);
  });

  it('rechecks running apps for a new start instead of trusting an old view selection', async () => {
    const integration = new DictationIntegration();
    hex.mockResolvedValueOnce(status(false));
    expect(await integration.request('status')).toMatchObject({ provider: 'handy' });
    expect(await integration.request('start', undefined, 'handy')).toMatchObject({
      provider: 'hex',
      state: 'recording',
    });
    expect(handy.mock.calls.map(([action]) => action)).toEqual(['status', 'status']);
  });

  it('does not fall back to the other app after a failed command', async () => {
    hex.mockResolvedValue({ ...status(true), error: 'Command timed out' });
    expect(await new DictationIntegration().request('start', undefined, 'hex')).toMatchObject({
      provider: 'hex',
      error: 'Command timed out',
    });
    expect(handy).toHaveBeenCalledExactlyOnceWith('status');
    expect(hex.mock.calls.map(([action]) => action)).toEqual(['status', 'start']);
  });

  it('queues a click behind discovery but rejects overlapping mutations across providers', async () => {
    let release: ((value: DictationStatus) => void) | undefined;
    handy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const integration = new DictationIntegration();
    const probe = integration.request('status');
    const start = integration.request('start', undefined, 'hex');
    release?.(status(false, false));
    await probe;
    expect(await start).toMatchObject({ state: 'recording', provider: 'hex' });
    let finish: ((value: DictationStatus) => void) | undefined;
    hex.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const first = integration.request('stop');
    const second = integration.request('start', undefined, 'handy');
    finish?.(status(true));
    await first;
    expect((await second).error).toContain('pending');
    expect(handy.mock.calls.map(([action]) => action)).toEqual(['status', 'status']);
  });

  it('orders observations across providers and ignores callbacks from an old command', async () => {
    const integration = new DictationIntegration();
    const notify = vi.fn();
    const first = await integration.request('start', notify, 'hex');
    const oldUpdate = hex.mock.calls.at(-1)?.[1];
    await integration.request('cancel', notify);
    hex.mockResolvedValueOnce(status(false));
    const next = await integration.request('start', notify, 'handy');
    oldUpdate?.({ ...status(true), state: 'recording' });
    expect(notify).not.toHaveBeenCalled();
    expect(next.revision).toBeGreaterThan(first.revision ?? 0);
    const currentUpdate = handy.mock.calls.at(-1)?.[1];
    currentUpdate?.({ ...status(true), revision: 4 });
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: 'handy', state: 'idle' })
    );
    handy.mockResolvedValue({ ...status(true), state: 'recording', revision: 3 });
    expect(await integration.request('status', undefined, 'handy')).toMatchObject({
      state: 'idle',
    });
  });

  it('does no provider work on remote hosts, and disposes both providers', async () => {
    const integration = new DictationIntegration();
    mocks.env.remoteName = 'wsl';
    await integration.request('start');
    expect(handy).not.toHaveBeenCalled();
    expect(hex).not.toHaveBeenCalled();
    mocks.env.remoteName = undefined;
    integration.dispose();
    await integration.request('start');
    expect(handy).not.toHaveBeenCalled();
    expect(hex).not.toHaveBeenCalled();
    expect(disposeHandy).toHaveBeenCalledTimes(1);
    expect(disposeHex).toHaveBeenCalledTimes(1);
  });
});
