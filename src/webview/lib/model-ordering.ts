import type { Provider } from '../types';

type ProviderModel = Provider['models'][string];

const GPT_MODEL_TIER_ORDER = ['sol', 'terra', 'luna'] as const;

function releaseTime(model: ProviderModel) {
  if (!model.release_date) return 0;
  const time = Date.parse(model.release_date);
  return Number.isNaN(time) ? 0 : time;
}

function gptModelTier(model: ProviderModel) {
  const identity = `${model.id} ${model.name}`.toLowerCase();
  if (!/\bgpt-/.test(identity)) return null;

  const tier = GPT_MODEL_TIER_ORDER.findIndex((name) => new RegExp(`\\b${name}\\b`).test(identity));
  return tier >= 0 ? tier : null;
}

export function sortProviderModels(models: readonly ProviderModel[]): ProviderModel[] {
  return models.toSorted((a, b) => {
    const deprecatedOrder = Number(a.status === 'deprecated') - Number(b.status === 'deprecated');
    if (deprecatedOrder !== 0) return deprecatedOrder;

    const aGptTier = gptModelTier(a);
    const bGptTier = gptModelTier(b);
    const gptTierOrder =
      (aGptTier ?? GPT_MODEL_TIER_ORDER.length) - (bGptTier ?? GPT_MODEL_TIER_ORDER.length);
    if (gptTierOrder !== 0) return gptTierOrder;

    const releaseOrder = releaseTime(b) - releaseTime(a);
    if (releaseOrder !== 0) return releaseOrder;

    const nameOrder = a.name.localeCompare(b.name);
    return nameOrder !== 0 ? nameOrder : a.id.localeCompare(b.id);
  });
}
