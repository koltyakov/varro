/* oxlint-disable anti-slop/no-module-mocking -- VS Code settings and native catalogs are substituted without changing user settings or credentials. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DecisionProviders } from './decision-providers';

const settings = vi.hoisted(() => new Map<string, string | boolean>());
const update = vi.hoisted(() =>
  vi.fn(async (key: string, value: string | boolean | undefined) => {
    if (value === undefined) settings.delete(key);
    else settings.set(key, value);
  })
);
const debugEnabled = vi.hoisted(() => ({ value: false }));
vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback: string | boolean) =>
        key === 'debug.showDecisionModels' ? debugEnabled.value : fallback,
      inspect: (key: string) => ({ globalValue: settings.get(key) }),
      update,
    }),
  },
}));
vi.mock('./logger', () => ({ logger: { warn: vi.fn() } }));
const model = { providerID: 'typesafe-ai', modelID: 'jev', name: 'Jev' };
describe('native decision model settings', () => {
  beforeEach(() => {
    settings.clear();
    update.mockClear();
  });
  it.each([false, true])(
    'shows the native section only with debug opt-in %s without disabling the selected reviewer',
    async (visible) => {
      debugEnabled.value = visible;
      try {
        const providers = new DecisionProviders(undefined, undefined, {
          status: async () => ({ supported: true, model, models: [model] }),
        });
        expect((await providers.status()).native).toMatchObject({
          visible,
          model,
          models: [model],
        });
      } finally {
        debugEnabled.value = false;
      }
    }
  );
  it('accepts only an advertised native decision model', async () => {
    const providers = new DecisionProviders(undefined, undefined, {
      status: async () => ({ supported: true, model: null, models: [model] }),
    });
    await providers.handle({ action: 'native', model: 'typesafe-ai/jev' });
    expect(update).toHaveBeenCalledWith('permissions.decisionModel', 'typesafe-ai/jev', 1);
    update.mockClear();
    await expect(
      providers.handle({ action: 'native', model: 'chat/not-a-decision' })
    ).rejects.toThrow('available');
    expect(update).not.toHaveBeenCalled();
  });
  it('allows clearing an unavailable native model without reconnecting', async () => {
    settings.set('permissions.decisionModel', 'typesafe-ai/gone');
    const providers = new DecisionProviders(undefined);
    await providers.handle({ action: 'native', model: '' });
    expect(update).toHaveBeenCalledWith('permissions.decisionModel', undefined, 1);
    expect(settings.has('permissions.decisionModel')).toBe(false);
  });
  it('ignores a native model saved under the removed released key', async () => {
    settings.set('chat.autoApproveDecisionModel', 'typesafe-ai/jev');
    const providers = new DecisionProviders(undefined);
    expect((await providers.status()).jev.autoApprove).toBe(false);
    await providers.handle({ action: 'native', model: '' });
    // Clearing writes only the current key; the removed key is not read or touched.
    expect(update.mock.calls).toEqual([['permissions.decisionModel', undefined, 1]]);
  });
  it('replaces a Jev selection with a native model', async () => {
    settings.set('permissions.decisionModel', 'typesafe/jev-latest');
    const providers = new DecisionProviders(undefined, undefined, {
      status: async () => ({ supported: true, model: null, models: [model] }),
    });
    const status = await providers.handle({ action: 'native', model: 'typesafe-ai/jev' });
    expect(settings.get('permissions.decisionModel')).toBe('typesafe-ai/jev');
    expect(status.jev.autoApprove).toBe(false);
  });
  it('does not turn off a Jev selection when the native reviewer is set to off', async () => {
    settings.set('permissions.decisionModel', 'typesafe/jev-latest');
    const providers = new DecisionProviders(undefined);
    const status = await providers.handle({ action: 'native', model: '' });
    expect(update).not.toHaveBeenCalled();
    expect(status.jev.autoApprove).toBe(true);
  });
});
describe('Jev selection in varro.permissions.decisionModel', () => {
  const secrets = () => {
    const stored = new Map<string, string>([['varro.typesafe.apiKey', 'ts-key']]);
    return {
      stored,
      storage: {
        get: async (key: string) => stored.get(key),
        store: async (key: string, value: string) => void stored.set(key, value),
        delete: async (key: string) => void stored.delete(key),
        keys: async () => [...stored.keys()],
        onDidChange: () => ({ dispose: () => undefined }),
      },
    };
  };
  beforeEach(() => {
    settings.clear();
    update.mockClear();
  });
  it('derives the Jev state and model from the decision model setting', async () => {
    const providers = new DecisionProviders(undefined);
    expect(providers.readSettings()).toEqual({ model: null });
    expect((await providers.status()).jev).toMatchObject({
      autoApprove: false,
      model: 'jev-latest',
    });
    settings.set('permissions.decisionModel', 'typesafe/jev-2');
    expect(providers.readSettings()).toEqual({ model: 'jev-2' });
    expect((await providers.status()).jev).toMatchObject({ autoApprove: true, model: 'jev-2' });
    settings.set('permissions.decisionModel', 'typesafe-ai/jev');
    expect(providers.readSettings()).toEqual({ model: null });
  });
  it.each(['decisions.jev.autoApprove', 'autoApprove.useJev', 'autoApprove.jev.enabled'])(
    'ignores a user value under the old Jev boolean key %s',
    async (key) => {
      settings.set(key, true);
      const providers = new DecisionProviders(undefined);
      expect(providers.readSettings()).toEqual({ model: null });
      expect((await providers.status()).jev.autoApprove).toBe(false);
    }
  );
  it('turns Jev on by writing the direct route', async () => {
    const providers = new DecisionProviders(undefined);
    const status = await providers.handle({ action: 'update', autoApprove: true });
    expect(status.jev.autoApprove).toBe(true);
    expect(update.mock.calls).toEqual([['permissions.decisionModel', 'typesafe/jev-latest', 1]]);
  });
  it('replaces a native model when Jev is turned on', async () => {
    settings.set('permissions.decisionModel', 'typesafe-ai/jev');
    const providers = new DecisionProviders(undefined);
    await providers.handle({ action: 'update', autoApprove: true });
    expect(settings.get('permissions.decisionModel')).toBe('typesafe/jev-latest');
  });
  it('keeps a chosen direct TypeSafe model when Jev is turned on again', async () => {
    settings.set('permissions.decisionModel', 'typesafe/jev-2');
    const providers = new DecisionProviders(undefined);
    await providers.handle({ action: 'update', autoApprove: true });
    expect(update).not.toHaveBeenCalled();
  });
  it('clears the direct route when Jev is turned off', async () => {
    settings.set('permissions.decisionModel', 'typesafe/jev-latest');
    const providers = new DecisionProviders(undefined);
    const status = await providers.handle({ action: 'update', autoApprove: false });
    expect(status.jev.autoApprove).toBe(false);
    expect(update.mock.calls).toEqual([['permissions.decisionModel', undefined, 1]]);
  });
  it('does not clear a native model when Jev is turned off', async () => {
    settings.set('permissions.decisionModel', 'typesafe-ai/jev');
    const providers = new DecisionProviders(undefined);
    await providers.handle({ action: 'update', autoApprove: false });
    expect(update).not.toHaveBeenCalled();
    expect(settings.get('permissions.decisionModel')).toBe('typesafe-ai/jev');
  });
  it.each([
    ['typesafe/jev-latest', undefined],
    ['typesafe-ai/jev', 'typesafe-ai/jev'],
  ])('disconnecting with %s selected leaves %s', async (selected, remaining) => {
    settings.set('permissions.decisionModel', selected);
    const { stored, storage } = secrets();
    // SAFETY: The fixture implements every SecretStorage member DecisionProviders calls.
    const providers = new DecisionProviders(storage as never);
    await providers.handle({ action: 'disconnect' });
    expect(stored.has('varro.typesafe.apiKey')).toBe(false);
    expect(settings.get('permissions.decisionModel')).toBe(remaining);
  });
});
