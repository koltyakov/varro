/* oxlint-disable anti-slop/no-module-mocking -- Exercise the VS Code symbol provider boundary without an editor host. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({
  commands: { executeCommand: vi.fn() },
  workspace: { fs: { stat: vi.fn() } },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
  FileType: { File: 1, Directory: 2 },
}));
vi.mock('vscode', () => mocks);
import { CitationSymbolSearch } from './citation-symbol-search';

function symbol(name = 'loss_weights', path = '/repo/loss.py', line = 11, character = 0) {
  return {
    name,
    location: {
      uri: { scheme: 'file', fsPath: resolve(path) },
      range: { start: { line, character } },
    },
  };
}

type SymbolFixture = ReturnType<typeof symbol>;

describe('CitationSymbolSearch', () => {
  let search: CitationSymbolSearch;
  const root = resolve('/repo');
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    mocks.commands.executeCommand.mockResolvedValue([symbol()]);
    mocks.workspace.fs.stat.mockResolvedValue({ type: 1 });
    search = new CitationSymbolSearch();
  });
  afterEach(() => {
    search.dispose();
    vi.useRealTimers();
  });

  it('links one exact indexed definition in the owning project and caches duplicates', async () => {
    const [a, b] = await Promise.all([
      search.find(['loss_weights()', 'loss_weights()'], root),
      search.find(['loss_weights()'], root),
    ]);
    expect(a).toEqual([
      { path: resolve('/repo/loss.py'), line: 12 },
      { path: resolve('/repo/loss.py'), line: 12 },
    ]);
    expect(b).toEqual([a[0]]);
    expect(mocks.commands.executeCommand).toHaveBeenCalledExactlyOnceWith(
      'vscode.executeWorkspaceSymbolProvider',
      'loss_weights'
    );
    expect(mocks.workspace.fs.stat).toHaveBeenCalledOnce();
  });

  it('filters fuzzy matches and sibling projects, and deduplicates provider locations', async () => {
    mocks.commands.executeCommand.mockResolvedValue([
      symbol(),
      symbol(),
      symbol('loss_weights_extra'),
      symbol('loss_weights', '/repo-other/loss.py'),
    ]);
    await expect(search.find(['loss_weights()'], root)).resolves.toEqual([
      { path: resolve('/repo/loss.py'), line: 12 },
    ]);
  });

  it('scopes identical names to nested owning projects and refreshes expired results', async () => {
    mocks.commands.executeCommand.mockResolvedValue([
      symbol('loss_weights', '/repo/a/loss.py'),
      symbol('loss_weights', '/repo/b/loss.py'),
    ]);
    await expect(search.find(['loss_weights()'], resolve('/repo/a'))).resolves.toEqual([
      { path: resolve('/repo/a/loss.py'), line: 12 },
    ]);
    await expect(search.find(['loss_weights()'], resolve('/repo/b'))).resolves.toEqual([
      { path: resolve('/repo/b/loss.py'), line: 12 },
    ]);
    await search.find(['loss_weights()'], resolve('/repo/a'));
    expect(mocks.commands.executeCommand).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(15_001);
    await search.find(['loss_weights()'], resolve('/repo/a'));
    expect(mocks.commands.executeCommand).toHaveBeenCalledTimes(3);
  });

  it.each(
    [
      [],
      [symbol(), symbol('loss_weights', '/repo/other.py')],
      [symbol(), symbol('loss_weights', '/repo/loss.py', 11, 20)],
      [symbol('loss_weights', '/outside/loss.py')],
      [symbol('loss_weights', '/repo/loss.py', -1)],
    ].map((values) => ({ values }))
  )(
    'keeps absent, ambiguous, outside, and invalid locations inert: $values',
    async ({ values }) => {
      mocks.commands.executeCommand.mockResolvedValue(values);
      await expect(search.find(['loss_weights()'], root)).resolves.toEqual([null]);
      expect(mocks.workspace.fs.stat).not.toHaveBeenCalled();
    }
  );

  it('does not query grouped labels, placeholders, or unscoped symbols', async () => {
    await expect(
      search.find(['transporter / franka / clip', 'seedX/config.yaml'], root)
    ).resolves.toEqual([null, null]);
    await expect(search.find(['loss_weights()'], undefined)).resolves.toEqual([null]);
    expect(mocks.commands.executeCommand).not.toHaveBeenCalled();
  });

  it('fails closed when no provider is available or the file is missing', async () => {
    mocks.commands.executeCommand.mockRejectedValueOnce(new Error('No provider'));
    await expect(search.find(['loss_weights()'], root)).resolves.toEqual([null]);
    await vi.advanceTimersByTimeAsync(1_001);
    mocks.workspace.fs.stat.mockRejectedValueOnce(new Error('Missing file'));
    await expect(search.find(['loss_weights()'], root)).resolves.toEqual([null]);
  });

  it('shares a two-second batch budget and never piles up uncancellable provider calls', async () => {
    mocks.commands.executeCommand.mockImplementation(() => new Promise(() => {}));
    const pending = search.find(['loss_weights()', 'soft_updates()', 'stack_on_channel()'], root);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(['pending', 'pending', 'pending']);
    await expect(search.find(['other_call()'], root)).resolves.toEqual(['pending']);
    expect(mocks.commands.executeCommand).toHaveBeenCalledTimes(2);
  });

  it('reports a timed-out lookup as pending and serves its late result on retry', async () => {
    let settle!: (value: SymbolFixture[]) => void;
    mocks.commands.executeCommand.mockImplementationOnce(
      () => new Promise((done) => (settle = done))
    );
    const pending = search.find(['loss_weights()'], root);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual(['pending']);
    settle([symbol()]);
    await expect(search.find(['loss_weights()'], root)).resolves.toEqual([
      { path: resolve('/repo/loss.py'), line: 12 },
    ]);
    expect(mocks.commands.executeCommand).toHaveBeenCalledOnce();
  });

  it('reports a concurrency-skipped lookup as pending and resolves it on retry', async () => {
    const settles: Array<(value: SymbolFixture[]) => void> = [];
    mocks.commands.executeCommand.mockImplementation(
      () => new Promise((done) => settles.push(done))
    );
    const busy = search.find(['soft_updates()', 'stack_on_channel()'], root);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(busy).resolves.toEqual(['pending', 'pending']);
    await expect(search.find(['loss_weights()'], root)).resolves.toEqual(['pending']);
    expect(mocks.commands.executeCommand).toHaveBeenCalledTimes(2);
    for (const settle of settles) settle([]);
    await vi.advanceTimersByTimeAsync(0);
    mocks.commands.executeCommand.mockResolvedValue([symbol()]);
    await expect(search.find(['loss_weights()'], root)).resolves.toEqual([
      { path: resolve('/repo/loss.py'), line: 12 },
    ]);
  });

  it('aborts promptly without applying late results', async () => {
    const controller = new AbortController();
    mocks.commands.executeCommand.mockImplementation(() => new Promise(() => {}));
    const pending = search.find(['loss_weights()'], root, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
  });

  describe('lookup leases and circuit breaker', () => {
    const { LEASE_MS, INITIAL_COOLDOWN_MS } = CitationSymbolSearch;
    const hung = new Set<string>();
    const settles = new Map<string, (value: SymbolFixture[]) => void>();
    const target = { path: resolve('/repo/loss.py'), line: 12 };
    const calls = () => mocks.commands.executeCommand.mock.calls.map(([, name]) => name);

    beforeEach(() => {
      hung.clear();
      settles.clear();
      mocks.commands.executeCommand.mockImplementation((_command: string, name: string) =>
        hung.has(name)
          ? new Promise<SymbolFixture[]>((done) => settles.set(name, done))
          : Promise.resolve([symbol(name)])
      );
    });

    /** Starts provider calls that never settle and lets the 2s request budget expire. */
    async function startHung(...names: string[]) {
      for (const name of names) hung.add(name);
      const pending = search.find(
        names.map((name) => `${name}()`),
        root
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual(names.map(() => 'pending'));
    }

    /** Abandons a and b, then lets c and d expire while holding both slots. */
    async function openBreakerWithFullSlots() {
      await startHung('a', 'b');
      await vi.advanceTimersByTimeAsync(LEASE_MS - 2_000);
      await startHung('c', 'd');
      await vi.advanceTimersByTimeAsync(LEASE_MS - 2_000);
    }

    /** Abandons a and b, then lets c expire while holding one slot. */
    async function openBreakerWithFreeSlot() {
      await startHung('a', 'b');
      await vi.advanceTimersByTimeAsync(LEASE_MS - 2_000);
      await startHung('c');
      await vi.advanceTimersByTimeAsync(LEASE_MS - 2_000);
    }

    it('reuses slots whose provider calls outlive their lease', async () => {
      await startHung('a', 'b');
      await expect(search.find(['c()'], root)).resolves.toEqual(['pending']);
      expect(calls()).toEqual(['a', 'b']);
      await vi.advanceTimersByTimeAsync(LEASE_MS - 2_000);
      await expect(search.find(['c()'], root)).resolves.toEqual([target]);
      expect(calls()).toEqual(['a', 'b', 'c']);
    });

    it('opens the breaker at the abandoned cap and never exceeds four outstanding calls', async () => {
      await openBreakerWithFullSlots();
      // New and stuck names both answer null at once so webview retry chains stop.
      await expect(search.find(['e()', 'a()'], root)).resolves.toEqual([null, null]);
      await vi.advanceTimersByTimeAsync(CitationSymbolSearch.MAX_COOLDOWN_MS * 2);
      await expect(search.find(['f()'], root)).resolves.toEqual([null]);
      expect(calls()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('caches late results and closes the breaker when an abandoned call settles', async () => {
      await openBreakerWithFullSlots();
      settles.get('a')!([symbol('a')]);
      await vi.advanceTimersByTimeAsync(0);
      await expect(search.find(['a()'], root)).resolves.toEqual([target]);
      // Closed again, but c and d still hold both slots.
      await expect(search.find(['e()'], root)).resolves.toEqual(['pending']);
      settles.get('c')!([]);
      await vi.advanceTimersByTimeAsync(0);
      await expect(search.find(['e()'], root)).resolves.toEqual([target]);
      expect(calls()).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('probes once per cooldown only while a slot is free, backing off on failure', async () => {
      await openBreakerWithFreeSlot();
      await expect(search.find(['p()'], root)).resolves.toEqual([null]);
      await vi.advanceTimersByTimeAsync(INITIAL_COOLDOWN_MS);
      hung.add('p');
      const probing = search.find(['p()', 'q()'], root);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(probing).resolves.toEqual(['pending', null]);
      expect(calls()).toEqual(['a', 'b', 'c', 'p']);
      // The failed probe keeps its slot and reopens the breaker with a doubled cooldown.
      await vi.advanceTimersByTimeAsync(LEASE_MS - 2_000);
      await vi.advanceTimersByTimeAsync(INITIAL_COOLDOWN_MS * 2);
      await expect(search.find(['r()'], root)).resolves.toEqual([null]);
      expect(calls()).toEqual(['a', 'b', 'c', 'p']);
    });

    it('closes the breaker after a successful probe', async () => {
      await openBreakerWithFreeSlot();
      await vi.advanceTimersByTimeAsync(INITIAL_COOLDOWN_MS);
      await expect(search.find(['p()'], root)).resolves.toEqual([target]);
      await expect(search.find(['q()'], root)).resolves.toEqual([target]);
      expect(calls()).toEqual(['a', 'b', 'c', 'p', 'q']);
    });

    it('leases stalled file-system checks like stalled providers', async () => {
      mocks.workspace.fs.stat.mockImplementation(() => new Promise(() => {}));
      const pending = search.find(['a()', 'b()'], root);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toEqual(['pending', 'pending']);
      await expect(search.find(['c()'], root)).resolves.toEqual(['pending']);
      expect(calls()).toEqual(['a', 'b']);
      mocks.workspace.fs.stat.mockResolvedValue({ type: 1 });
      await vi.advanceTimersByTimeAsync(LEASE_MS - 2_000);
      await expect(search.find(['c()'], root)).resolves.toEqual([target]);
      expect(calls()).toEqual(['a', 'b', 'c']);
    });
  });
});
