import * as vscode from 'vscode';
import { readdir } from 'node:fs/promises';
import { posix, relative } from 'node:path';
import { asRecord, isString } from '../shared/type-utils';

const SEARCH_TIMEOUT_MS = 5_000;
const MAX_ENTRIES = 20_000;
const MAX_RESULTS = 100;
const DEFAULT_EXCLUDES = Object.fromEntries(
  ['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out'].map((name) => [
    `**/${name}/**`,
    true,
  ])
);

type Exclusion = { pattern: string; when?: string };

class SearchBudget {
  readonly source = new vscode.CancellationTokenSource();
  private readonly deadline = Date.now() + SEARCH_TIMEOUT_MS;
  private readonly timer = setTimeout(() => this.source.cancel(), SEARCH_TIMEOUT_MS);
  private remainingEntries = MAX_ENTRIES;

  get cancelled(): boolean {
    if (Date.now() >= this.deadline) this.source.cancel();
    return this.source.token.isCancellationRequested;
  }

  visitEntry(): boolean {
    if (this.remainingEntries-- <= 0) this.source.cancel();
    return !this.cancelled;
  }

  async wait<T>(operation: () => Thenable<T>): Promise<T | undefined> {
    if (this.cancelled) return undefined;
    let subscription: vscode.Disposable | undefined;
    const cancelled = new Promise<undefined>((resolve) => {
      subscription = this.source.token.onCancellationRequested(() => resolve(undefined));
    });
    try {
      // Providers need not settle promptly when cancelled. Ignore their late result,
      // but keep a rejection handler attached through the race.
      return await Promise.race([operation(), cancelled]);
    } finally {
      subscription?.dispose();
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.source.dispose();
  }
}

/** Private discovery for chat citations, separate from exact-path resolution. */
export class CitationFileSearch implements vscode.Disposable {
  private activeBudget: SearchBudget | undefined;
  private disposed = false;

  async find(suffix: string, roots: readonly vscode.Uri[]): Promise<vscode.Uri[] | null> {
    if (this.disposed) return null;
    this.activeBudget?.source.cancel();
    const budget = new SearchBudget();
    this.activeBudget = budget;
    const matches: vscode.Uri[] = [];
    try {
      for (const root of roots) {
        if (budget.cancelled) return null;
        const scope = vscode.workspace.getWorkspaceFolder(root)?.uri ?? root;
        const exclusions = this.getExclusions(scope);
        const patterns = exclusions.filter((rule) => !rule.when).map((rule) => rule.pattern);
        // The merged rules already include file defaults and search overrides.
        // Do not let findFiles reapply file excludes disabled by search.exclude.
        const exclude =
          patterns.length === 0
            ? null
            : new vscode.RelativePattern(scope, `{${patterns.join(',')}}`);
        let candidates: vscode.Uri[] | undefined;
        try {
          candidates = await budget.wait(() =>
            vscode.workspace.findFiles(
              new vscode.RelativePattern(root, `**/${suffix}`),
              exclude,
              MAX_RESULTS,
              budget.source.token
            )
          );
        } catch {
          // Only an unavailable index warrants traversal. A successful empty
          // search is authoritative, including when exclusions hide a match.
          if (!budget.cancelled)
            candidates = await this.walk(root, scope, suffix, exclusions, budget);
        }
        if (!candidates || budget.cancelled) return null;
        for (const candidate of candidates) {
          if (!(await this.isExcluded(candidate, false, scope, exclusions, budget))) {
            matches.push(candidate);
          }
          if (budget.cancelled) return null;
          if (matches.length >= MAX_RESULTS) return matches;
        }
      }
      return matches;
    } finally {
      if (this.activeBudget === budget) this.activeBudget = undefined;
      budget.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.activeBudget?.source.cancel();
  }

  private getExclusions(scope: vscode.Uri): Exclusion[] {
    const values = {
      ...DEFAULT_EXCLUDES,
      ...asRecord(vscode.workspace.getConfiguration('files', scope).get('exclude')),
      ...asRecord(vscode.workspace.getConfiguration('search', scope).get('exclude')),
    };
    return Object.entries(values).flatMap(([pattern, value]) => {
      if (value === true) return [{ pattern }];
      const when = asRecord(value)?.when;
      return isString(when) ? [{ pattern, when }] : [];
    });
  }

  private async readDirectory(
    uri: vscode.Uri,
    budget: SearchBudget
  ): Promise<[string, vscode.FileType][] | undefined> {
    if (budget.cancelled) return undefined;
    try {
      return await budget.wait(() => vscode.workspace.fs.readDirectory(uri));
    } catch {
      if (budget.cancelled) return undefined;
      try {
        const entries = await budget.wait(() => readdir(uri.fsPath, { withFileTypes: true }));
        return entries?.map((entry) => [
          entry.name,
          entry.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File,
        ]);
      } catch {
        // Unreadable directories cannot contribute candidates.
        return [];
      }
    }
  }

  private async isExcluded(
    uri: vscode.Uri,
    directory: boolean,
    scope: vscode.Uri,
    exclusions: readonly Exclusion[],
    budget: SearchBudget,
    siblings?: readonly string[]
  ): Promise<boolean> {
    const path = relative(scope.fsPath, uri.fsPath).replace(/\\/g, '/');
    const segments = path.split('/');
    for (let length = segments.length; length > 0; length--) {
      const candidate = segments.slice(0, length).join('/');
      const isDirectory = length < segments.length || directory;
      for (const rule of exclusions) {
        if (
          !posix.matchesGlob(candidate, rule.pattern) &&
          !(isDirectory && posix.matchesGlob(`${candidate}/`, rule.pattern))
        )
          continue;
        if (!rule.when) return true;
        const siblingPattern = rule.when.replaceAll('$(basename)', posix.parse(candidate).name);
        const names =
          length === segments.length && siblings
            ? siblings
            : (
                await this.readDirectory(
                  vscode.Uri.joinPath(scope, posix.dirname(candidate)),
                  budget
                )
              )?.map(([name]) => name);
        if (names?.some((name) => posix.matchesGlob(name, siblingPattern))) return true;
      }
    }
    return false;
  }

  private async walk(
    root: vscode.Uri,
    scope: vscode.Uri,
    suffix: string,
    exclusions: readonly Exclusion[],
    budget: SearchBudget
  ): Promise<vscode.Uri[] | undefined> {
    const pending = [root];
    const matches: vscode.Uri[] = [];
    for (let index = 0; index < pending.length; index++) {
      const directory = pending[index]!;
      if (await this.isExcluded(directory, true, scope, exclusions, budget)) continue;
      const entries = await this.readDirectory(directory, budget);
      if (!entries || budget.cancelled) return undefined;
      const siblings = entries.map(([name]) => name);
      for (const [name, type] of entries) {
        if (!budget.visitEntry()) return undefined;
        const uri = vscode.Uri.joinPath(directory, name);
        const isDirectory = Boolean(type & vscode.FileType.Directory);
        if (!isDirectory && !uri.fsPath.replace(/\\/g, '/').endsWith(`/${suffix}`)) continue;
        if (await this.isExcluded(uri, isDirectory, scope, exclusions, budget, siblings)) continue;
        if (isDirectory) pending.push(uri);
        else matches.push(uri);
        if (matches.length >= MAX_RESULTS) return matches;
      }
    }
    return matches;
  }
}
