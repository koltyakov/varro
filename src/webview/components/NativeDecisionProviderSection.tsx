import { createSignal, For, Show } from 'solid-js';
import type { DecisionProviderStatus } from '../../shared/protocol';
import { client } from '../lib/client';

export function NativeDecisionProviderSection(props: {
  status: NonNullable<DecisionProviderStatus['native']>;
  onStatusChange: (status: DecisionProviderStatus) => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const selected = () =>
    props.status.model ? `${props.status.model.providerID}/${props.status.model.modelID}` : '';
  const listed = () =>
    props.status.models.some((model) => `${model.providerID}/${model.modelID}` === selected());

  async function select(element: HTMLSelectElement) {
    if (busy()) return;
    const model = element.value;
    setBusy(true);
    setError('');
    try {
      props.onStatusChange(
        await client.varro.decisionProviders.update({ action: 'native', model })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      element.value = selected();
      setBusy(false);
    }
  }

  return (
    <section class="decision-provider" aria-label="Native decision model">
      <div class="decision-provider-header">
        <span class="decision-provider-name">OpenCode decision model</span>
      </div>
      <div class="decision-provider-body">
        <p class="decision-provider-description">
          Review Auto-mode permissions using the server's decision API and credentials. Only
          confident, low-risk answers approve actions. Errors fall back to the chat model judge.
          Selecting a model here replaces TypeSafe Jev. Models must be available in the server's
          base configuration.
        </p>
        <label class="decision-provider-option">
          <span>Permission reviewer</span>
          <select
            class="decision-provider-button"
            aria-label="Native permission reviewer"
            value={selected()}
            disabled={busy()}
            onChange={(event) => void select(event.currentTarget)}
          >
            <option value="">Off</option>
            <Show when={selected() && !listed()}>
              <option value={selected()}>{selected()} (unavailable)</option>
            </Show>
            <For each={props.status.models}>
              {(model) => (
                <option value={`${model.providerID}/${model.modelID}`}>
                  {model.name} ({model.providerID})
                </option>
              )}
            </For>
          </select>
        </label>
        <Show when={!props.status.supported}>
          <p class="decision-provider-description">
            Native decisions are unavailable on this server.
          </p>
        </Show>
        <Show when={error() || props.status.error}>
          <p role="alert" class="decision-provider-error">
            {error() || props.status.error}
          </p>
        </Show>
      </div>
    </section>
  );
}
