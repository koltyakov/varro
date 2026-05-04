import { createEffect, on, onCleanup, untrack } from 'solid-js';
import type { ProviderLimitStatus } from '../../../shared/protocol';

type ProviderSelection = { providerID: string; modelID?: string | null };

export function registerLoadingStatusPollEffect(deps: {
  isLoading(): boolean;
  getActiveSessionId(): string | null;
  isDocumentVisible(): boolean;
  recheckSessionStatus(sessionId: string): void;
}) {
  createEffect(() => {
    const loading = deps.isLoading();
    const sessionId = deps.getActiveSessionId();
    const visible = deps.isDocumentVisible();
    if (!loading || !sessionId || !visible) return;

    let delay = 8000;
    const schedulePoll = () => {
      return setTimeout(() => {
        const activeSessionId = deps.getActiveSessionId();
        if (!deps.isLoading() || !activeSessionId || !deps.isDocumentVisible()) return;
        deps.recheckSessionStatus(activeSessionId);
        delay = Math.min(delay * 2, 60_000);
        timer = schedulePoll();
      }, delay);
    };
    let timer = schedulePoll();

    onCleanup(() => clearTimeout(timer));
  });
}

export function registerProviderLimitRefreshEffect(deps: {
  getServerState(): string;
  areProvidersLoaded(): boolean;
  isDocumentVisible(): boolean;
  getActiveProviderSelection(): ProviderSelection | null;
  getProviderLimit(
    providerID: string,
    modelID?: string | null
  ): ProviderLimitStatus | null | undefined;
  loadProviderLimit(
    providerID: string,
    modelID?: string | null
  ): Promise<ProviderLimitStatus | null>;
  setProviderLimit(
    providerID: string,
    modelID: string | null | undefined,
    limit: ProviderLimitStatus | null
  ): void;
  getPollIntervalMs(): number;
  logError(context: string, err: unknown): void;
}) {
  createEffect(
    on(
      () => {
        const visible = deps.isDocumentVisible();
        if (deps.getServerState() !== 'running' || !deps.areProvidersLoaded() || !visible)
          return '';
        if (deps.getPollIntervalMs() < 0) return '';
        const active = deps.getActiveProviderSelection();
        if (!active) return '';
        return `${active.providerID}\u0000${active.modelID ?? ''}`;
      },
      (key) => {
        if (!key) return;
        const active = untrack(() => deps.getActiveProviderSelection());
        if (!active) return;
        const existingLimit = untrack(() =>
          deps.getProviderLimit(active.providerID, active.modelID)
        );
        if (existingLimit?.status === 'unsupported') return;

        let cancelled = false;
        let inFlight = false;
        const refresh = async () => {
          if (cancelled || inFlight || !deps.isDocumentVisible()) return;
          inFlight = true;
          try {
            const limit = await deps.loadProviderLimit(active.providerID, active.modelID);
            if (!cancelled) {
              deps.setProviderLimit(active.providerID, active.modelID, limit);
            }
          } catch (err) {
            deps.logError('loadProviderLimit', err);
          } finally {
            inFlight = false;
          }
        };

        void refresh();
        const pollIntervalMs = untrack(() => deps.getPollIntervalMs());
        const timer = window.setInterval(() => {
          void refresh();
        }, pollIntervalMs);

        onCleanup(() => {
          cancelled = true;
          window.clearInterval(timer);
        });
      }
    )
  );
}
