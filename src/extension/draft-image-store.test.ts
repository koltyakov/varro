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
});
