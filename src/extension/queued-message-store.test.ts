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

  it('serializes writes so the newest queue snapshot wins', async () => {
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
    const latestUpdate = store.update(latest);
    await Promise.resolve();
    expect(persistence.set).toHaveBeenCalledOnce();

    releaseFirstWrite?.();
    await Promise.all([firstUpdate, latestUpdate]);

    expect(storage.get('varro.queuedMessages')).toEqual(latest);
  });
});
