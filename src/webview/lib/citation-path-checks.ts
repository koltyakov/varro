import { VARRO_API_ENDPOINTS } from '../../shared/protocol';
import { isAbsolutePath } from './path-display';
import { apiCall } from './bridge';
import { isString } from './runtime-values';

export type CitationPathScope = { directory?: string; sessionID?: string };
type CheckRequest = CitationPathScope & { paths: string[] };
type CheckResponse = Array<string | null>;

async function requestChecks(body: CheckRequest, signal: AbortSignal): Promise<CheckResponse> {
  const values = await apiCall<unknown>('POST', VARRO_API_ENDPOINTS.citationPaths, body, {
    signal,
    retries: 0,
    timeoutMs: 3_000,
  });
  if (!Array.isArray(values)) throw new Error('Invalid citation check response');
  return values.map((value) => (isString(value) && isAbsolutePath(value) ? value : null));
}
type CheckEntry = {
  key: string;
  path: string;
  scope: CitationPathScope;
  scopeKey: string;
  value?: string | null;
  expiresAt: number;
  promise: Promise<string | null>;
  resolve: (path: string | null) => void;
};

/** Batch metadata requests after rendering; share results across rows and remounts. */
export class CitationPathChecks {
  private readonly entries = new Map<string, CheckEntry>();
  private queue: CheckEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: AbortController | undefined;

  constructor(
    private readonly request: (
      body: CheckRequest,
      signal: AbortSignal
    ) => Promise<CheckResponse> = requestChecks
  ) {}

  peek(path: string, scope: CitationPathScope): string | null | undefined {
    const entry = this.entries.get(this.key(path, scope));
    return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
  }

  check(path: string, scope: CitationPathScope): Promise<string | null> {
    const key = this.key(path, scope);
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) return existing.promise;
    // Bound retained state even when a transcript contains thousands of unique paths.
    if (this.entries.size >= 2048) {
      let oldest: CheckEntry | undefined;
      for (const entry of this.entries.values()) {
        if (entry.value !== undefined) {
          oldest = entry;
          break;
        }
      }
      if (!oldest) return Promise.resolve(null);
      this.entries.delete(oldest.key);
    }
    let resolve!: CheckEntry['resolve'];
    const promise = new Promise<string | null>((done) => {
      resolve = done;
    });
    const entry: CheckEntry = {
      key,
      path,
      scope,
      scopeKey: JSON.stringify([scope.sessionID, scope.directory]),
      expiresAt: Infinity,
      promise,
      resolve,
    };
    this.entries.set(key, entry);
    this.queue.push(entry);
    this.schedule();
    return promise;
  }

  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.active?.abort();
    this.active = undefined;
    for (const entry of this.entries.values()) entry.resolve(null);
    this.entries.clear();
    this.queue = [];
  }

  private key(path: string, scope: CitationPathScope): string {
    return JSON.stringify([scope.sessionID, scope.directory, path]);
  }

  private schedule(): void {
    if (this.active || this.timer !== undefined || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 0);
  }

  private async flush(): Promise<void> {
    const first = this.queue[0];
    if (!first) return;
    const batch = this.queue.filter((entry) => entry.scopeKey === first.scopeKey).slice(0, 64);
    const selected = new Set(batch);
    this.queue = this.queue.filter((entry) => !selected.has(entry));
    const controller = new AbortController();
    this.active = controller;
    let values: CheckResponse | undefined;
    try {
      values = await this.request(
        { ...first.scope, paths: batch.map((entry) => entry.path) },
        controller.signal
      );
    } catch {
      // Transport failures leave citations inert and can be retried after a short cache expiry.
    }
    if (this.active !== controller) return;
    const response = values?.length === batch.length ? values : undefined;
    for (const [index, entry] of batch.entries()) {
      const value = response?.[index];
      entry.value = isString(value) && isAbsolutePath(value) ? value : null;
      entry.expiresAt = Date.now() + (entry.value ? 15_000 : 1_000);
      entry.resolve(entry.value);
    }
    this.active = undefined;
    this.schedule();
  }
}

export const citationPathChecks = new CitationPathChecks();
