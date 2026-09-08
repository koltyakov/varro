/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Shared OpenCode responses remain opaque until each RestProxy validates and projects its endpoint-specific payload. */
type WorkspaceStatusCatalog = {
  loadedAt: number;
  sessions: unknown[];
};

const STATUS_CATALOG_MAX_AGE_MS = 5_000;

export class WorkspaceSessionStatusCoordinator {
  private readonly statusRequests = new Map<string, Promise<unknown>>();
  private readonly catalogRequests = new Map<string, Promise<WorkspaceStatusCatalog>>();
  private readonly catalogs = new Map<string, WorkspaceStatusCatalog>();

  requestStatus(
    workspaceIdentity: string,
    load: () => Promise<unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    let request = this.statusRequests.get(workspaceIdentity);
    if (!request) {
      const currentRequest = Promise.resolve().then(load);
      request = currentRequest;
      this.statusRequests.set(workspaceIdentity, currentRequest);
      void currentRequest.then(
        () => this.deleteCurrent(this.statusRequests, workspaceIdentity, currentRequest),
        () => this.deleteCurrent(this.statusRequests, workspaceIdentity, currentRequest)
      );
    }
    return raceAgainstAbort(request, signal);
  }

  requestCatalog(
    workspaceIdentity: string,
    load: () => Promise<unknown>,
    options?: { force?: boolean; signal?: AbortSignal }
  ): Promise<WorkspaceStatusCatalog> {
    let request = this.catalogRequests.get(workspaceIdentity);
    if (!request && !options?.force) {
      const cached = this.catalogs.get(workspaceIdentity);
      if (cached && Date.now() - cached.loadedAt < STATUS_CATALOG_MAX_AGE_MS) {
        return raceAgainstAbort(Promise.resolve(cached), options?.signal);
      }
    }

    if (!request) {
      const currentRequest = Promise.resolve()
        .then(load)
        .then((value) => {
          if (!Array.isArray(value)) throw new Error('Malformed session list response');
          const catalog = { loadedAt: Date.now(), sessions: value };
          // Invalidated reads may finish for existing callers, but must not restore the cache.
          if (this.catalogRequests.get(workspaceIdentity) === currentRequest) {
            this.catalogs.set(workspaceIdentity, catalog);
          }
          return catalog;
        });
      request = currentRequest;
      this.catalogRequests.set(workspaceIdentity, currentRequest);
      void currentRequest.then(
        () => this.deleteCurrent(this.catalogRequests, workspaceIdentity, currentRequest),
        () => this.deleteCurrent(this.catalogRequests, workspaceIdentity, currentRequest)
      );
    }
    return raceAgainstAbort(request, options?.signal);
  }

  clearCatalogsOutside(workspaceIdentities: ReadonlySet<string>) {
    for (const identity of this.catalogs.keys()) {
      if (!workspaceIdentities.has(identity)) this.catalogs.delete(identity);
    }
    for (const identity of this.catalogRequests.keys()) {
      if (!workspaceIdentities.has(identity)) this.catalogRequests.delete(identity);
    }
  }

  clearCatalogs() {
    this.catalogs.clear();
    this.catalogRequests.clear();
  }

  private deleteCurrent<T>(requests: Map<string, Promise<T>>, key: string, request: Promise<T>) {
    if (requests.get(key) === request) requests.delete(key);
  }
}

function raceAgainstAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('API call aborted'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}
