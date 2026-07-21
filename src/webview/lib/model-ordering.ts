import type { Provider } from '../types';

type ProviderModel = Provider['models'][string];

const GPT_MODEL_TIER_ORDER = ['sol', 'terra', 'luna'] as const;

function releaseTime(model: ProviderModel) {
  return modelReleaseTime(model) ?? 0;
}

function gptModelTier(model: ProviderModel) {
  const identity = `${model.id} ${model.name}`.toLowerCase();
  if (!/\bgpt-/.test(identity)) return null;

  const tier = GPT_MODEL_TIER_ORDER.findIndex((name) => new RegExp(`\\b${name}\\b`).test(identity));
  return tier >= 0 ? tier : null;
}

function modelReleaseTime(model: ProviderModel) {
  if (!model.release_date) return null;
  const time = Date.parse(model.release_date);
  return Number.isNaN(time) ? null : time;
}

function modelLane(model: ProviderModel) {
  const role = model.id
    .toLocaleLowerCase()
    .split(/[^a-z0-9.]+/)
    .flatMap((part) => {
      if (!part || part === 'latest') return [];
      if (/^v?\d+(?:\.\d+)*$/.test(part)) return [];
      if (/^\d+(?:\.\d+)*[a-z]$/.test(part)) return [];
      const namedGeneration = part.match(/^([or])\d+(?:\.\d+)*$/);
      return namedGeneration?.[1] ?? part;
    })
    .join('-');

  const output = model.capabilities.output;
  const modalities = Array.isArray(output)
    ? output
    : Object.entries(output ?? {})
        .filter(([, enabled]) => enabled)
        .map(([modality]) => modality);
  const nonTextModalities = modalities
    .filter((modality) => modality !== 'text')
    .toSorted()
    .join(',');

  return `${model.family?.trim().toLocaleLowerCase()}:${role}:${nonTextModalities}`;
}

export function getSupersededModelIds(models: readonly ProviderModel[]) {
  const groups = new Map<string, ProviderModel[]>();

  for (const model of models) {
    if (!model.family) continue;
    const lane = modelLane(model);
    const siblings = groups.get(lane);
    if (siblings) siblings.push(model);
    else groups.set(lane, [model]);
  }

  const superseded = new Set<string>();
  for (const siblings of groups.values()) {
    const stableSiblings = siblings.filter(
      (model) =>
        model.status !== 'alpha' && model.status !== 'beta' && model.status !== 'deprecated'
    );
    if (stableSiblings.length === 0) continue;

    const newestStableRelease = Math.max(
      ...stableSiblings.map(modelReleaseTime).filter((time): time is number => time !== null)
    );

    for (const model of siblings) {
      const releasedAt = modelReleaseTime(model);
      if (
        model.status === 'deprecated' ||
        (releasedAt !== null && releasedAt < newestStableRelease)
      ) {
        superseded.add(model.id);
      }
    }
  }

  return superseded;
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
