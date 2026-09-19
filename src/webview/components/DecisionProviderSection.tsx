import { Show, createSignal } from 'solid-js';
import type { DecisionProviderRequest, DecisionProviderStatus } from '../../shared/protocol';
import { client } from '../lib/client';
import { navArrowRightIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';

export type JevStatus = DecisionProviderStatus['jev'];

/** A connected TypeSafe Jev decision model; connecting starts from the Models actions menu. */
export function DecisionProviderSection(props: {
  status: JevStatus;
  onStatusChange: (status: JevStatus) => void;
}) {
  const status = () => props.status;
  const [expanded, setExpanded] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  async function run(request: DecisionProviderRequest) {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      props.onStatusChange((await client.varro.decisionProviders.update(request)).jev);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="decision-provider">
      <div class="decision-provider-header">
        <button
          type="button"
          class="decision-provider-toggle"
          aria-expanded={expanded()}
          onClick={() => setExpanded((open) => !open)}
        >
          <UiIcon
            source={navArrowRightIcon}
            class={`models-chevron ${expanded() ? 'expanded' : ''}`}
            width={12}
            height={12}
          />
          <span class="decision-provider-name">TypeSafe Jev</span>
        </button>
        <button
          type="button"
          class="decision-provider-button"
          disabled={busy() || status().credentialSource === 'environment'}
          title={
            status().credentialSource === 'environment'
              ? 'Using TYPESAFE_API_KEY from the environment'
              : undefined
          }
          onClick={() => void run({ action: 'disconnect' })}
        >
          Disconnect
        </button>
      </div>

      <Show when={expanded()}>
        <div class="decision-provider-body">
          <p class="decision-provider-description">
            Jev returns typed decisions with calibrated probabilities instead of text. Varro only
            acts on confident answers; everything else falls back to the model judge or to you.
          </p>
          <label class="decision-provider-option">
            <input
              type="checkbox"
              class="models-checkbox decision-provider-checkbox"
              checked={status().autoApprove}
              disabled={busy()}
              onChange={(event) =>
                void run({ action: 'update', autoApprove: event.currentTarget.checked })
              }
            />
            <span class="decision-provider-option-text">
              <span class="decision-provider-option-name">Auto-approve decisions</span>
              <span class="decision-provider-option-hint">
                Judge permission requests in Auto mode before the model judge runs
              </span>
            </span>
          </label>
          <Show when={error()}>
            <p class="decision-provider-error" role="alert">
              {error()}
            </p>
          </Show>
        </div>
      </Show>
    </div>
  );
}
