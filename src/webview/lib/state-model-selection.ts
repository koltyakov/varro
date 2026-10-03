import { produce, reconcile } from 'solid-js/store';
import type { Command, Provider } from '../types';
import type { SelectedModel } from './app-state-types';
import type { McpStatus, ModelPreferences, ProviderLimitStatus } from '../../shared/protocol';
import { JEV_DECISION_PROVIDER_ID } from '../../shared/protocol';
import type { ProviderAuthMethodsByProvider } from '../../shared/opencode-types';
import { setState, showSessionPicker, state } from './app-state';
import { postMessage } from './bridge';
import { providerRequiresReconnection } from './provider-connection-state';
import { STORAGE_KEYS, writeStored } from './state-storage';
import { writeStoredSelectedModelForWorkspace } from './state-stored-values';
import { isActiveSessionWorking, isSessionTreeStatusWorking } from './state-session-lifecycle';

export const LARGE_MODEL_CATALOG_THRESHOLD = 50;
const MANAGED_MODEL_CATALOG_MARKER = '*';
const pendingAgentSelections = new Map<string, string>();
const pendingModelSelections = new Map<string, string>();
const activeTurnComposerModels = new Map<string, SelectedModel>();
const activeTurnComposerAgents = new Map<string, string>();

function getProtectedSessionAgent(sessionId: string) {
  if (pendingAgentSelections.has(sessionId)) return state.sessionSelectedAgents[sessionId];
  const working =
    sessionId === state.activeSessionId
      ? isActiveSessionWorking()
      : isSessionTreeStatusWorking(sessionId);
  if (!working) activeTurnComposerAgents.delete(sessionId);
  return activeTurnComposerAgents.get(sessionId);
}

function getActiveTurnComposerModel(sessionId: string) {
  const working =
    sessionId === state.activeSessionId
      ? isActiveSessionWorking()
      : isSessionTreeStatusWorking(sessionId);
  if (!working) {
    activeTurnComposerModels.delete(sessionId);
    return null;
  }
  return activeTurnComposerModels.get(sessionId) ?? null;
}

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
    rememberLastSelected?: boolean;
    rememberVariant?: string | null;
    selectionId?: string;
  }
) {
  const persistGlobal = options?.persistGlobal ?? true;
  const preferencesBase = persistGlobal ? getModelPreferencesSnapshot() : null;
  let preferencesChanged = false;
  const sessionId = options?.sessionId;
  if (sessionId && options?.selectionId) pendingModelSelections.set(sessionId, options.selectionId);
  if (sessionId) {
    const activeTurnModel = getActiveTurnComposerModel(sessionId);
    if (options?.selectionId && model) activeTurnComposerModels.set(sessionId, { ...model });
    else if (!persistGlobal && activeTurnModel) model = { ...activeTurnModel };
  } else if (!persistGlobal && !showSessionPicker() && state.activeSessionId) {
    const activeTurnModel = getActiveTurnComposerModel(state.activeSessionId);
    if (activeTurnModel) model = { ...activeTurnModel };
  }
  const currentSessionModel = sessionId ? state.sessionSelectedModels[sessionId] : undefined;
  const previousSessionModel: SelectedModel | null = currentSessionModel
    ? { ...currentSessionModel }
    : null;

  if (!modelsEqual(state.selectedModel, model)) {
    setState('selectedModel', reconcile(model ? { ...model } : null));
  }
  if (persistGlobal) {
    writeStoredSelectedModelForWorkspace(state.editorContext.workspacePath, model);
    if (
      model &&
      options?.rememberLastSelected !== false &&
      !modelsEqual(state.lastSelectedModel, model)
    ) {
      setState('lastSelectedModel', reconcile({ ...model }));
      writeStored(STORAGE_KEYS.lastSelectedModel, model);
      preferencesChanged = true;
    }
  }

  const rememberedVariant =
    options && 'rememberVariant' in options ? options.rememberVariant : model?.variant;
  if (persistGlobal && model && rememberedVariant !== undefined) {
    const key = getModelVariantSelectionKey(model.providerID, model.modelID);
    if (state.modelVariantSelections[key] !== rememberedVariant) {
      const nextSelections = { ...state.modelVariantSelections, [key]: rememberedVariant };
      setState('modelVariantSelections', nextSelections);
      writeStored(STORAGE_KEYS.modelVariantSelections, nextSelections);
      preferencesChanged = true;
    }
  }
  if (preferencesChanged && preferencesBase) publishModelPreferences(preferencesBase);

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
  pendingModelSelections.delete(sessionId);
  activeTurnComposerModels.delete(sessionId);
  if (!state.sessionSelectedModels[sessionId]) return;
  setState(
    'sessionSelectedModels',
    produce((draft) => {
      delete draft[sessionId];
    })
  );
  writeStored(STORAGE_KEYS.sessionSelectedModels, { ...state.sessionSelectedModels });
}

export function applySessionSelectedModelsSnapshot(
  models: Record<string, SelectedModel>,
  acknowledgement?: { sessionId: string; selectionId: string }
) {
  if (
    acknowledgement &&
    pendingModelSelections.get(acknowledgement.sessionId) === acknowledgement.selectionId
  ) {
    pendingModelSelections.delete(acknowledgement.sessionId);
  }
  models = { ...models };
  // Session metadata describes the running turn, not the next composer choice.
  // Keep a local choice through streaming snapshots even after its write is acknowledged.
  for (const sessionId of activeTurnComposerModels.keys()) {
    const selected = getActiveTurnComposerModel(sessionId);
    if (selected) models[sessionId] = { ...selected };
  }
  for (const sessionId of pendingModelSelections.keys()) {
    const pending = state.sessionSelectedModels[sessionId];
    if (pending) models[sessionId] = { ...pending };
  }
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
  const selectionId =
    sessionId && agent && options?.publishHost !== false ? crypto.randomUUID() : undefined;
  if (sessionId && selectionId && agent) {
    pendingAgentSelections.set(sessionId, selectionId);
    activeTurnComposerAgents.set(sessionId, agent);
  } else if (sessionId && options?.publishHost === false) {
    // Loaded metadata describes the running turn, not a newer composer choice.
    agent = getProtectedSessionAgent(sessionId) ?? agent;
  }
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
    if (agent && selectionId) {
      postMessage({
        type: 'session-plan-state/update',
        payload: { sessionId, agent, selectionId },
      });
    }
  }
}

export function hydrateSessionSelectedAgents(agents: Record<string, string>) {
  const nextAgents = { ...state.sessionSelectedAgents };
  let changed = false;
  for (const [sessionId, agent] of Object.entries(agents)) {
    if (getProtectedSessionAgent(sessionId)) continue;
    if (nextAgents[sessionId] === agent) continue;
    nextAgents[sessionId] = agent;
    changed = true;
  }
  if (!changed) return;

  setState('sessionSelectedAgents', reconcile(nextAgents));
  writeStored(STORAGE_KEYS.sessionSelectedAgents, nextAgents);
}

export function applySessionSelectedAgentUpdate(
  sessionId: string,
  agent: string | undefined,
  selectionId?: string
) {
  // Matching by agent is insufficient for Ask -> Build -> Ask -> Build switches.
  // Only the acknowledgement of the latest local selection may release this guard.
  const pending = pendingAgentSelections.get(sessionId);
  if (pending && pending !== selectionId) return;
  pendingAgentSelections.delete(sessionId);
  if (agent === undefined) {
    activeTurnComposerAgents.delete(sessionId);
    return;
  }
  // Explicit writes from another view remain authoritative. Unversioned snapshots
  // must not replace a choice made while the current turn is still running.
  if (selectionId && activeTurnComposerAgents.has(sessionId)) {
    activeTurnComposerAgents.set(sessionId, agent);
  }
  setSelectedAgent(agent, {
    sessionId,
    persistGlobal: false,
    updateSelection: !showSessionPicker() && state.activeSessionId === sessionId,
    publishHost: false,
  });
}

export function clearSelectedAgentForSession(sessionId: string) {
  pendingAgentSelections.delete(sessionId);
  activeTurnComposerAgents.delete(sessionId);
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

/** Provider and model names for a permission reviewer route, including TypeSafe Jev. */
export function getReviewerModelNames(route: { providerID: string; modelID: string }) {
  if (route.providerID === JEV_DECISION_PROVIDER_ID) {
    return { providerName: 'TypeSafe', modelName: route.modelID.replace(/^jev-/, 'Jev ') };
  }
  const provider = state.providers.find((item) => item.id === route.providerID);
  const model = provider
    ? Object.values(provider.models).find((item) => item.id === route.modelID)
    : null;
  return {
    providerName: provider?.name || route.providerID,
    modelName: getModelDisplayName(route.providerID, route.modelID, model?.name || route.modelID),
  };
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
    (isLargeModelCatalog(provider)
      ? isModelAdded(providerID, modelID)
      : !state.removedModels.includes(modelVisibilityKey(providerID, modelID)))
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
  const provider = state.providers.find((item) => item.id === providerID);
  const currentModelIDs = provider
    ? getListedProviderModels(provider).map((model) => model.id)
    : state.addedModels
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
    provider
      ? getListedProviderModels(provider).map((model) => model.id)
      : state.addedModels
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

  if (provider && !isLargeModelCatalog(provider)) {
    const selected = new Set(nextModelIDs);
    const removed = [
      ...state.removedModels.filter(
        (key) =>
          !key.startsWith(prefix) ||
          (!provider.models[key.slice(prefix.length)] && !selected.has(key.slice(prefix.length)))
      ),
      ...Object.keys(provider.models)
        .filter((modelID) => !selected.has(modelID))
        .map((modelID) => modelVisibilityKey(providerID, modelID)),
    ];
    setState('removedModels', removed);
    writeStored(STORAGE_KEYS.removedModels, removed);
  }

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
  return Object.values(provider.models).filter((model) =>
    isLargeModelCatalog(provider)
      ? isModelAdded(provider.id, model.id)
      : !state.removedModels.includes(modelVisibilityKey(provider.id, model.id))
  );
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

      if (current[key] && current[key].checkedAt > limit.checkedAt) return;
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

export function getModelPreferencesSnapshot(): ModelPreferences {
  const preferences: ModelPreferences = {
    modelVariantSelections: { ...state.modelVariantSelections },
    providerOrder: [...state.providerOrder],
    modelOrder: [...state.modelOrder],
    hiddenProviders: [...state.hiddenProviders],
    hiddenModels: [...state.hiddenModels],
    addedModels: [...state.addedModels],
    removedModels: [...state.removedModels],
    pinnedModels: [...state.pinnedModels],
    modelDisplayNames: { ...state.modelDisplayNames },
  };
  if (state.lastSelectedModel) preferences.lastSelectedModel = { ...state.lastSelectedModel };
  return preferences;
}

export function applyModelPreferencesSnapshot(preferences: ModelPreferences) {
  setState(
    'lastSelectedModel',
    reconcile(preferences.lastSelectedModel ? { ...preferences.lastSelectedModel } : null)
  );
  writeStored(STORAGE_KEYS.lastSelectedModel, preferences.lastSelectedModel ?? null);
  setState('modelVariantSelections', reconcile(preferences.modelVariantSelections));
  setState('providerOrder', reconcile(preferences.providerOrder));
  setState('modelOrder', reconcile(preferences.modelOrder));
  setState('hiddenProviders', reconcile(preferences.hiddenProviders));
  setState('hiddenModels', reconcile(preferences.hiddenModels));
  setState('addedModels', reconcile(preferences.addedModels));
  setState('removedModels', reconcile(preferences.removedModels ?? []));
  setState('pinnedModels', reconcile(preferences.pinnedModels));
  setState('modelDisplayNames', reconcile(preferences.modelDisplayNames));
  writeStored(STORAGE_KEYS.modelVariantSelections, preferences.modelVariantSelections);
  writeStored(STORAGE_KEYS.providerOrder, preferences.providerOrder);
  writeStored(STORAGE_KEYS.modelOrder, preferences.modelOrder);
  writeStored(STORAGE_KEYS.hiddenProviders, preferences.hiddenProviders);
  writeStored(STORAGE_KEYS.hiddenModels, preferences.hiddenModels);
  writeStored(STORAGE_KEYS.addedModels, preferences.addedModels);
  writeStored(STORAGE_KEYS.removedModels, preferences.removedModels ?? []);
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
