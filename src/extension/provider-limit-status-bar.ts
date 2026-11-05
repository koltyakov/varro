/* oxlint-disable anti-slop/no-runtime-typeof -- Provider catalog responses are validated at this I/O boundary. */
import * as vscode from 'vscode';
import type {
  ModelPreferences,
  ProviderLimitStatus,
  ProviderLimitUpdate,
} from '../shared/protocol';
import { DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../shared/provider-limit-config';
import { formatProviderLimitStatusBar } from '../shared/provider-limit-summary';
import { compareProviderOrder, LARGE_MODEL_CATALOG_THRESHOLD } from '../shared/provider-order';
import { asRecord } from '../shared/type-utils';
import type { ProviderLimitService } from './provider-limit-service';
import type { OpenCodeServer } from './server';

type ProviderEntry = { id: string; name: string; modelIDs: string[] };

export class ProviderLimitStatusBar {
  private readonly item = vscode.window.createStatusBarItem(
    'varro.provider-limits',
    vscode.StatusBarAlignment.Right,
    1001
  );
  private readonly limits = new Map<string, ProviderLimitStatus>();
  private providers: ProviderEntry[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private generation = 0;
  private connectionKey = '';
  private preferencesKey = '';
  private refreshError: string | undefined;
  private directory: string | undefined;
  private running = false;
  private disposed = false;

  constructor(
    private readonly server: Pick<OpenCodeServer, 'request' | 'status'>,
    private readonly service: Pick<ProviderLimitService, 'get'>,
    private readonly readPreferences: () => ModelPreferences
  ) {
    this.item.name = 'Pinned Provider Limits';
  }

  updateConnection(directory?: string) {
    if (this.disposed) return;
    const status = this.server.status;
    const key = JSON.stringify([
      status.state,
      status.state === 'running' ? status.url : '',
      directory,
    ]);
    if (key === this.connectionKey) return;
    this.connectionKey = key;
    this.directory = directory;
    this.running = status.state === 'running';
    this.generation += 1;
    this.providers = [];
    this.limits.clear();
    this.preferencesKey = '';
    this.refreshError = undefined;
    this.preferencesChanged();
  }

  preferencesChanged() {
    if (this.disposed) return;
    const preferences = this.readPreferences();
    const key = JSON.stringify([
      preferences.providerLimitPins,
      preferences.providerOrder,
      preferences.hiddenProviders,
      preferences.hiddenModels,
      preferences.addedModels,
      preferences.removedModels,
    ]);
    if (key === this.preferencesKey) return;
    this.preferencesKey = key;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pins = preferences.providerLimitPins ?? {};
    for (const providerID of this.limits.keys()) {
      if (!Object.hasOwn(pins, providerID)) this.limits.delete(providerID);
    }
    this.render();
    if (!this.running || Object.keys(pins).length === 0) return;
    void this.refresh();
    this.timer = setInterval(
      () => void this.refresh(),
      DEFAULT_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS * 1000
    );
  }

  acceptUpdate(update: ProviderLimitUpdate) {
    if (this.disposed || !this.running || update.directory !== (this.directory ?? null)) return;
    if (!Object.hasOwn(this.readPreferences().providerLimitPins ?? {}, update.status.providerID))
      return;
    // Provider-wide polls own this display, not whichever model a composer happens to select.
    if (update.status.modelID) return;
    this.limits.set(update.status.providerID, update.status);
    this.render();
  }

  dispose() {
    this.disposed = true;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }

  async refresh() {
    if (this.disposed) return;
    const generation = ++this.generation;
    const isCurrent = () => !this.disposed && generation === this.generation;
    const preferences = this.readPreferences();
    if (!this.running || !Object.keys(preferences.providerLimitPins ?? {}).length) return;
    try {
      const raw = asRecord(
        await this.server.request('GET', '/config/providers', undefined, {
          directory: this.directory,
        })
      );
      if (!isCurrent()) return;
      const providers: ProviderEntry[] = [];
      for (const value of Array.isArray(raw?.providers) ? raw.providers : []) {
        const provider = asRecord(value);
        if (typeof provider?.id !== 'string' || typeof provider.name !== 'string') continue;
        providers.push({
          id: provider.id,
          name: provider.name,
          modelIDs: Object.keys(asRecord(provider.models) ?? {}),
        });
      }
      this.providers = providers;
      this.refreshError = undefined;
      this.render();
      await Promise.all(
        providers
          .filter((provider) => Object.hasOwn(preferences.providerLimitPins ?? {}, provider.id))
          .map(async (provider) => {
            const limit = await this.service.get(provider.id, null, this.directory);
            if (!isCurrent()) return;
            this.limits.set(provider.id, limit);
            this.render();
          })
      );
    } catch (error) {
      if (!isCurrent()) return;
      this.refreshError = `Could not refresh pinned provider limits: ${error instanceof Error ? error.message : String(error)}`;
      this.render();
    }
  }

  private render() {
    const preferences = this.readPreferences();
    const pins = preferences.providerLimitPins ?? {};
    const sortedLast = (provider: ProviderEntry) => {
      const listed = provider.modelIDs.filter((modelID) =>
        provider.modelIDs.length >= LARGE_MODEL_CATALOG_THRESHOLD
          ? preferences.addedModels.includes(`${provider.id}:${modelID}`)
          : !preferences.removedModels?.includes(`${provider.id}:${modelID}`)
      );
      return (
        preferences.hiddenProviders.includes(provider.id) ||
        listed.every((modelID) => preferences.hiddenModels.includes(`${provider.id}:${modelID}`))
      );
    };
    const providers = this.providers
      .flatMap((provider) => {
        if (!Object.hasOwn(pins, provider.id)) return [];
        const limit = this.limits.get(provider.id);
        const summary = limit ? formatProviderLimitStatusBar(limit) : '';
        return summary ? [{ ...provider, summary }] : [];
      })
      .toSorted(
        (a, b) =>
          Number(sortedLast(a)) - Number(sortedLast(b)) ||
          compareProviderOrder(a, b, preferences.providerOrder)
      );
    if (!this.running || !providers.length) {
      this.item.text = '';
      this.item.tooltip = '';
      this.item.hide();
      return;
    }
    this.item.text = providers
      .map((provider) => {
        const name = (pins[provider.id]?.trim() || provider.name).replace(/\$\(/g, '\\$(');
        return `${name}: ${provider.summary}`;
      })
      .join(' · ');
    this.item.tooltip =
      providers
        .map((provider) => {
          const limit = this.limits.get(provider.id);
          return `${provider.name}: ${provider.summary}${limit?.note ? `\n${limit.note}` : ''}`;
        })
        .join('\n\n') +
      (this.refreshError ? `\n\n${this.refreshError}` : '') +
      '\n\nPercentages show remaining quota. Manage pins and names in the provider list.';
    this.item.show();
  }
}
