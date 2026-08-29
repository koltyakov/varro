/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- Shared OpenCode responses remain opaque until each RestProxy validates and projects its endpoint-specific payload. */
type WorkspaceStatusCatalog = {
  loadedAt: number;
  sessions: unknown[];
};

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
    if (!options?.force) {
      const cached = this.catalogs.get(workspaceIdentity);
      if (cached) return raceAgainstAbort(Promise.resolve(cached), options?.signal);
    }

    let request = this.catalogRequests.get(workspaceIdentity);
    if (!request) {
      const currentRequest = Promise.resolve()
        .then(load)
        .then((value) => {
          if (!Array.isArray(value)) throw new Error('Malformed session list response');
          const catalog = { loadedAt: Date.now(), sessions: value };
          this.catalogs.set(workspaceIdentity, catalog);
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
