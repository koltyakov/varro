/* oxlint-disable anti-slop/no-unknown-parameters -- The in-memory Memento stores opaque host values. */
import type { Memento } from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture } from '../webview/test-fixtures';
import { SessionProjectWindow } from './session-project-window';

const reference = { id: 'ses_other', title: 'Other', directory: '/other', external: true };

function storage() {
  const values = new Map<string, unknown>();
  return fixture<Memento>({
    get: (key: string) => values.get(key),
    update: vi.fn(async (key: string, value: unknown) => {
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    }),
  });
}

afterEach(() => vi.useRealTimers());

describe('session project window handoff', () => {
  it('opens only the owning project on the same server and consumes the request once', async () => {
    const saved = storage();
    await new SessionProjectWindow(saved).queue(reference, 'server-a');
    const destination = new SessionProjectWindow(saved);
    expect(await destination.take(['/repo'], 'server-a')).toBeNull();
    expect(await destination.take(['/other'], 'server-b')).toBeNull();
    expect(await destination.take(['/other'], undefined)).toBeNull();
    expect(await destination.take(['/other'], 'server-a')).toEqual({
      id: 'ses_other',
      directory: '/other',
    });
    expect(await destination.take(['/other'], 'server-a')).toBeNull();
  });

  it('expires stale requests instead of changing the next ordinary project opening', async () => {
    vi.useFakeTimers();
    const handoff = new SessionProjectWindow(storage());
    await handoff.queue(reference, 'server-a');
    vi.advanceTimersByTime(120_001);
    expect(await handoff.take(['/other'], 'server-a')).toBeNull();
  });

  it('rejects invalid directories and disconnected servers', async () => {
    const handoff = new SessionProjectWindow(storage());
    await expect(
      handoff.queue({ ...reference, directory: 'relative' }, 'server-a')
    ).rejects.toThrow();
    await expect(handoff.queue(reference, '')).rejects.toThrow();
  });
});
