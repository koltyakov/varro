/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Persistence values are validated as image arrays before restoration. */
import type { Persistence } from '../shared/persistence';
import type { ClipboardImageSnapshot } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';

const DRAFT_IMAGES_KEY = 'varro.inputDraftImages';

export class DraftImageStore {
  private readonly imagesByView = new Map<string, ClipboardImageSnapshot[]>();
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(DRAFT_IMAGES_KEY);
    if (Array.isArray(stored)) {
      this.imagesByView.set('sidebar', stored as ClipboardImageSnapshot[]);
    } else {
      for (const [viewId, images] of Object.entries(asRecord(stored) ?? {})) {
        if (Array.isArray(images))
          this.imagesByView.set(viewId, images as ClipboardImageSnapshot[]);
      }
    }
  }

  list(viewId = 'sidebar'): ClipboardImageSnapshot[] {
    return this.imagesByView.get(viewId) ?? [];
  }

  setContextFile(
    id: string,
    contextFile: NonNullable<ClipboardImageSnapshot['contextFile']>,
    viewId = 'sidebar'
  ): boolean {
    const images = this.imagesByView.get(viewId);
    const index = images?.findIndex((image) => image.id === id) ?? -1;
    if (!images || index < 0) return false;
    const image = images[index]!;
    const updated = [...images];
    updated[index] = { ...image, contextFile: { ...contextFile } };
    this.imagesByView.set(viewId, updated);
    return true;
  }

  update(images: ClipboardImageSnapshot[], viewId = 'sidebar'): Promise<void> {
    const memoryImages = images.map((image) => ({
      ...image,
      contextFile: image.contextFile ? { ...image.contextFile } : undefined,
    }));
    if (memoryImages.length > 0) this.imagesByView.set(viewId, memoryImages);
    else this.imagesByView.delete(viewId);
    // Temporary context files belong to this extension-host process and cannot
    // be restored after VS Code restarts. Keep them in memory only.
    const snapshot = Object.fromEntries(
      [...this.imagesByView].map(([ownerViewId, ownerImages]) => [
        ownerViewId,
        ownerImages.map(({ contextFile: _contextFile, ...image }) => image),
      ])
    );
    const operation = this.persistenceQueue.then(() =>
      this.imagesByView.size > 0
        ? this.persistence.set(DRAFT_IMAGES_KEY, snapshot)
        : this.persistence.remove(DRAFT_IMAGES_KEY)
    );
    this.persistenceQueue = operation.then(
      () => {},
      () => {}
    );
    return operation;
  }

  dispose(): Promise<void> {
    return this.persistenceQueue;
  }
}
