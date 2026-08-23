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

  update(images: ClipboardImageSnapshot[], viewId = 'sidebar'): Promise<void> {
    // Temporary context files are owned by one extension-host process and cannot
    // be restored after VS Code restarts. They will be recreated if needed.
    const persistedImages = images.map(({ contextFile: _contextFile, ...image }) => image);
    if (persistedImages.length > 0) this.imagesByView.set(viewId, persistedImages);
    else this.imagesByView.delete(viewId);
    const snapshot = Object.fromEntries(this.imagesByView);
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
