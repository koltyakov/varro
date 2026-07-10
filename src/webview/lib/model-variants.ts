import type { Provider } from '../types';
import { normalizeModelVariant } from '../../shared/model-variant';

function normalizeVariantName(variantName: string) {
  return variantName.toLowerCase().replace(/[-_]+/g, ' ');
}

type VariantKind = 'low' | 'medium' | 'high';

function getVariantKind(variantName: string): VariantKind | null {
  const normalized = normalizeVariantName(variantName);
  if (/\b(minimal|low|light|fast)\b/.test(normalized)) return 'low';
  if (/\b(medium|med|mid|balanced|standard|default)\b/.test(normalized)) return 'medium';
  if (/\b(high|max|heavy|deep|intense)\b/.test(normalized)) return 'high';
  return null;
}

function getVariantsForModel(
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

function isLowReasoningVariant(variantName: string) {
  return getVariantKind(variantName) === 'low';
}

function isHighReasoningVariant(variantName: string) {
  return getVariantKind(variantName) === 'high';
}

function shouldPreferLowReasoningByDefault(modelID: string | null | undefined) {
  return modelID === 'gpt-5.5';
}

export function getMatchingVariant(
  source: {
    providerID: string | null | undefined;
    modelID: string | null | undefined;
    variant: string | null | undefined;
  },
  target: { providerID: string | null | undefined; modelID: string | null | undefined },
  providers: Provider[]
) {
  if (!source.variant) return null;

  const targetVariants = getVariantsForModel(target.providerID, target.modelID, providers);
  if (targetVariants.length === 0) return null;

  if (shouldPreferLowReasoningByDefault(target.modelID)) {
    const preferredVariant = getPreferredVariant(target.providerID, target.modelID, providers);
    if (preferredVariant) return preferredVariant;
  }

  if (targetVariants.includes(source.variant)) {
    return normalizeModelVariant(target.modelID, source.variant);
  }

  const sourceKind = getVariantKind(source.variant);
  if (sourceKind) {
    const sameKindVariant = targetVariants.find(
      (variant) => getVariantKind(variant) === sourceKind
    );
    if (sameKindVariant) return normalizeModelVariant(target.modelID, sameKindVariant);
  }

  const sourceVariants = getVariantsForModel(source.providerID, source.modelID, providers);
  const sourceIndex = sourceVariants.indexOf(source.variant);
  if (sourceIndex >= 0) {
    if (sourceVariants.length === 1) {
      return normalizeModelVariant(target.modelID, targetVariants[0]!);
    }
    const targetIndex = Math.round(
      (sourceIndex / (sourceVariants.length - 1)) * (targetVariants.length - 1)
    );
    return normalizeModelVariant(target.modelID, targetVariants[targetIndex]!);
  }

  return getPreferredVariant(target.providerID, target.modelID, providers);
}

export function getPreferredVariant(
  providerID: string | null | undefined,
  modelID: string | null | undefined,
  providers: Provider[]
) {
  const variants = getVariantsForModel(providerID, modelID, providers).filter(
    (variant) => variant !== 'none'
  );
  if (variants.length === 0) return null;

  if (shouldPreferLowReasoningByDefault(modelID)) {
    const lowVariant = variants.find((variant) => isLowReasoningVariant(variant));
    if (lowVariant) return normalizeModelVariant(modelID, lowVariant);
  }

  const lastIndex = variants.length - 1;
  const highIndex = variants.findIndex(
    (variant, index) => index < lastIndex && isHighReasoningVariant(variant)
  );
  if (highIndex >= 0) return normalizeModelVariant(modelID, variants[highIndex]!);

  const preferredIndex = Math.max(0, lastIndex - 1);
  const preferredVariant = variants[preferredIndex]!;
  if (!isLowReasoningVariant(preferredVariant)) {
    return normalizeModelVariant(modelID, preferredVariant);
  }

  for (let i = preferredIndex + 1; i < variants.length; i++) {
    if (!isLowReasoningVariant(variants[i]!)) return normalizeModelVariant(modelID, variants[i]!);
  }

  for (let i = 0; i < preferredIndex; i++) {
    if (!isLowReasoningVariant(variants[i]!)) return normalizeModelVariant(modelID, variants[i]!);
  }

  return normalizeModelVariant(modelID, preferredVariant);
}
