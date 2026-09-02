/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: Persistence values are validated as image arrays before restoration. */
import type { Persistence } from '../shared/persistence';
import type { ClipboardImageSnapshot } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';

const DRAFT_IMAGES_KEY = 'varro.inputDraftImages';
type DraftImagePersistenceSnapshot = Record<string, Omit<ClipboardImageSnapshot, 'contextFile'>[]>;
type PendingPersistence = {
  promise: Promise<void>;
  reject: (error: Error) => void;
  resolve: () => void;
  snapshot: DraftImagePersistenceSnapshot | null;
};

export class DraftImageStore {
  private readonly imagesByView = new Map<string, ClipboardImageSnapshot[]>();
  private pendingPersistence: PendingPersistence | undefined;
  private persistenceDrain: Promise<void> | undefined;
  private persistenceDraining = false;

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
    return this.enqueuePersistence(this.imagesByView.size > 0 ? snapshot : null);
  }

  async dispose(): Promise<void> {
    while (this.persistenceDrain || this.pendingPersistence) {
      if (!this.persistenceDrain) this.startPersistenceDrain();
      await this.persistenceDrain;
    }
  }

  private enqueuePersistence(snapshot: DraftImagePersistenceSnapshot | null): Promise<void> {
    if (this.pendingPersistence) {
      this.pendingPersistence.snapshot = snapshot;
      return this.pendingPersistence.promise;
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.pendingPersistence = { promise, reject, resolve, snapshot };
    this.startPersistenceDrain();
    return promise;
  }

  private startPersistenceDrain() {
    if (this.persistenceDraining) return;
    this.persistenceDraining = true;
    const drain = this.drainPersistence();
    this.persistenceDrain = drain;
    const finish = () => {
      if (this.persistenceDrain !== drain) return;
      this.persistenceDrain = undefined;
      this.persistenceDraining = false;
      if (this.pendingPersistence) this.startPersistenceDrain();
    };
    void drain.then(finish, finish);
  }

  private async drainPersistence() {
    while (this.pendingPersistence) {
      const pending = this.pendingPersistence;
      this.pendingPersistence = undefined;
      try {
        if (pending.snapshot) await this.persistence.set(DRAFT_IMAGES_KEY, pending.snapshot);
        else await this.persistence.remove(DRAFT_IMAGES_KEY);
        pending.resolve();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        pending.reject(failure);
      }
    }
  }
}
