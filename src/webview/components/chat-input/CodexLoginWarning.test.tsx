import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { codexLoginWarningDismissal } from '../../lib/codex-login-warning';
import {
  providerConnectionRequest,
  resetProviderConnectionState,
} from '../../lib/provider-connection-state';
import { STORAGE_KEYS, writeStored } from '../../lib/state-storage';
import { CodexLoginWarning } from './CodexLoginWarning';

function tokenSharing(connectionID = 'connection-a'): ProviderLimitStatus {
  return {
    providerID: 'openai',
    status: 'unsupported',
    source: 'provider',
    checkedAt: 1,
    note: 'Token sharing cannot read quotas',
    codexLoginRequired: { connectionID },
  };
}

let container: HTMLDivElement;
let dispose: (() => void) | undefined;

beforeEach(() => {
  writeStored(STORAGE_KEYS.codexLoginWarningDismissal, null);
  codexLoginWarningDismissal.reload();
  resetProviderConnectionState();
  container = document.createElement('div');
  document.body.append(container);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  container.remove();
  codexLoginWarningDismissal.reset();
  resetProviderConnectionState();
});

function mount(initial: ProviderLimitStatus | null = tokenSharing()) {
  const [limit, setLimit] = createSignal(initial);
  const mountBanner = () => {
    dispose = render(() => <CodexLoginWarning limit={limit()} />, container);
  };
  mountBanner();
  return {
    setLimit,
    remount() {
      dispose?.();
      mountBanner();
    },
  };
}

function banner() {
  return container.querySelector('.chat-codex-login-warning');
}

function dismiss() {
  container
    .querySelector<HTMLButtonElement>('[aria-label="Dismiss Codex sign-in notice"]')!
    .click();
}

describe('CodexLoginWarning', () => {
  it('shows the exact notice using the existing non-critical quota warning panel', () => {
    mount();
    expect(banner()?.textContent).toContain('Sign in via Codex to see usage limits');
    expect(banner()?.classList.contains('chat-quota-warning')).toBe(true);
    expect(banner()?.classList.contains('error')).toBe(false);
    expect(banner()?.querySelector('[role="status"]')).not.toBeNull();
  });

  it('requests the Codex browser flow without starting authentication', () => {
    mount();
    container.querySelector<HTMLButtonElement>('.chat-quota-warning-usage')!.click();
    expect(providerConnectionRequest()).toMatchObject({
      providerID: 'openai',
      methodID: 'chatgpt-browser',
    });
    expect(banner()).not.toBeNull();
  });

  it('persists dismissal across polls, model changes, token refresh snapshots, and remounts', () => {
    const view = mount();
    dismiss();
    expect(banner()).toBeNull();
    view.setLimit({ ...tokenSharing(), checkedAt: 20, modelID: 'another-model' });
    expect(banner()).toBeNull();
    view.remount();
    expect(banner()).toBeNull();
    expect(codexLoginWarningDismissal.read()).toEqual({
      connectionID: 'connection-a',
      dismissed: true,
    });
  });

  it('shows the notice again for a changed account or reauthenticated credential', () => {
    const view = mount();
    dismiss();
    view.setLimit(tokenSharing('connection-b'));
    expect(banner()).not.toBeNull();
    view.setLimit(tokenSharing('connection-a'));
    expect(banner()).not.toBeNull();
  });

  it('resets dismissal after explicit reauthentication even when the connection ID is unchanged', () => {
    mount();
    dismiss();
    codexLoginWarningDismissal.reset();
    expect(banner()).not.toBeNull();
  });

  it('hides after switching to Codex and does not retain the old account dismissal', () => {
    const view = mount();
    dismiss();
    view.setLimit({
      providerID: 'openai',
      status: 'available',
      source: 'provider',
      checkedAt: 2,
      windows: [],
    });
    expect(banner()).toBeNull();
    expect(codexLoginWarningDismissal.read()).toBeNull();
    view.setLimit(tokenSharing());
    expect(banner()).not.toBeNull();
  });

  it.each<ProviderLimitStatus | null>([
    null,
    { providerID: 'openai', status: 'error', source: 'provider', checkedAt: 1, note: 'Timed out' },
    {
      providerID: 'openai',
      status: 'unsupported',
      source: 'provider',
      checkedAt: 1,
      note: 'No credentials',
    },
    { ...tokenSharing(), providerID: 'anthropic' },
  ])('does not infer token-sharing authentication from unavailable limits: %j', (limit) => {
    mount(limit);
    expect(banner()).toBeNull();
  });

  it('preserves dismissal through transient errors and other providers', () => {
    const view = mount();
    dismiss();
    view.setLimit({
      providerID: 'openai',
      status: 'error',
      source: 'provider',
      checkedAt: 2,
      note: 'Timed out',
    });
    view.setLimit({
      providerID: 'anthropic',
      status: 'available',
      source: 'provider',
      checkedAt: 2,
      windows: [],
    });
    view.setLimit(tokenSharing());
    expect(banner()).toBeNull();
  });

  it('synchronizes dismissals from storage and ignores malformed saved choices', () => {
    writeStored(STORAGE_KEYS.codexLoginWarningDismissal, { connectionID: 42, dismissed: true });
    mount();
    expect(banner()).not.toBeNull();
    writeStored(STORAGE_KEYS.codexLoginWarningDismissal, {
      connectionID: 'connection-a',
      dismissed: true,
    });
    window.dispatchEvent(
      new StorageEvent('storage', { key: STORAGE_KEYS.codexLoginWarningDismissal })
    );
    expect(banner()).toBeNull();
  });

  it('does not let a mounted stale account snapshot undo another composer dismissal', () => {
    dispose = render(
      () => (
        <>
          <CodexLoginWarning limit={tokenSharing('old-account')} />
          <CodexLoginWarning limit={tokenSharing('current-account')} />
        </>
      ),
      container
    );
    const notices = container.querySelectorAll('.chat-codex-login-warning');
    expect(notices).toHaveLength(2);
    notices[1]!.querySelector<HTMLButtonElement>('.chat-quota-warning-close')!.click();
    expect(container.querySelectorAll('.chat-codex-login-warning')).toHaveLength(1);
    expect(codexLoginWarningDismissal.read()).toEqual({
      connectionID: 'current-account',
      dismissed: true,
    });
  });
});
