/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The Memento fake accepts opaque persisted values so corruption handling can be tested. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { QueuedMessageStore } from './queued-message-store';

function createPersistence() {
  const storage = new Map<string, unknown>();
  const persistence: Persistence = {
    get: <T>(key: string) => storage.get(key) as T | undefined,
    set: vi.fn((key: string, value: unknown) => {
      storage.set(key, value);
    }),
    remove: vi.fn((key: string) => {
      storage.delete(key);
    }),
  };
  return { persistence, storage };
}

function queuedMessage(id: string, text: string, ownerViewId: string) {
  return {
    id,
    sessionId: 'session-1',
    text,
    ownerViewId,
    droppedFiles: [],
    clipboardImages: [],
    terminalSelection: null,
  };
}

function isTestViewEligible(viewId: string) {
  return viewId === 'editor-a' || viewId === 'editor-b';
}

describe('QueuedMessageStore', () => {
  it('restores queued messages after the host is recreated', async () => {
    const { persistence } = createPersistence();
    const messages = [
      {
        id: 'queue-1',
        sessionId: 'session-1',
        text: 'run the tests',
        droppedFiles: [],
        clipboardImages: [
          {
            id: 'image-1',
            url: 'data:image/png;base64,AA==',
            mime: 'image/png',
            filename: 'image.png',
            size: 1,
          },
        ],
        nativePdfs: [],
        terminalSelection: null,
      },
    ];

    const store = new QueuedMessageStore(persistence);
    expect(store.list()).toBeUndefined();

    await store.update(messages);
    await store.dispose();

    expect(new QueuedMessageStore(persistence).list()).toEqual(messages);
  });

  it('restores queued native PDF data through host persistence', async () => {
    const { persistence } = createPersistence();
    const messages = [
      {
        id: 'queue-pdf',
        sessionId: 'session-1',
        text: 'review',
        droppedFiles: [],
        clipboardImages: [],
        nativePdfs: [
          {
            id: 'pdf-1',
            url: 'data:application/pdf;base64,JVBERi0xCg==',
            mime: 'application/pdf' as const,
            filename: 'spec.pdf',
            size: 7,
          },
        ],
        terminalSelection: null,
      },
    ];

    const store = new QueuedMessageStore(persistence);
    await store.update(messages);

    expect(new QueuedMessageStore(persistence).list()).toEqual(messages);
  });

  it('discards persisted snapshots that do not satisfy the queued-message contract', () => {
    const { persistence, storage } = createPersistence();
    storage.set('varro.queuedMessages', [
      {
        id: 'queue-1',
        sessionId: 'session-1',
        text: 'run the tests',
        clipboardImages: [],
        terminalSelection: null,
      },
    ]);

    expect(new QueuedMessageStore(persistence).list()).toEqual([]);
  });

  it('coalesces stalled writes so only the newest queue snapshot remains pending', async () => {
    const storage = new Map<string, unknown>();
    let releaseFirstWrite: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const persistence: Persistence = {
      get: <T>(key: string) => storage.get(key) as T | undefined,
      set: vi
        .fn<(key: string, value: unknown) => void | Promise<void>>()
        .mockImplementationOnce(async (key, value) => {
          await firstWrite;
          storage.set(key, value);
        })
        .mockImplementation((key, value) => {
          storage.set(key, value);
        }),
      remove: vi.fn(),
    };
    const store = new QueuedMessageStore(persistence);
    const first = [
      {
        id: 'queue-1',
        sessionId: 'session-1',
        text: 'first',
        droppedFiles: [],
        clipboardImages: [],
        nativePdfs: [],
        terminalSelection: null,
      },
    ];
    const latest = [
      {
        id: 'queue-2',
        sessionId: 'session-1',
        text: 'latest',
        droppedFiles: [],
        clipboardImages: [],
        nativePdfs: [],
        terminalSelection: null,
      },
    ];

    const firstUpdate = store.update(first);
    await Promise.resolve();
    const pendingUpdate = store.update([queuedMessage('pending', 'pending', 'editor-a')]);
    const replacements = Array.from({ length: 1_000 }, (_, index) =>
      store.update([queuedMessage(`replacement-${index}`, `replacement-${index}`, 'editor-a')])
    );
    const latestUpdate = store.update(latest);
    expect(persistence.set).toHaveBeenCalledOnce();
    expect(new Set([...replacements, latestUpdate])).toEqual(new Set([pendingUpdate]));

    releaseFirstWrite?.();
    await Promise.all([firstUpdate, pendingUpdate, ...replacements, latestUpdate, store.dispose()]);

    expect(persistence.set).toHaveBeenCalledTimes(2);
    expect(storage.get('varro.queuedMessages')).toEqual(latest);
  });

  it('keeps dispatch admission durable when it joins a pending removal', async () => {
    const { persistence, storage } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    const first = queuedMessage('queue-1', 'remove', 'editor-a');
    const second = queuedMessage('queue-2', 'dispatch', 'editor-b');
    await store.update([first, second]);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    vi.mocked(persistence.set)
      .mockImplementationOnce(() => blocker)
      .mockImplementationOnce((key, value) => {
        storage.set(key, value);
      })
      .mockRejectedValueOnce(new Error('first queue write failed'))
      .mockRejectedValueOnce(new Error('second queue write failed'))
      .mockImplementationOnce((key, value) => {
        storage.set(key, value);
      })
      .mockImplementationOnce((key, value) => {
        storage.set(key, value);
      });

    const blockingUpdate = store.update([first, second]);
    await Promise.resolve();
    const removal = store.updateOwned('editor-a', []);
    const claim = store.claimDispatch('editor-b', 'session-1', 'queue-2', isTestViewEligible)!;
    const admission = store.beginDispatchAdmission(
      'editor-b',
      'session-1',
      'queue-2',
      claim.lease,
      1,
      'message-2'
    );

    releaseBlocker();
    await expect(admission).resolves.toBe(true);
    await Promise.all([blockingUpdate, removal, store.dispose()]);

    expect(storage.get('varro.queuedMessages')).toEqual([{ ...second, messageId: 'message-2' }]);
  });

  it('rolls back an owned queue removal when persistence fails', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    const message = queuedMessage('queue-1', 'keep me', 'editor-a');
    await store.update([message]);
    vi.mocked(persistence.set).mockRejectedValueOnce(new Error('disk full'));

    await expect(store.updateOwned('editor-a', [])).rejects.toThrow('disk full');

    expect(store.list()).toEqual([message]);
  });

  it('uses a durable tombstone when the queue snapshot removal fails', async () => {
    const { persistence, storage } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    const message = queuedMessage('queue-1', 'remove me', 'editor-a');
    await store.update([message]);
    vi.mocked(persistence.set)
      .mockImplementationOnce((key, value) => {
        storage.set(key, value);
      })
      .mockRejectedValueOnce(new Error('queue snapshot failed'));

    await expect(store.updateOwned('editor-a', [])).resolves.toBeUndefined();

    expect(store.list()).toEqual([]);
    expect(new QueuedMessageStore(persistence).list()).toEqual([]);
  });

  it('rolls overlapping failures back to the last durable snapshot', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    const persisted = queuedMessage('queue-1', 'persisted', 'editor-a');
    await store.update([persisted]);
    vi.mocked(persistence.set).mockRejectedValue(new Error('disk full'));

    const first = store.updateOwned('editor-a', [queuedMessage('queue-1', 'first', 'editor-a')]);
    const second = store.updateOwned('editor-a', [queuedMessage('queue-1', 'second', 'editor-a')]);

    await expect(first).rejects.toThrow('disk full');
    await expect(second).rejects.toThrow('disk full');
    expect(store.list()).toEqual([persisted]);
  });

  it('keeps a durable removal while rolling back a coalesced edit', async () => {
    const { persistence, storage } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    const removed = queuedMessage('queue-1', 'remove', 'editor-a');
    const kept = queuedMessage('queue-2', 'persisted', 'editor-b');
    await store.update([removed, kept]);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    vi.mocked(persistence.set)
      .mockImplementationOnce(() => blocker)
      .mockImplementationOnce((key, value) => {
        storage.set(key, value);
      })
      .mockRejectedValueOnce(new Error('queue snapshot failed'));

    const blockingUpdate = store.update([removed, kept]);
    await Promise.resolve();
    const removal = store.updateOwned('editor-a', []);
    const edit = store.updateOwned('editor-b', [queuedMessage('queue-2', 'edited', 'editor-b')]);
    releaseBlocker();

    await blockingUpdate;
    await expect(removal).rejects.toThrow('queue snapshot failed');
    await expect(edit).rejects.toThrow('queue snapshot failed');
    expect(store.list()).toEqual([kept]);
    expect(new QueuedMessageStore(persistence).list()).toMatchObject([kept]);
  });

  it('updates only messages owned by the requesting view', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    await store.update([
      queuedMessage('editor-a', 'from A', 'editor-a'),
      queuedMessage('editor-b', 'from B', 'editor-b'),
    ]);

    await store.updateOwned('editor-b', [
      queuedMessage('editor-a', 'tampered', 'editor-b'),
      queuedMessage('editor-b', 'updated', 'editor-b'),
    ]);

    expect(store.list()).toEqual([
      queuedMessage('editor-a', 'from A', 'editor-a'),
      queuedMessage('editor-b', 'updated', 'editor-b'),
    ]);
  });

  it('transfers a claimed canonical message and rejects the stale lease', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    await store.update([
      queuedMessage('queue-1', 'first', 'editor-a'),
      queuedMessage('queue-2', 'second', 'editor-b'),
    ]);

    const firstClaim = store.claimDispatch('editor-a', 'session-1', 'queue-1', isTestViewEligible);
    expect(firstClaim).not.toBeNull();
    expect(store.claimDispatch('editor-b', 'session-1', 'queue-2', isTestViewEligible)).toBeNull();

    await store.transferOwner('editor-a', 'editor-b');
    await expect(
      store.beginDispatchAdmission(
        'editor-a',
        'session-1',
        'queue-1',
        firstClaim!.lease,
        1,
        'message-1'
      )
    ).resolves.toBe(false);
    expect(
      store.claimDispatch('editor-b', 'session-1', 'queue-1', isTestViewEligible)
    ).not.toBeNull();
  });

  it('keeps an active admission exclusive through view release and ownership transfer', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    await store.update([
      queuedMessage('queue-1', 'first', 'editor-a'),
      queuedMessage('queue-2', 'second', 'editor-b'),
    ]);
    const firstClaim = store.claimDispatch('editor-a', 'session-1', 'queue-1', isTestViewEligible)!;
    await expect(
      store.beginDispatchAdmission(
        'editor-a',
        'session-1',
        'queue-1',
        firstClaim.lease,
        41,
        'message-1'
      )
    ).resolves.toBe(true);

    store.releaseDispatchClaimsForView('editor-a');
    await store.transferOwner('editor-a', 'editor-b');
    expect(store.claimDispatch('editor-b', 'session-1', 'queue-2', isTestViewEligible)).toBeNull();

    await expect(
      store.completeDispatchAdmission('editor-a', 'session-1', 'queue-1', firstClaim.lease, 41)
    ).resolves.toBeUndefined();
    expect(store.list()?.map((message) => message.id)).toEqual(['queue-2']);
    expect(
      store.claimDispatch('editor-b', 'session-1', 'queue-2', isTestViewEligible)
    ).not.toBeNull();
  });

  it('does not let a later owner pass an unavailable canonical message', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    await store.update([
      queuedMessage('queue-1', 'first', 'editor-a'),
      queuedMessage('queue-2', 'second', 'editor-b'),
    ]);

    expect(
      store.claimDispatch('editor-b', 'session-1', 'queue-2', (viewId) => viewId === 'editor-b')
    ).toBeNull();

    await store.transferOwner('editor-a', 'editor-b');
    expect(
      store.claimDispatch('editor-b', 'session-1', 'queue-2', (viewId) => viewId === 'editor-b')
    ).toBeNull();
    expect(
      store.claimDispatch('editor-b', 'session-1', 'queue-1', (viewId) => viewId === 'editor-b')
    ).not.toBeNull();
  });

  it('allows an owned paused or non-head item to be claimed for manual steering', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    await store.update([
      queuedMessage('queue-1', 'first', 'editor-a'),
      { ...queuedMessage('queue-2', 'second', 'editor-a'), paused: true },
    ]);

    expect(store.claimDispatch('editor-a', 'session-1', 'queue-2', isTestViewEligible)).toBeNull();
    expect(
      store.claimDispatch('editor-a', 'session-1', 'queue-2', isTestViewEligible, 'steer')
    ).not.toBeNull();
  });

  it('preserves the admitted message ID across a stale owner snapshot', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    const message = queuedMessage('queue-1', 'first', 'editor-a');
    await store.update([message]);
    const claim = store.claimDispatch('editor-a', 'session-1', 'queue-1', isTestViewEligible)!;
    await expect(
      store.beginDispatchAdmission('editor-a', 'session-1', 'queue-1', claim.lease, 1, 'message-1')
    ).resolves.toBe(true);

    await store.updateOwned('editor-a', [message]);

    expect(store.list()).toEqual([{ ...message, messageId: 'message-1' }]);
  });

  it('does not resurrect a completed item from a stale owner snapshot', async () => {
    const { persistence } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    const message = queuedMessage('queue-1', 'first', 'editor-a');
    await store.update([message]);
    const claim = store.claimDispatch('editor-a', 'session-1', 'queue-1', isTestViewEligible)!;
    await expect(
      store.beginDispatchAdmission('editor-a', 'session-1', 'queue-1', claim.lease, 1, 'message-1')
    ).resolves.toBe(true);
    await store.completeDispatchAdmission('editor-a', 'session-1', 'queue-1', claim.lease, 1);

    await store.updateOwned('editor-a', [message]);

    expect(store.list()).toEqual([]);
  });

  it('retries completion persistence before a restarted store can replay the item', async () => {
    const { persistence, storage } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    await store.update([queuedMessage('queue-1', 'first', 'editor-a')]);
    const claim = store.claimDispatch('editor-a', 'session-1', 'queue-1', isTestViewEligible)!;
    await expect(
      store.beginDispatchAdmission('editor-a', 'session-1', 'queue-1', claim.lease, 1, 'message-1')
    ).resolves.toBe(true);
    expect(
      (storage.get('varro.queuedMessages') as Array<{ messageId?: string }>)[0]?.messageId
    ).toBe('message-1');
    vi.mocked(persistence.set)
      .mockImplementationOnce((key, value) => {
        storage.set(key, value);
      })
      .mockRejectedValueOnce(new Error('transient write failure'));

    await expect(
      store.completeDispatchAdmission('editor-a', 'session-1', 'queue-1', claim.lease, 1)
    ).resolves.toBeUndefined();

    expect(persistence.set).toHaveBeenCalledTimes(6);
    expect(storage.get('varro.queuedMessages')).toEqual([]);
    expect(new QueuedMessageStore(persistence).list()).toEqual([]);
  });

  it('uses a durable tombstone when every completion snapshot attempt fails', async () => {
    const { persistence, storage } = createPersistence();
    const store = new QueuedMessageStore(persistence);
    await store.update([queuedMessage('queue-1', 'first', 'editor-a')]);
    const claim = store.claimDispatch('editor-a', 'session-1', 'queue-1', isTestViewEligible)!;
    await store.beginDispatchAdmission(
      'editor-a',
      'session-1',
      'queue-1',
      claim.lease,
      1,
      'message-1'
    );
    vi.mocked(persistence.set)
      .mockImplementationOnce((key, value) => {
        storage.set(key, value);
      })
      .mockRejectedValue(new Error('disk full'));

    await expect(
      store.completeDispatchAdmission('editor-a', 'session-1', 'queue-1', claim.lease, 1)
    ).resolves.toBeUndefined();

    expect(store.list()).toEqual([]);
    expect(new QueuedMessageStore(persistence).list()).toEqual([]);
  });
});
