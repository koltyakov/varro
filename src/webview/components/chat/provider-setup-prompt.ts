import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js';

const PROVIDER_SETUP_RETRIES = 3;
const PROVIDER_SETUP_RETRY_MS = 2_000;

/**
 * Decides when to offer provider setup. A server that is starting, waking from
 * sleep or reloading can briefly report no providers, so an empty catalog is
 * re-read a few times before the prompt appears.
 */
export function createProviderSetupPrompt(deps: {
  isReady: Accessor<boolean>;
  hasProviders: Accessor<boolean>;
  refreshProviders: () => Promise<void>;
}): Accessor<boolean> {
  const [confirmedEmpty, setConfirmedEmpty] = createSignal(false);
  let check: { cancelled: boolean } | null = null;

  const cancelCheck = () => {
    if (check) check.cancelled = true;
    check = null;
  };

  const runCheck = async (current: { cancelled: boolean }) => {
    for (let retry = 0; retry < PROVIDER_SETUP_RETRIES; retry += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, PROVIDER_SETUP_RETRY_MS);
      });
      if (current.cancelled) return;
      try {
        await deps.refreshProviders();
      } catch {
        // A failed read is retried; the prompt only reflects a confirmed empty catalog.
      }
      if (current.cancelled) return;
    }
    if (check === current) check = null;
    if (!deps.hasProviders() && deps.isReady()) setConfirmedEmpty(true);
  };

  createEffect(
    () => ({
      hasProviders: deps.hasProviders(),
      ready: deps.isReady(),
      confirmed: confirmedEmpty(),
    }),
    ({ hasProviders, ready, confirmed }) => {
      if (hasProviders) {
        cancelCheck();
        setConfirmedEmpty(false);
        return;
      }
      if (!ready || check || confirmed) return;
      const current = { cancelled: false };
      check = current;
      void runCheck(current);
    }
  );
  onCleanup(cancelCheck);

  return () => confirmedEmpty() && !deps.hasProviders();
}
