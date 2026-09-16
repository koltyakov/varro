import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelPricingCatalog } from './model-pricing';

afterEach(() => vi.unstubAllGlobals());

describe('ModelPricingCatalog', () => {
  it('matches exact provider/model IDs and shares a validated catalog fetch', async () => {
    const fetchCatalog = vi.fn(async () =>
      Response.json({
        openai: {
          models: {
            sol: { cost: { input: 4, output: 20, cache_read: 0.4, cache_write: 5 } },
            zero: { cost: { input: 0, output: 0 } },
            partial: { cost: { input: 0.025, output: '20', cache_read: -1 } },
          },
        },
        other: { models: { sol: { cost: { input: 8 } } } },
      })
    );
    vi.stubGlobal('fetch', fetchCatalog);
    const catalog = new ModelPricingCatalog();
    const [sol, other] = await Promise.all([
      catalog.get('OpenAI', 'sol'),
      catalog.get('other', 'sol'),
    ]);
    expect(sol).toEqual({ input: 4, output: 20, cache_read: 0.4, cache_write: 5 });
    expect(other).toEqual({ input: 8 });
    expect(await catalog.get('openai', 'zero')).toBeNull();
    expect(await catalog.get('openai', 'unknown')).toBeNull();
    expect(await catalog.get('unknown', 'sol')).toBeNull();
    expect(await catalog.get('openai', 'partial')).toEqual({ input: 0.025 });
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(fetchCatalog).toHaveBeenCalledWith('https://models.dev/api.json', expect.any(Object));
  });

  it('does not cache a failed request as missing pricing', async () => {
    const fetchCatalog = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({ openai: { models: { sol: { cost: { input: 4 } } } } })
      );
    vi.stubGlobal('fetch', fetchCatalog);
    const catalog = new ModelPricingCatalog();
    await expect(catalog.get('openai', 'sol')).rejects.toThrow('HTTP 503');
    expect(await catalog.get('openai', 'sol')).toEqual({ input: 4 });
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
  });
});
