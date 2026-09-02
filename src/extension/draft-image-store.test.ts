/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The in-memory storage fake accepts the same opaque values as VS Code's Memento API. */
import { describe, expect, it, vi } from 'vitest';
import type { Persistence } from '../shared/persistence';
import { DraftImageStore } from './draft-image-store';

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

function draftImage(id: string) {
  return {
    id,
    url: `data:image/png;base64,${id}`,
    mime: 'image/png',
    filename: `${id}.png`,
    size: 1,
  };
}

describe('DraftImageStore', () => {
  it('restores pasted images after the host is recreated', async () => {
    const { persistence } = createPersistence();
    const store = new DraftImageStore(persistence);

    await store.update([
      {
        id: 'image-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'pasted-image-1.png',
        size: 1,
        contextFile: {
          path: '/tmp/current-host/image.png',
          relativePath: 'image.png',
          type: 'file',
        },
      },
    ]);

    expect(store.list()[0]?.contextFile?.path).toBe('/tmp/current-host/image.png');

    expect(new DraftImageStore(persistence).list()).toEqual([
      {
        id: 'image-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'pasted-image-1.png',
        size: 1,
      },
    ]);
  });

  it('removes persistence when the draft has no images', async () => {
    const { persistence, storage } = createPersistence();
    storage.set('varro.inputDraftImages', [{ id: 'old' }]);

    await new DraftImageStore(persistence).update([]);

    expect(storage.has('varro.inputDraftImages')).toBe(false);
  });

  it('keeps image drafts isolated by webview', async () => {
    const { persistence } = createPersistence();
    const store = new DraftImageStore(persistence);
    const sidebarImage = {
      id: 'sidebar-image',
      url: 'data:image/png;base64,AA==',
      mime: 'image/png',
      filename: 'sidebar.png',
      size: 1,
    };
    const editorImage = { ...sidebarImage, id: 'editor-image', filename: 'editor.png' };

    await store.update([sidebarImage]);
    await store.update([editorImage], 'editor-1');

    const restored = new DraftImageStore(persistence);
    expect(restored.list()).toEqual([sidebarImage]);
    expect(restored.list('editor-1')).toEqual([editorImage]);
  });

  it('keeps temporary image paths in memory without rewriting the base64 snapshot', async () => {
    const { persistence } = createPersistence();
    const store = new DraftImageStore(persistence);
    await store.update([
      {
        id: 'image-1',
        url: 'data:image/png;base64,AA==',
        mime: 'image/png',
        filename: 'image.png',
        size: 1,
      },
    ]);
    vi.mocked(persistence.set).mockClear();

    expect(
      store.setContextFile('image-1', {
        path: '/tmp/current-host/image.png',
        relativePath: 'image.png',
        type: 'file',
      })
    ).toBe(true);

    expect(store.list()[0]?.contextFile?.path).toBe('/tmp/current-host/image.png');
    expect(persistence.set).not.toHaveBeenCalled();
  });

  it('coalesces snapshots queued behind a slow persistence write', async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const persisted: unknown[] = [];
    const persistence: Persistence = {
      get: () => undefined,
      set: vi
        .fn<(key: string, value: unknown) => void | Promise<void>>()
        .mockImplementationOnce(async (_key, value) => {
          await firstWrite;
          persisted.push(value);
        })
        .mockImplementation((_key, value) => {
          persisted.push(value);
        }),
      remove: vi.fn(),
    };
    const store = new DraftImageStore(persistence);
    const first = store.update([draftImage('first')]);
    await Promise.resolve();
    const second = store.update([draftImage('second')]);
    const latest = store.update([draftImage('latest')]);
    expect(persistence.set).toHaveBeenCalledOnce();

    releaseFirstWrite();
    await Promise.all([first, second, latest]);

    expect(persistence.set).toHaveBeenCalledTimes(2);
    expect(persisted.at(-1)).toEqual({
      sidebar: [draftImage('latest')],
    });
  });

  it('does not retain a waiter for every replacement snapshot', async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const persistence: Persistence = {
      get: () => undefined,
      set: vi
        .fn<(key: string, value: unknown) => void | Promise<void>>()
        .mockImplementationOnce(() => firstWrite),
      remove: vi.fn(),
    };
    const store = new DraftImageStore(persistence);
    const first = store.update([draftImage('first')]);
    await Promise.resolve();
    const pending = store.update([draftImage('pending')]);
    const replacements = Array.from({ length: 1_000 }, (_, index) =>
      store.update([draftImage(`replacement-${index}`)])
    );

    expect(new Set(replacements)).toEqual(new Set([pending]));
    expect(persistence.set).toHaveBeenCalledOnce();

    releaseFirstWrite();
    await Promise.all([first, pending, ...replacements, store.dispose()]);
    expect(persistence.set).toHaveBeenCalledTimes(2);
  });

  it('rejects every coalesced update when the shared snapshot write fails', async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const persistence: Persistence = {
      get: () => undefined,
      set: vi
        .fn<(key: string, value: unknown) => void | Promise<void>>()
        .mockImplementationOnce(() => firstWrite)
        .mockRejectedValueOnce(new Error('disk full')),
      remove: vi.fn(),
    };
    const store = new DraftImageStore(persistence);
    const first = store.update([draftImage('first')]);
    await Promise.resolve();
    const pending = store.update([draftImage('pending')]);
    const latest = store.update([draftImage('latest')]);

    expect(latest).toBe(pending);
    releaseFirstWrite();
    await first;
    await expect(pending).rejects.toThrow('disk full');
    await expect(latest).rejects.toThrow('disk full');
  });

  it('waits for an update queued during persistence settlement before disposal completes', async () => {
    let releaseSecondWrite!: () => void;
    const secondWrite = new Promise<void>((resolve) => {
      releaseSecondWrite = resolve;
    });
    const persistence: Persistence = {
      get: () => undefined,
      set: vi
        .fn<(key: string, value: unknown) => void | Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => secondWrite),
      remove: vi.fn(),
    };
    const store = new DraftImageStore(persistence);
    const firstImage = {
      id: 'first',
      url: 'data:image/png;base64,first',
      mime: 'image/png',
      filename: 'first.png',
      size: 1,
    };
    await store.update([firstImage]);
    const secondUpdate = store.update([{ ...firstImage, id: 'second', filename: 'second.png' }]);
    let disposed = false;
    const disposal = store.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();

    expect(disposed).toBe(false);
    releaseSecondWrite();
    await Promise.all([secondUpdate, disposal]);
    expect(disposed).toBe(true);
  });
});
