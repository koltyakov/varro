import { produce } from 'solid-js/store';
import type { Command, Provider } from '../types';
import type { SelectedModel } from './app-state-types';
import type { McpStatus, ProviderLimitStatus } from '../../shared/protocol';
import type { ProviderAuthMethodsByProvider } from '../../shared/opencode-types';
import { setState, state } from './app-state';
import { STORAGE_KEYS, writeStored } from './state-storage';

export function getSelectedModelForSession(
  sessionId: string | null | undefined
): SelectedModel | null {
  if (!sessionId) return null;
  return state.sessionSelectedModels[sessionId] || null;
}

export function getModelVariantSelectionKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`;
}

export function getStoredVariantForModel(
  providerID: string | null | undefined,
  modelID: string | null | undefined
): string | null {
  if (!providerID || !modelID) return null;
  return state.modelVariantSelections[getModelVariantSelectionKey(providerID, modelID)] || null;
}

export function getSelectedAgentForSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return state.sessionSelectedAgents[sessionId] || null;
}

export function getSelectedMcpsForSession(sessionId: string | null | undefined): string[] | null {
  if (!sessionId) return null;
  return state.sessionSelectedMcps[sessionId] || null;
}

export function setSelectedModel(
  model: SelectedModel | null,
  options?: { sessionId?: string | null; persistGlobal?: boolean }
) {
  const persistGlobal = options?.persistGlobal ?? true;
  const sessionId = options?.sessionId;

  if (!modelsEqual(state.selectedModel, model)) {
    setState('selectedModel', model);
  }
  if (persistGlobal) writeStored(STORAGE_KEYS.selectedModel, model);

  if (model?.variant) {
    const key = getModelVariantSelectionKey(model.providerID, model.modelID);
    if (state.modelVariantSelections[key] !== model.variant) {
      const nextSelections = { ...state.modelVariantSelections, [key]: model.variant };
      setState('modelVariantSelections', nextSelections);
      writeStored(STORAGE_KEYS.modelVariantSelections, nextSelections);
    }
  }

  if (sessionId) {
    if (model) {
      setState('sessionSelectedModels', sessionId, model);
    } else {
      setState(
        'sessionSelectedModels',
        produce((draft) => {
          delete draft[sessionId];
        })
      );
    }
    writeStored(STORAGE_KEYS.sessionSelectedModels, { ...state.sessionSelectedModels });
  }
}

export function clearSelectedModelForSession(sessionId: string) {
  if (!state.sessionSelectedModels[sessionId]) return;
  setState(
    'sessionSelectedModels',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionSelectedModels, { ...state.sessionSelectedModels });
}

export function setMcpStatus(status: Record<string, McpStatus>) {
  setState('mcpStatus', status);
}

export function getAvailableMcpNames() {
  return Object.keys(state.mcpStatus).toSorted((a, b) => a.localeCompare(b));
}

export function setSelectedMcpsForSession(sessionId: string, names: string[]) {
  const nextNames = [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
  setState('sessionSelectedMcps', sessionId, nextNames);
  writeStored(STORAGE_KEYS.sessionSelectedMcps, { ...state.sessionSelectedMcps });
}

export function clearSelectedMcpsForSession(sessionId: string) {
  if (!state.sessionSelectedMcps[sessionId]) return;
  setState(
    'sessionSelectedMcps',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionSelectedMcps, { ...state.sessionSelectedMcps });
}

export function setProviderAuthMethods(methods: ProviderAuthMethodsByProvider) {
  setState('providerAuthMethods', methods);
}

export function setCommands(commands: Command[]) {
  setState('commands', commands);
}

export function setSelectedAgent(
  agent: string | null,
  options?: { sessionId?: string | null; persistGlobal?: boolean }
) {
  const persistGlobal = options?.persistGlobal ?? true;
  const sessionId = options?.sessionId;

  if (state.selectedAgent !== agent) {
    setState('selectedAgent', agent);
  }
  if (persistGlobal) writeStored(STORAGE_KEYS.selectedAgent, agent);

  if (sessionId) {
    if (agent) {
      setState('sessionSelectedAgents', sessionId, agent);
    } else {
      setState(
        'sessionSelectedAgents',
        produce((draft) => {
          delete draft[sessionId];
        })
      );
    }
    writeStored(STORAGE_KEYS.sessionSelectedAgents, { ...state.sessionSelectedAgents });
  }
}

export function clearSelectedAgentForSession(sessionId: string) {
  if (!state.sessionSelectedAgents[sessionId]) return;
  setState(
    'sessionSelectedAgents',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionSelectedAgents, { ...state.sessionSelectedAgents });
}

export function modelVisibilityKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`;
}

export function isProviderVisible(providerID: string) {
  return !state.hiddenProviders.includes(providerID);
}

export function isModelVisible(providerID: string, modelID: string) {
  return (
    isProviderVisible(providerID) &&
    !state.hiddenModels.includes(modelVisibilityKey(providerID, modelID))
  );
}

export function getVisibleProviders(providers: Provider[]) {
  return providers
    .filter((provider) => isProviderVisible(provider.id))
    .map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models).filter(([modelID]) => isModelVisible(provider.id, modelID))
      ),
    }))
    .filter((provider) => Object.keys(provider.models).length > 0);
}

export function getProviderLimitKey(
  providerID: string | null | undefined,
  modelID: string | null | undefined
) {
  const providerKey = providerID?.trim();
  if (!providerKey) return '';
  return `${providerKey}:${modelID?.trim() || ''}`;
}

export function getProviderLimit(
  providerID: string | null | undefined,
  modelID: string | null | undefined
) {
  const key = getProviderLimitKey(providerID, modelID);
  return key ? state.providerLimits[key] || null : null;
}

export function setProviderLimit(
  providerID: string | null | undefined,
  modelID: string | null | undefined,
  limit: ProviderLimitStatus | null
) {
  const key = getProviderLimitKey(providerID, modelID);
  if (!key) return;

  setState(
    'providerLimits',
    produce((current) => {
      if (limit === null) {
        delete current[key];
        return;
      }

      current[key] = limit;
    })
  );
}

export function setProviderVisible(providerID: string, visible: boolean) {
  const next = visible
    ? state.hiddenProviders.filter((item) => item !== providerID)
    : [...state.hiddenProviders.filter((item) => item !== providerID), providerID];

  setState('hiddenProviders', next);
  writeStored(STORAGE_KEYS.hiddenProviders, next);

  if (!visible && state.selectedModel?.providerID === providerID) {
    setSelectedModel(null);
  }
}

export function setModelVisible(providerID: string, modelID: string, visible: boolean) {
  const key = modelVisibilityKey(providerID, modelID);
  const next = visible
    ? state.hiddenModels.filter((item) => item !== key)
    : [...state.hiddenModels.filter((item) => item !== key), key];

  setState('hiddenModels', next);
  writeStored(STORAGE_KEYS.hiddenModels, next);

  if (visible && !isProviderVisible(providerID)) {
    const nextProviders = state.hiddenProviders.filter((item) => item !== providerID);
    setState('hiddenProviders', nextProviders);
    writeStored(STORAGE_KEYS.hiddenProviders, nextProviders);

    const provider = state.providers.find((p) => p.id === providerID);
    if (provider) {
      const otherKeys = Object.keys(provider.models)
        .filter((id) => id !== modelID)
        .map((id) => modelVisibilityKey(providerID, id));
      const nextHidden = [...next, ...otherKeys.filter((k) => !next.includes(k))];
      setState('hiddenModels', nextHidden);
      writeStored(STORAGE_KEYS.hiddenModels, nextHidden);
    }
  }

  if (
    !visible &&
    state.selectedModel?.providerID === providerID &&
    state.selectedModel.modelID === modelID
  ) {
    setSelectedModel(null);
  }
}

export function resetModelVisibility() {
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  writeStored(STORAGE_KEYS.hiddenProviders, []);
  writeStored(STORAGE_KEYS.hiddenModels, []);
}

export function resolveSelectedModel(
  selectedModel: SelectedModel | null,
  providers: Provider[],
  _providerDefaults: Record<string, string>
): SelectedModel | null {
  const candidate = selectedModel;
  if (!candidate) return null;

  const provider = providers.find((item) => item.id === candidate.providerID);
  const model = provider?.models[candidate.modelID];
  if (!provider || !model) return null;
  if (!isModelVisible(candidate.providerID, candidate.modelID)) return null;
  if (candidate.variant && !model.variants?.[candidate.variant]) {
    return { providerID: candidate.providerID, modelID: candidate.modelID };
  }
  return candidate;
}

function modelsEqual(a: SelectedModel | null, b: SelectedModel | null) {
  return (
    a?.providerID === b?.providerID &&
    a?.modelID === b?.modelID &&
    (a?.variant || null) === (b?.variant || null)
  );
}
