/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Persistence values are validated as image arrays before restoration. */
import type { Persistence } from '../shared/persistence';
import type { ClipboardImageSnapshot } from '../shared/protocol';

const DRAFT_IMAGES_KEY = 'varro.inputDraftImages';

export class DraftImageStore {
  private images: ClipboardImageSnapshot[];
  private persistenceQueue: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: Persistence) {
    const stored = persistence.get<unknown>(DRAFT_IMAGES_KEY);
    this.images = Array.isArray(stored) ? (stored as ClipboardImageSnapshot[]) : [];
  }

  list(): ClipboardImageSnapshot[] {
    return this.images;
  }

  update(images: ClipboardImageSnapshot[]): Promise<void> {
    // Temporary context files are owned by one extension-host process and cannot
    // be restored after VS Code restarts. They will be recreated if needed.
    this.images = images.map(({ contextFile: _contextFile, ...image }) => image);
    const operation = this.persistenceQueue.then(() =>
      this.images.length > 0
        ? this.persistence.set(DRAFT_IMAGES_KEY, this.images)
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
