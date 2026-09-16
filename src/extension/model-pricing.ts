import type { ModelPricing } from '../shared/protocol';
import { asRecord, isNumber } from '../shared/type-utils';

export class ModelPricingCatalog {
  private cached: Map<string, ModelPricing> | undefined;
  private expiresAt = 0;
  private pending: Promise<Map<string, ModelPricing>> | undefined;

  async get(providerID: string, modelID: string): Promise<ModelPricing | null> {
    if (!this.cached || Date.now() >= this.expiresAt) {
      this.pending ??= this.load().finally(() => {
        this.pending = undefined;
      });
      this.cached = await this.pending;
      this.expiresAt = Date.now() + 60 * 60_000;
    }
    return this.cached.get(`${providerID.toLowerCase()}/${modelID}`) ?? null;
  }

  private async load(): Promise<Map<string, ModelPricing>> {
    const response = await fetch('https://models.dev/api.json', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Model pricing request failed: HTTP ${response.status}`);
    const catalog = asRecord(await response.json());
    if (!catalog) throw new Error('Model pricing catalog is not an object');
    const prices = new Map<string, ModelPricing>();
    for (const [providerID, provider] of Object.entries(catalog)) {
      const models = asRecord(asRecord(provider)?.models);
      if (!models) continue;
      for (const [modelID, model] of Object.entries(models)) {
        const cost = asRecord(asRecord(model)?.cost);
        if (!cost) continue;
        const pricing: ModelPricing = {};
        for (const key of ['input', 'output', 'cache_read', 'cache_write'] as const) {
          const value = cost[key];
          if (isNumber(value) && Number.isFinite(value) && value >= 0) pricing[key] = value;
        }
        if (Object.values(pricing).some((value) => value > 0)) {
          prices.set(`${providerID.toLowerCase()}/${modelID}`, pricing);
        }
      }
    }
    return prices;
  }
}
