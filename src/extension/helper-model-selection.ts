import type { ChatModelSelection } from '../shared/protocol';
import { asRecord } from '../shared/type-utils';
import { parseModelRoute } from './sidebar-provider-utils';

type HelperModelSelectionOptions = {
  smallModel: unknown;
  loadProviderConfig: () => Promise<unknown>;
  fallbackModel: ChatModelSelection | null;
  isOpenAIPro: () => Promise<boolean>;
};

export async function resolveHelperModel({
  smallModel,
  loadProviderConfig,
  fallbackModel,
  isOpenAIPro,
}: HelperModelSelectionOptions): Promise<ChatModelSelection | null> {
  const configuredModel = parseModelRoute(smallModel);
  if (configuredModel) return configuredModel;

  const providerConfig = await loadProviderConfig().catch(() => null);
  const luna = findGptLunaModels(providerConfig);
  if (luna.fast && (await isOpenAIPro().catch(() => false))) return luna.fast;
  if (luna.standard) return luna.standard;

  return resolveFallbackModel(providerConfig, fallbackModel);
}

function findGptLunaModels(value: unknown): {
  standard: ChatModelSelection | null;
  fast: ChatModelSelection | null;
} {
  const providers = asRecord(value)?.providers;
  if (!Array.isArray(providers)) return { standard: null, fast: null };
  let standard: ChatModelSelection | null = null;
  let fast: ChatModelSelection | null = null;

  for (const rawProvider of providers) {
    const provider = asRecord(rawProvider);
    const providerID = getString(provider?.id);
    const models = asRecord(provider?.models);
    if (!providerID || !models) continue;

    for (const [modelKey, rawModel] of Object.entries(models)) {
      const model = asRecord(rawModel);
      const modelID = getString(model?.id) || modelKey;
      const identity =
        `${modelID} ${getString(model?.name) || ''} ${getString(model?.family) || ''}`
          .toLowerCase()
          .replace(/[-_.]+/g, ' ');
      if (getString(model?.status)?.toLowerCase() === 'deprecated') continue;
      if (!/\bgpt\b/.test(identity) || !/\bluna\b/.test(identity)) continue;

      const options = asRecord(model?.options);
      const isFast = /\bfast\b/.test(identity) || options?.serviceTier === 'priority';
      if (isFast && providerID === 'openai' && !fast) {
        fast = { providerID, modelID };
      } else if (!isFast && !/\bpro\b/.test(identity) && !standard) {
        standard = { providerID, modelID };
      }
    }
  }
  return { standard, fast };
}

function resolveFallbackModel(
  value: unknown,
  fallbackModel: ChatModelSelection | null
): ChatModelSelection | null {
  if (!fallbackModel) return null;
  const model = findProviderModel(value, fallbackModel.providerID, fallbackModel.modelID);
  if (!model) return null;
  const variant = findLowReasoningVariant(model);
  return {
    providerID: fallbackModel.providerID,
    modelID: fallbackModel.modelID,
    ...(variant ? { variant } : {}),
  };
}

function findProviderModel(
  value: unknown,
  providerID: string,
  modelID: string
): Record<string, unknown> | null {
  const providers = asRecord(value)?.providers;
  if (!Array.isArray(providers)) return null;
  const provider = providers
    .map((item) => asRecord(item))
    .find((item) => getString(item?.id) === providerID);
  const models = asRecord(provider?.models);
  if (!models) return null;
  const direct = asRecord(models[modelID]);
  if (direct) return direct;
  for (const rawModel of Object.values(models)) {
    const model = asRecord(rawModel);
    if (getString(model?.id) === modelID) return model;
  }
  return null;
}

function findLowReasoningVariant(model: Record<string, unknown>): string | null {
  const variants = asRecord(model.variants);
  if (!variants) return null;
  const entries = Object.entries(variants);
  const low = entries.find(([name, config]) => isReasoningVariant(name, config, 'low'));
  if (low) return low[0];
  return entries.find(([name, config]) => isReasoningVariant(name, config, 'none'))?.[0] || null;
}

function isReasoningVariant(name: string, value: unknown, target: 'low' | 'none'): boolean {
  const normalizedName = name.toLowerCase().replace(/[-_]+/g, ' ').trim();
  const config = asRecord(value);
  const options = asRecord(config?.options);
  const effort = (
    getString(config?.reasoningEffort) ||
    getString(config?.reasoning_effort) ||
    getString(options?.reasoningEffort) ||
    getString(options?.reasoning_effort) ||
    ''
  )
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .trim();
  if (target === 'low') {
    return /\b(minimal|low|light|fast)\b/.test(normalizedName) || effort === 'low';
  }
  return (
    ['none', 'off', 'disabled', 'no reasoning', 'no thinking'].includes(normalizedName) ||
    ['none', 'off', 'disabled'].includes(effort)
  );
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
