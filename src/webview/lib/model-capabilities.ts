import type { Provider } from '../types';
import { asRecord } from '../../shared/type-utils';

type ProviderModel = Provider['models'][string];

function getModel(
  providerID: string | null,
  modelID: string | null,
  providers: Provider[]
): ProviderModel | null {
  if (!providerID || !modelID) return null;
  const provider = providers.find((item) => item.id === providerID);
  return provider?.models[modelID] || null;
}

function getBooleanCapability(value: Record<string, unknown> | null, keys: string[]) {
  if (!value) return null;
  for (const key of keys) {
    if (typeof value[key] === 'boolean') return value[key] as boolean;
  }
  return null;
}

function getVariantNames(model: ProviderModel | null) {
  if (!model?.variants) return [];
  return Object.keys(model.variants).filter((variant) => variant !== 'none');
}

function normalizeSignal(value: string) {
  return value.toLowerCase().replace(/[_-]+/g, ' ');
}

function hasImageInputSignal(value: unknown): boolean {
  if (typeof value === 'string') {
    return /\b(image|vision|multimodal)\b/.test(normalizeSignal(value));
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasImageInputSignal(item));
  }

  const record = asRecord(value);
  if (!record) return false;
  if (typeof record.image === 'boolean') return record.image;
  if ('input' in record) return hasImageInputSignal(record.input);
  return false;
}

const VISION_MODEL_PATTERNS = [
  /\bgpt[-/. ]?(4o|4\.1|4\.5|5(\b|[-/. ]))/,
  /\bo[134](\b|[-/. ])/,
  /\bclaude\b/,
  /\bgemini\b/,
  /\bgemma[-/. ]?3/,
  /\bpixtral\b/,
  /\bllava\b/,
  /\bminicpm[-/. ]?v\b/,
  /\binternvl\b/,
  /\bqwen\d*(?:\.\d+)?[-/. ]?vl\b/,
  /\bqvq\b/,
  /\bkimi[-/. ]?vl\b/,
  /\bmolmo\b/,
  /\bvision\b/,
  /\bmultimodal\b/,
  /\bomni\b/,
];

function modelLooksVisionCapable(providerID: string, model: ProviderModel) {
  const haystack = `${providerID} ${model.id} ${model.name}`.toLowerCase();
  return VISION_MODEL_PATTERNS.some((pattern) => pattern.test(haystack));
}

export function modelSupportsReasoning(
  providerID: string | null,
  modelID: string | null,
  providers: Provider[]
): boolean {
  const model = getModel(providerID, modelID, providers);
  if (!model) return false;
  return !!model.capabilities?.reasoning || getVariantNames(model).length > 0;
}

export function modelSupportsTools(
  providerID: string | null,
  modelID: string | null,
  providers: Provider[]
): boolean {
  const model = getModel(providerID, modelID, providers);
  return !!model?.capabilities?.toolcall;
}

export function modelSupportsVariants(
  providerID: string | null,
  modelID: string | null,
  providers: Provider[]
): boolean {
  const model = getModel(providerID, modelID, providers);
  return getVariantNames(model).length > 0;
}

export function modelSupportsVision(
  providerID: string | null,
  modelID: string | null,
  providers: Provider[]
): boolean {
  const model = getModel(providerID, modelID, providers);
  if (!model || !providerID) return false;

  const rawModel = model as Record<string, unknown>;
  const capabilities = asRecord(rawModel.capabilities);
  const explicitCapability = getBooleanCapability(capabilities, [
    'vision',
    'image',
    'imageInput',
    'multimodal',
  ]);
  if (explicitCapability != null) return explicitCapability;

  const modalityCandidates = [
    rawModel.modalities,
    rawModel.inputModalities,
    rawModel.supportedInputs,
    rawModel.inputs,
    rawModel.input,
    capabilities?.modalities,
    capabilities?.inputModalities,
    capabilities?.supportedInputs,
    capabilities?.inputs,
    capabilities?.input,
  ];
  if (modalityCandidates.some((value) => hasImageInputSignal(value))) return true;

  return modelLooksVisionCapable(providerID, model);
}
