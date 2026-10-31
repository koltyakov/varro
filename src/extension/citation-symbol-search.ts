import * as vscode from 'vscode';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CITATION_SYMBOL_PENDING, parseCitationSymbol } from '../shared/citation-symbol';
import type { CitationSymbolResult, CitationSymbolTarget } from '../shared/citation-symbol';

type CacheEntry = {
  expiresAt: number;
  probe: boolean;
  result: Promise<CitationSymbolTarget | null>;
};

/** One uncancellable provider call, including its file stat. */
type ProviderCall = {
  probe: boolean;
  overdue: boolean;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Provider-backed lookup only. Never scan the workspace for a guessed symbol filename.
 *
 * executeWorkspaceSymbolProvider runs providers with CancellationToken.None, so a call
 * cannot be stopped once started. Calls hold one of SLOT_LIMIT slots until they settle or
 * their lease expires; expired calls move to a capped abandoned set and keep running.
 * When an expired call cannot be abandoned, a circuit breaker stops new calls until any
 * outstanding call settles, with one probe per cooldown when a slot is free. Outstanding
 * calls therefore never exceed SLOT_LIMIT + ABANDONED_LIMIT.
 */
export class CitationSymbolSearch implements vscode.Disposable {
  static readonly SLOT_LIMIT = 2;
  static readonly ABANDONED_LIMIT = 2;
  static readonly LEASE_MS = 20_000;
  static readonly INITIAL_COOLDOWN_MS = 60_000;
  static readonly MAX_COOLDOWN_MS = 600_000;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly running = new Set<ProviderCall>();
  private readonly abandoned = new Set<ProviderCall>();
  /** Set while the breaker is open; new calls wait until then, and only as a probe. */
  private reopenAt: number | undefined;
  private cooldownMs = CitationSymbolSearch.INITIAL_COOLDOWN_MS;
  private probing = false;
  private disposed = false;

  async find(
    symbols: readonly string[],
    directory: string | undefined,
    signal?: AbortSignal
  ): Promise<CitationSymbolResult[]> {
    const results: CitationSymbolResult[] = symbols.map(() => null);
    if (!directory || !isAbsolute(directory) || this.disposed) return results;
    const root = resolve(directory);
    const deadline = Date.now() + 2_000;
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(CitationSymbolSearch.SLOT_LIMIT, symbols.length) },
        async () => {
          while (next < symbols.length && !this.disposed) {
            signal?.throwIfAborted();
            const index = next++;
            const name = parseCitationSymbol(symbols[index]!);
            if (!name) continue;
            // Unattempted and unsettled lookups are not misses; let the caller retry them.
            if (Date.now() >= deadline) {
              results[index] = CITATION_SYMBOL_PENDING;
              continue;
            }
            const key = JSON.stringify([root, name]);
            let entry = this.cache.get(key);
            if (!entry || entry.expiresAt <= Date.now()) {
              const admission = this.admit();
              if (admission === 'busy') {
                results[index] = CITATION_SYMBOL_PENDING;
                continue;
              }
              // An open breaker answers definitively so webview retry chains stop.
              if (admission === 'open') continue;
              entry = this.start(name, root, key, admission === 'probe');
            } else if (
              entry.expiresAt === Infinity &&
              this.reopenAt !== undefined &&
              !entry.probe
            ) {
              continue;
            }
            results[index] = await this.withDeadline(entry.result, deadline, signal);
          }
        }
      )
    );
    signal?.throwIfAborted();
    return results;
  }

  private admit(): 'start' | 'probe' | 'busy' | 'open' {
    const slotFree = this.running.size < CitationSymbolSearch.SLOT_LIMIT;
    if (this.reopenAt === undefined) return slotFree ? 'start' : 'busy';
    return slotFree && !this.probing && Date.now() >= this.reopenAt ? 'probe' : 'open';
  }

  private start(name: string, root: string, key: string, probe: boolean): CacheEntry {
    const call: ProviderCall = {
      probe,
      overdue: false,
      timer: setTimeout(() => this.expire(call), CitationSymbolSearch.LEASE_MS),
    };
    this.running.add(call);
    if (probe) this.probing = true;
    const result = this.lookup(name, root).finally(() => this.settle(call));
    const entry: CacheEntry = { expiresAt: Infinity, probe, result };
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
    void result.then((value) => {
      // A late result is still cached, so retries pick it up without another call.
      entry.expiresAt = Date.now() + (value ? 15_000 : 1_000);
      entry.probe = false;
    });
    return entry;
  }

  private expire(call: ProviderCall): void {
    call.overdue = true;
    if (this.abandoned.size < CitationSymbolSearch.ABANDONED_LIMIT) {
      this.running.delete(call);
      this.abandoned.add(call);
    }
    if (call.probe) {
      this.probing = false;
      this.open();
    } else if (this.running.has(call) && this.reopenAt === undefined) {
      // The call cannot be abandoned without exceeding the outstanding-call cap.
      this.open();
    }
  }

  private settle(call: ProviderCall): void {
    clearTimeout(call.timer);
    this.running.delete(call);
    this.abandoned.delete(call);
    if (call.probe) this.probing = false;
    // Any settled call, including a failure, shows the providers respond again.
    if (this.reopenAt !== undefined) {
      this.reopenAt = undefined;
      this.cooldownMs = CitationSymbolSearch.INITIAL_COOLDOWN_MS;
    }
  }

  private open(): void {
    this.reopenAt = Date.now() + this.cooldownMs;
    this.cooldownMs = Math.min(this.cooldownMs * 2, CitationSymbolSearch.MAX_COOLDOWN_MS);
  }

  private async lookup(name: string, root: string): Promise<CitationSymbolTarget | null> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        name
      );
      if (this.disposed || !symbols || symbols.length > 1_000) return null;
      const matches = new Map<string, CitationSymbolTarget>();
      for (const symbol of symbols) {
        if (symbol.name !== name || symbol.location.uri.scheme !== 'file') continue;
        const path = resolve(symbol.location.uri.fsPath);
        const fromRoot = relative(root, path);
        if (
          !fromRoot ||
          isAbsolute(fromRoot) ||
          fromRoot === '..' ||
          fromRoot.startsWith(`..${sep}`)
        )
          continue;
        const { line, character } = symbol.location.range.start;
        if (
          !Number.isSafeInteger(line) ||
          line < 0 ||
          !Number.isSafeInteger(character) ||
          character < 0
        )
          continue;
        matches.set(JSON.stringify([path, line, character]), { path, line: line + 1 });
      }
      if (matches.size !== 1) return null;
      const target = matches.values().next().value!;
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(target.path));
      return stat.type & vscode.FileType.File ? target : null;
    } catch {
      // Missing language support, inaccessible files, and provider failures leave code inert.
      return null;
    }
  }

  private withDeadline(
    result: Promise<CitationSymbolTarget | null>,
    deadline: number,
    signal?: AbortSignal
  ): Promise<CitationSymbolResult> {
    return new Promise((done) => {
      const finish = (value: CitationSymbolResult) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        done(value);
      };
      const abort = () => finish(CITATION_SYMBOL_PENDING);
      const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      void result.then(finish);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const call of [...this.running, ...this.abandoned]) clearTimeout(call.timer);
    this.cache.clear();
  }
}
