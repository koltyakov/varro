import type { QueuedContextSnapshot } from '../../shared/protocol';
import type { Provider } from '../types';

type QueuedModelSnapshot = NonNullable<QueuedContextSnapshot['editorContext']['queuedModel']>;

/** Apply captured send capabilities without publishing a temporary provider catalog. */
export function applyQueuedModelCapabilities(
  providers: Provider[],
  snapshot: QueuedModelSnapshot
): Provider[] {
  const { providerID, modelID } = snapshot.selection;
  const provider = providers.find((item) => item.id === providerID);
  const existingModel = provider?.models[modelID];
  const existingInput = existingModel?.capabilities.input;
  const input = Array.isArray(existingInput)
    ? snapshot.capabilities.pdf
      ? [...new Set([...existingInput, 'pdf'])]
      : existingInput.filter((modality) => modality !== 'pdf')
    : existingInput
      ? { ...existingInput, pdf: snapshot.capabilities.pdf }
      : snapshot.capabilities.pdf
        ? ['pdf']
        : undefined;
  const variant = snapshot.selection.variant;
  const model = {
    ...(existingModel ?? {
      id: modelID,
      name: modelID,
      cost: { input: 0, output: 0 },
    }),
    capabilities: {
      ...existingModel?.capabilities,
      vision: snapshot.capabilities.vision,
      toolcall: snapshot.capabilities.tools,
      input,
    },
    variants: variant
      ? { ...existingModel?.variants, [variant]: existingModel?.variants?.[variant] ?? {} }
      : existingModel?.variants,
  };
  if (provider) {
    return providers.map((item) =>
      item === provider ? { ...item, models: { ...item.models, [modelID]: model } } : item
    );
  }
  return [
    ...providers,
    {
      id: providerID,
      name: providerID,
      source: 'custom',
      models: { [modelID]: model },
    },
  ];
}
