import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CITATION_SYMBOL_PENDING } from '../../shared/citation-symbol';
import type { CitationSymbolTarget } from '../../shared/citation-symbol';
import { CitationChecks } from './citation-path-checks';
import type { CitationCheckRequest } from './citation-path-checks';
import { CitationSymbolLookups } from './citation-symbol-checks';

type Value = CitationSymbolTarget | typeof CITATION_SYMBOL_PENDING;

describe('CitationSymbolLookups', () => {
  const request = vi.fn<(body: CitationCheckRequest) => Promise<Array<Value | null>>>();
  let lookups: CitationSymbolLookups;
  let node: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    request.mockReset();
    request.mockResolvedValue([CITATION_SYMBOL_PENDING]);
    const checks = new CitationChecks<Value>(
      (body) => request(body),
      (value): value is Value => value !== null && value !== undefined,
      32,
      (value) => (value === CITATION_SYMBOL_PENDING ? 0 : 1_000)
    );
    lookups = new CitationSymbolLookups(checks, [1_000, 2_000]);
    node = document.createElement('code');
    document.body.append(node);
  });

  afterEach(() => {
    lookups.clear();
    node.remove();
    vi.useRealTimers();
  });

  it('resolves a waiting chain to null on clear without further requests', async () => {
    const result = lookups.resolve('loss_weights()', { directory: '/repo' }, node);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledOnce();
    lookups.clear();
    await expect(result).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledOnce();
  });

  it('caps attempts at the configured retry schedule', async () => {
    const result = lookups.resolve('loss_weights()', { directory: '/repo' }, node);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(3);
    expect(lookups.peek('loss_weights()', { directory: '/repo' })).toBeNull();
  });
});
