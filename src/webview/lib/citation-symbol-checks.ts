import { VARRO_API_ENDPOINTS } from '../../shared/protocol';
import { CITATION_SYMBOL_PENDING } from '../../shared/citation-symbol';
import type { CitationSymbolTarget } from '../../shared/citation-symbol';
import { apiCall } from './bridge';
import { CitationChecks } from './citation-path-checks';
import type { CitationPathScope } from './citation-path-checks';
import { isAbsolutePath } from './path-display';
import { asRecord, isNumber, isString } from './runtime-values';

type SymbolCheckValue = CitationSymbolTarget | typeof CITATION_SYMBOL_PENDING;

function isSymbolTarget(value: unknown): value is CitationSymbolTarget {
  const target = asRecord(value);
  return (
    isString(target?.path) &&
    isAbsolutePath(target.path) &&
    isNumber(target.line) &&
    Number.isSafeInteger(target.line) &&
    target.line > 0
  );
}

function isSymbolCheckValue(value: unknown): value is SymbolCheckValue {
  return value === CITATION_SYMBOL_PENDING || isSymbolTarget(value);
}

const citationSymbolChecks = new CitationChecks<SymbolCheckValue>(
  async ({ paths, ...scope }, signal) => {
    const values = await apiCall<unknown>(
      'POST',
      VARRO_API_ENDPOINTS.citationSymbols,
      { ...scope, symbols: paths },
      { signal, retries: 0, timeoutMs: 3_000 }
    );
    if (!Array.isArray(values)) throw new Error('Invalid citation symbol response');
    return values.map((value) => (isSymbolCheckValue(value) ? value : null));
  },
  isSymbolCheckValue,
  32,
  // Pending lookups are never cached, so the next check asks the extension again.
  (value) => (value === CITATION_SYMBOL_PENDING ? 0 : value ? 15_000 : 1_000)
);

type LookupEntry = {
  nodes: Set<Element>;
  expiresAt: number;
  value?: CitationSymbolTarget | null;
  promise: Promise<CitationSymbolTarget | null>;
};

/**
 * One backoff chain per symbol and scope, shared by every rendered node and remount.
 * Each attempt waits on the extension's in-flight provider call, so slow lookups can
 * still settle, while total polling stays bounded and stops once no node is attached.
 */
export class CitationSymbolLookups {
  static readonly RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
  /** Re-renders after an exhausted chain stay inert instead of restarting it immediately. */
  static readonly EXHAUSTED_TTL_MS = 30_000;
  private readonly entries = new Map<string, LookupEntry>();
  private readonly waits = new Map<ReturnType<typeof setTimeout>, () => void>();
  private generation = 0;

  constructor(
    private readonly checks: CitationChecks<SymbolCheckValue> = citationSymbolChecks,
    private readonly retryDelaysMs = CitationSymbolLookups.RETRY_DELAYS_MS
  ) {}

  peek(symbol: string, scope: CitationPathScope): CitationSymbolTarget | null | undefined {
    const entry = this.entries.get(this.key(symbol, scope));
    return entry && entry.expiresAt > Date.now() ? entry.value : undefined;
  }

  resolve(
    symbol: string,
    scope: CitationPathScope,
    node: Element
  ): Promise<CitationSymbolTarget | null> {
    const key = this.key(symbol, scope);
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.value === undefined) existing.nodes.add(node);
      return existing.promise;
    }
    // Bound retained state; running chains are never evicted.
    if (this.entries.size >= 2048) {
      const settled = [...this.entries].find(([, entry]) => entry.value !== undefined);
      if (!settled) return Promise.resolve(null);
      this.entries.delete(settled[0]);
    }
    const entry: LookupEntry = {
      nodes: new Set([node]),
      expiresAt: Infinity,
      promise: Promise.resolve(null),
    };
    entry.promise = this.run(symbol, scope, entry, this.generation).then((result) => {
      const value = result === CITATION_SYMBOL_PENDING || result === undefined ? null : result;
      entry.nodes.clear();
      if (this.entries.get(key) !== entry) return value;
      entry.value = value;
      if (result === undefined) this.entries.delete(key);
      else
        entry.expiresAt =
          Date.now() +
          (result === CITATION_SYMBOL_PENDING
            ? CitationSymbolLookups.EXHAUSTED_TTL_MS
            : value
              ? 15_000
              : 1_000);
      return value;
    });
    this.entries.set(key, entry);
    return entry.promise;
  }

  clear(): void {
    this.generation += 1;
    for (const [timer, done] of this.waits) {
      clearTimeout(timer);
      done();
    }
    this.waits.clear();
    this.entries.clear();
    this.checks.clear();
  }

  /** Resolves `undefined` when abandoned, and pending when the retry budget is spent. */
  private async run(
    symbol: string,
    scope: CitationPathScope,
    entry: LookupEntry,
    generation: number
  ): Promise<SymbolCheckValue | null | undefined> {
    for (let attempt = 0; ; attempt++) {
      const value = await this.checks.check(symbol, scope);
      if (generation !== this.generation) return undefined;
      const delay = this.retryDelaysMs[attempt];
      if (value !== CITATION_SYMBOL_PENDING || delay === undefined) return value;
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          this.waits.delete(timer);
          done();
        }, delay);
        this.waits.set(timer, done);
      });
      if (generation !== this.generation) return undefined;
      // Unmounted or replaced rows stop polling; a later remount starts a fresh chain.
      if (![...entry.nodes].some((node) => node.isConnected)) return undefined;
    }
  }

  private key(symbol: string, scope: CitationPathScope): string {
    return JSON.stringify([scope.sessionID, scope.directory, symbol]);
  }
}

export const citationSymbolLookups = new CitationSymbolLookups();
