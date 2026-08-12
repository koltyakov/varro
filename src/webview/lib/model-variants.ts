import type { Provider } from '../types';
import { normalizeModelVariant } from '../../shared/model-variant';

function getRawVariantsForModel(
  providerID: string | null | undefined,
  modelID: string | null | undefined,
  providers: Provider[]
) {
  if (!providerID || !modelID) return [];
  const provider = providers.find((item) => item.id === providerID);
  const model = provider?.models[modelID];
  if (!model?.variants) return [];
  return Object.keys(model.variants);
}

export function getVariantsForModel(
  providerID: string | null | undefined,
  modelID: string | null | undefined,
  providers: Provider[]
): string[] {
  return Array.from(
    new Set(
      getRawVariantsForModel(providerID, modelID, providers).map((variant) =>
        normalizeModelVariant(modelID, variant)
      )
    )
  ).filter((variant): variant is string => !!variant);
}
