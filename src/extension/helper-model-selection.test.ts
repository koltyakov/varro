import { describe, expect, it, vi } from 'vitest';

import { resolveHelperModel } from './helper-model-selection';

const providers = {
  providers: [
    {
      id: 'github-copilot',
      models: {
        'gpt-5.6-luna': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      },
    },
    {
      id: 'openai',
      models: {
        'gpt-5.6-luna': { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      },
    },
    {
      id: 'anthropic',
      models: {
        opus: { id: 'opus', name: 'Claude Opus', variants: { low: {} } },
      },
    },
  ],
};

describe('resolveHelperModel', () => {
  it('uses the VS Code setting before OpenCode small_model', async () => {
    const loadSmallModel = vi.fn(() => Promise.resolve('openai/gpt-5.6-luna'));
    const loadProviderConfig = vi.fn(() => Promise.resolve(providers));

    await expect(
      resolveHelperModel({
        configuredModel: 'anthropic/opus',
        loadSmallModel,
        loadProviderConfig,
        fallbackModel: null,
        isOpenAIPro: async () => false,
      })
    ).resolves.toEqual({ providerID: 'anthropic', modelID: 'opus' });
    expect(loadSmallModel).not.toHaveBeenCalled();
    expect(loadProviderConfig).not.toHaveBeenCalled();
  });

  it('uses OpenCode small_model before Luna', async () => {
    const loadProviderConfig = vi.fn(() => Promise.resolve(providers));

    await expect(
      resolveHelperModel({
        configuredModel: '',
        loadSmallModel: async () => 'anthropic/opus',
        loadProviderConfig,
        fallbackModel: null,
        isOpenAIPro: async () => false,
      })
    ).resolves.toEqual({ providerID: 'anthropic', modelID: 'opus' });
    expect(loadProviderConfig).not.toHaveBeenCalled();
  });

  it('prefers OpenAI Luna over Copilot Luna regardless of provider order', async () => {
    await expect(
      resolveHelperModel({
        configuredModel: '',
        loadSmallModel: async () => null,
        loadProviderConfig: async () => providers,
        fallbackModel: { providerID: 'anthropic', modelID: 'opus' },
        isOpenAIPro: async () => false,
      })
    ).resolves.toEqual({ providerID: 'openai', modelID: 'gpt-5.6-luna' });
  });

  it('uses Copilot Luna before the active model', async () => {
    await expect(
      resolveHelperModel({
        configuredModel: '',
        loadSmallModel: async () => null,
        loadProviderConfig: async () => ({
          providers: providers.providers.filter((p) => p.id !== 'openai'),
        }),
        fallbackModel: { providerID: 'anthropic', modelID: 'opus' },
        isOpenAIPro: async () => false,
      })
    ).resolves.toEqual({ providerID: 'github-copilot', modelID: 'gpt-5.6-luna' });
  });
});
