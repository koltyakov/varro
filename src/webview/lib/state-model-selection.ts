import { produce, reconcile } from 'solid-js/store';
import type { Command, Provider } from '../types';
import type { SelectedModel } from './app-state-types';
import type { McpStatus, ProviderLimitStatus } from '../../shared/protocol';
import type { ProviderAuthMethodsByProvider } from '../../shared/opencode-types';
import { setState, showSessionPicker, state } from './app-state';
import { postMessage } from './bridge';
import { providerRequiresReconnection } from './provider-connection-state';
import { STORAGE_KEYS, writeStored } from './state-storage';
import { writeStoredSelectedModelForWorkspace } from './state-stored-values';

export const LARGE_MODEL_CATALOG_THRESHOLD = 50;
const MANAGED_MODEL_CATALOG_MARKER = '*';

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
): string | null | undefined {
  if (!providerID || !modelID) return undefined;
  return state.modelVariantSelections[getModelVariantSelectionKey(providerID, modelID)];
}

export function getSelectedAgentForSession(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return state.sessionSelectedAgents[sessionId] || null;
}

export function getSelectedMcpsForSession(sessionId: string | null | undefined): string[] | null {
  if (!sessionId) {
    return (
      state.draftSelectedMcps ??
      Object.entries(state.mcpStatus)
        .filter(([, value]) => value?.status === 'connected')
        .map(([name]) => name)
        .toSorted((a, b) => a.localeCompare(b))
    );
  }
  return state.sessionSelectedMcps[sessionId] || null;
}

export function setSelectedModel(
  model: SelectedModel | null,
  options?: {
    sessionId?: string | null;
    persistGlobal?: boolean;
    rememberVariant?: string | null;
  }
) {
  const persistGlobal = options?.persistGlobal ?? true;
  const sessionId = options?.sessionId;
  const currentSessionModel = sessionId ? state.sessionSelectedModels[sessionId] : undefined;
  const previousSessionModel: SelectedModel | null = currentSessionModel
    ? { ...currentSessionModel }
    : null;

  if (!modelsEqual(state.selectedModel, model)) {
    setState('selectedModel', reconcile(model));
  }
  if (persistGlobal) {
    writeStoredSelectedModelForWorkspace(state.editorContext.workspacePath, model);
  }

  const rememberedVariant =
    options && 'rememberVariant' in options ? options.rememberVariant : model?.variant;
  if (persistGlobal && model && rememberedVariant !== undefined) {
    const key = getModelVariantSelectionKey(model.providerID, model.modelID);
    if (state.modelVariantSelections[key] !== rememberedVariant) {
      const base = getModelPreferencesSnapshot();
      const nextSelections = { ...state.modelVariantSelections, [key]: rememberedVariant };
      setState('modelVariantSelections', nextSelections);
      writeStored(STORAGE_KEYS.modelVariantSelections, nextSelections);
      publishModelPreferences(base);
    }
  }

  if (sessionId) {
    if (!modelsEqual(previousSessionModel, model)) {
      if (model) {
        setState('sessionSelectedModels', sessionId, reconcile(model));
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

export function applySessionSelectedModelsSnapshot(models: Record<string, SelectedModel>) {
  if (!selectedModelRecordsEqual(state.sessionSelectedModels, models)) {
    setState('sessionSelectedModels', reconcile(models));
    writeStored(STORAGE_KEYS.sessionSelectedModels, models);
  }
  const sessionId = showSessionPicker() ? null : state.activeSessionId;
  const activeModel = sessionId ? models[sessionId] : undefined;
  if (sessionId && activeModel) {
    setSelectedModel(activeModel, { sessionId, persistGlobal: false });
  }
}

export function setMcpStatus(status: Record<string, McpStatus>) {
  setState('mcpStatus', status);
}

export function getAvailableMcpNames() {
  return Object.keys(state.mcpStatus).toSorted((a, b) => a.localeCompare(b));
}

export function setSelectedMcpsForSession(sessionId: string, names: string[]) {
  const nextNames = [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
  if (stringArraysEqual(state.sessionSelectedMcps[sessionId], nextNames)) return;
  setState('sessionSelectedMcps', sessionId, nextNames);
  writeStored(STORAGE_KEYS.sessionSelectedMcps, { ...state.sessionSelectedMcps });
}

export function setDraftSelectedMcps(names: string[]) {
  setState(
    'draftSelectedMcps',
    [...new Set(names)].toSorted((a, b) => a.localeCompare(b))
  );
}

export function resetDraftSelectedMcps() {
  setState('draftSelectedMcps', null);
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
  options?: {
    sessionId?: string | null;
    persistGlobal?: boolean;
    updateSelection?: boolean;
    publishHost?: boolean;
  }
) {
  const persistGlobal = options?.persistGlobal ?? true;
  const sessionId = options?.sessionId;
  const previousSessionAgent = sessionId ? state.sessionSelectedAgents[sessionId] : undefined;

  if (options?.updateSelection !== false && state.selectedAgent !== agent) {
    setState('selectedAgent', agent);
  }
  if (persistGlobal) writeStored(STORAGE_KEYS.selectedAgent, agent);

  if (sessionId) {
    const sessionAgentChanged = agent
      ? previousSessionAgent !== agent
      : previousSessionAgent !== undefined;
    if (sessionAgentChanged) {
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
    if (agent && sessionAgentChanged && options?.publishHost !== false) {
      postMessage({
        type: 'session-plan-state/update',
        payload: { sessionId, agent },
      });
    }
  }
}

export function hydrateSessionSelectedAgents(agents: Record<string, string>) {
  const nextAgents = { ...state.sessionSelectedAgents };
  let changed = false;
  for (const [sessionId, agent] of Object.entries(agents)) {
    if (nextAgents[sessionId] === agent) continue;
    nextAgents[sessionId] = agent;
    changed = true;
  }
  if (!changed) return;

  setState('sessionSelectedAgents', reconcile(nextAgents));
  writeStored(STORAGE_KEYS.sessionSelectedAgents, nextAgents);
}

export function applySessionSelectedAgentUpdate(sessionId: string, agent: string) {
  setSelectedAgent(agent, {
    sessionId,
    persistGlobal: false,
    updateSelection: !showSessionPicker() && state.activeSessionId === sessionId,
    publishHost: false,
  });
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

export function getModelDisplayName(providerID: string, modelID: string, fallbackName: string) {
  return state.modelDisplayNames[modelVisibilityKey(providerID, modelID)] || fallbackName;
}

export function setModelDisplayName(providerID: string, modelID: string, name: string) {
  const base = getModelPreferencesSnapshot();
  const key = modelVisibilityKey(providerID, modelID);
  const displayName = name.trim();
  const next = { ...state.modelDisplayNames };
  if (displayName) next[key] = displayName;
  else delete next[key];

  setState('modelDisplayNames', reconcile(next));
  writeStored(STORAGE_KEYS.modelDisplayNames, Object.keys(next).length > 0 ? next : null);
  publishModelPreferences(base);
}

export function isProviderVisible(providerID: string) {
  return !state.hiddenProviders.includes(providerID);
}

export function isLargeModelCatalog(provider: Provider) {
  return Object.keys(provider.models).length >= LARGE_MODEL_CATALOG_THRESHOLD;
}

export function isModelAdded(providerID: string, modelID: string) {
  return state.addedModels.includes(modelVisibilityKey(providerID, modelID));
}

export function hasManagedModelCatalog(providerID: string) {
  return isModelAdded(providerID, MANAGED_MODEL_CATALOG_MARKER);
}

export function isModelListed(providerID: string, modelID: string) {
  const provider = state.providers.find((item) => item.id === providerID);
  return (
    !provider ||
    (!isLargeModelCatalog(provider) && !hasManagedModelCatalog(providerID)) ||
    isModelAdded(providerID, modelID)
  );
}

export function isModelVisible(providerID: string, modelID: string) {
  return (
    isProviderVisible(providerID) &&
    isModelListed(providerID, modelID) &&
    !state.hiddenModels.includes(modelVisibilityKey(providerID, modelID))
  );
}

export function isModelPinned(providerID: string, modelID: string) {
  return state.pinnedModels.includes(modelVisibilityKey(providerID, modelID));
}

export function setModelPinned(providerID: string, modelID: string, pinned: boolean) {
  const base = getModelPreferencesSnapshot();
  const key = modelVisibilityKey(providerID, modelID);
  const next = pinned
    ? [...state.pinnedModels.filter((item) => item !== key), key]
    : state.pinnedModels.filter((item) => item !== key);

  setState('pinnedModels', next);
  writeStored(STORAGE_KEYS.pinnedModels, next);
  publishModelPreferences(base);
}

export function setProviderOrder(providerIDs: readonly string[]) {
  const base = getModelPreferencesSnapshot();
  const next = [...new Set(providerIDs)];
  setState('providerOrder', next);
  writeStored(STORAGE_KEYS.providerOrder, next);
  publishModelPreferences(base);
}

export function setModelOrder(providerID: string, modelIDs: readonly string[]) {
  const base = getModelPreferencesSnapshot();
  const prefix = `${providerID}:`;
  const next = [
    ...state.modelOrder.filter((key) => !key.startsWith(prefix)),
    ...[...new Set(modelIDs)].map((modelID) => modelVisibilityKey(providerID, modelID)),
  ];
  setState('modelOrder', next);
  writeStored(STORAGE_KEYS.modelOrder, next);
  publishModelPreferences(base);
}

export function setModelAdded(providerID: string, modelID: string, added: boolean) {
  const prefix = `${providerID}:`;
  const currentModelIDs = state.addedModels
    .filter((item) => item.startsWith(prefix))
    .map((item) => item.slice(prefix.length));
  setModelsAdded(
    providerID,
    added
      ? [...currentModelIDs.filter((item) => item !== modelID), modelID]
      : currentModelIDs.filter((item) => item !== modelID)
  );
}

export function setModelsAdded(providerID: string, modelIDs: readonly string[]) {
  const base = getModelPreferencesSnapshot();
  const prefix = `${providerID}:`;
  const provider = state.providers.find((item) => item.id === providerID);
  const usesManagedMarker = provider ? !isLargeModelCatalog(provider) : false;
  const wasManaged = provider
    ? isLargeModelCatalog(provider) || hasManagedModelCatalog(providerID)
    : false;
  const previousModelIDs = new Set(
    state.addedModels
      .filter((item) => item.startsWith(prefix))
      .map((item) => item.slice(prefix.length))
      .filter((modelID) => modelID !== MANAGED_MODEL_CATALOG_MARKER)
  );
  const nextModelIDs = [...new Set(modelIDs)].filter(
    (modelID) => modelID !== MANAGED_MODEL_CATALOG_MARKER
  );
  const next = [
    ...state.addedModels.filter((item) => !item.startsWith(prefix)),
    ...(usesManagedMarker ? [modelVisibilityKey(providerID, MANAGED_MODEL_CATALOG_MARKER)] : []),
    ...nextModelIDs.map((modelID) => modelVisibilityKey(providerID, modelID)),
  ];

  setState('addedModels', next);
  writeStored(STORAGE_KEYS.addedModels, next);
  publishModelPreferences(base);

  const newlyAddedModelIDs = wasManaged
    ? nextModelIDs.filter((modelID) => !previousModelIDs.has(modelID))
    : [];
  setModelsVisible(providerID, newlyAddedModelIDs, true);

  if (
    state.selectedModel?.providerID === providerID &&
    !nextModelIDs.includes(state.selectedModel.modelID)
  ) {
    setSelectedModel(null);
  }
}

export function getListedProviderModels(provider: Provider) {
  if (!isLargeModelCatalog(provider) && !hasManagedModelCatalog(provider.id)) {
    return Object.values(provider.models);
  }
  return Object.values(provider.models).filter((model) => isModelAdded(provider.id, model.id));
}

export function getVisibleProviders(providers: Provider[]) {
  return providers
    .filter(
      (provider) => isProviderVisible(provider.id) && !providerRequiresReconnection(provider.id)
    )
    .map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        getListedProviderModels(provider)
          .filter((model) => isModelVisible(provider.id, model.id))
          .map((model) => [model.id, model])
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
  const base = getModelPreferencesSnapshot();
  const next = visible
    ? state.hiddenProviders.filter((item) => item !== providerID)
    : [...state.hiddenProviders.filter((item) => item !== providerID), providerID];

  setState('hiddenProviders', next);
  writeStored(STORAGE_KEYS.hiddenProviders, next);
  publishModelPreferences(base);

  if (!visible && state.selectedModel?.providerID === providerID) {
    setSelectedModel(null);
  }
}

export function setModelVisible(providerID: string, modelID: string, visible: boolean) {
  setModelsVisible(providerID, [modelID], visible);
}

export function setModelsVisible(
  providerID: string,
  modelIDs: readonly string[],
  visible: boolean
) {
  const base = getModelPreferencesSnapshot();
  const keys = new Set(modelIDs.map((modelID) => modelVisibilityKey(providerID, modelID)));
  if (keys.size === 0) return;

  const next = visible
    ? state.hiddenModels.filter((item) => !keys.has(item))
    : [...state.hiddenModels.filter((item) => !keys.has(item)), ...keys];

  setState('hiddenModels', next);
  writeStored(STORAGE_KEYS.hiddenModels, next);

  publishModelPreferences(base);

  if (
    !visible &&
    state.selectedModel?.providerID === providerID &&
    modelIDs.includes(state.selectedModel.modelID)
  ) {
    setSelectedModel(null);
  }
}

export function resetModelVisibility() {
  const base = getModelPreferencesSnapshot();
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  writeStored(STORAGE_KEYS.hiddenProviders, []);
  writeStored(STORAGE_KEYS.hiddenModels, []);
  publishModelPreferences(base);
}

export function getModelPreferencesSnapshot() {
  return {
    modelVariantSelections: { ...state.modelVariantSelections },
    providerOrder: [...state.providerOrder],
    modelOrder: [...state.modelOrder],
    hiddenProviders: [...state.hiddenProviders],
    hiddenModels: [...state.hiddenModels],
    addedModels: [...state.addedModels],
    pinnedModels: [...state.pinnedModels],
    modelDisplayNames: { ...state.modelDisplayNames },
  };
}

export function applyModelPreferencesSnapshot(
  preferences: ReturnType<typeof getModelPreferencesSnapshot>
) {
  setState('modelVariantSelections', reconcile(preferences.modelVariantSelections));
  setState('providerOrder', reconcile(preferences.providerOrder));
  setState('modelOrder', reconcile(preferences.modelOrder));
  setState('hiddenProviders', reconcile(preferences.hiddenProviders));
  setState('hiddenModels', reconcile(preferences.hiddenModels));
  setState('addedModels', reconcile(preferences.addedModels));
  setState('pinnedModels', reconcile(preferences.pinnedModels));
  setState('modelDisplayNames', reconcile(preferences.modelDisplayNames));
  writeStored(STORAGE_KEYS.modelVariantSelections, preferences.modelVariantSelections);
  writeStored(STORAGE_KEYS.providerOrder, preferences.providerOrder);
  writeStored(STORAGE_KEYS.modelOrder, preferences.modelOrder);
  writeStored(STORAGE_KEYS.hiddenProviders, preferences.hiddenProviders);
  writeStored(STORAGE_KEYS.hiddenModels, preferences.hiddenModels);
  writeStored(STORAGE_KEYS.addedModels, preferences.addedModels);
  writeStored(STORAGE_KEYS.pinnedModels, preferences.pinnedModels);
  writeStored(STORAGE_KEYS.modelDisplayNames, preferences.modelDisplayNames);
}

function publishModelPreferences(base: ReturnType<typeof getModelPreferencesSnapshot>) {
  postMessage({
    type: 'model-preferences/update',
    payload: { base, preferences: getModelPreferencesSnapshot() },
  });
}

export function resolveSelectedModel(
  selectedModel: SelectedModel | null,
  providers: Provider[],
  _providerDefaults: Record<string, string>,
  options?: { allowHidden?: boolean }
): SelectedModel | null {
  const candidate = selectedModel;
  if (!candidate) return null;

  const provider = providers.find((item) => item.id === candidate.providerID);
  const model = provider?.models[candidate.modelID];
  if (!provider || !model) return null;
  if (!options?.allowHidden && !isModelVisible(candidate.providerID, candidate.modelID))
    return null;
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

function selectedModelRecordsEqual(
  a: Record<string, SelectedModel>,
  b: Record<string, SelectedModel>
) {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) => Object.hasOwn(b, key) && modelsEqual(a[key] ?? null, b[key] ?? null))
  );
}

function stringArraysEqual(a: readonly string[] | undefined, b: readonly string[]) {
  return !!a && a.length === b.length && a.every((value, index) => value === b[index]);
}
