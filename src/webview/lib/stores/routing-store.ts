import type { Agent, Command, Provider } from '../../types';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { getSupersededModelIds } from '../model-ordering';
import { STORAGE_KEYS, writeStored } from '../state-storage';
import {
  clearSelectedAgentForSession,
  clearSelectedMcpsForSession,
  clearSelectedModelForSession,
  getAvailableMcpNames,
  getListedProviderModels,
  getPersistedSelectedAgent,
  getPersistedSelectedModel,
  getProviderLimit,
  getSelectedAgentForSession,
  getSelectedMcpsForSession,
  getSelectedModelForSession,
  getVisibleProviders,
  isModelVisible,
  isLargeModelCatalog,
  isModelAdded,
  isProviderVisible,
  modelVisibilityKey,
  resetModelVisibility,
  resetDraftSelectedMcps,
  resolveSelectedModel,
  setCommands as setCommandsState,
  setDraftSelectedMcps,
  setMcpStatus,
  setModelVisible,
  setModelAdded,
  setModelsAdded,
  setModelsVisible,
  setProviderAuthMethods,
  setProviderLimit,
  setProviderVisible,
  setSelectedAgent,
  setSelectedMcpsForSession,
  setSelectedModel,
  setState,
  setWorkspaceStatuses,
  state,
} from '../state';

function releaseWorkspaceCatalogReloadLock() {
  if (state.providersLoaded && state.agentsLoaded && state.commandsLoaded) {
    setState('workspaceCatalogReloadPending', false);
  }
}

export const routingStore = {
  getPersistedSelectedModel,
  getPersistedSelectedAgent,
  getSelectedModelForSession,
  getSelectedAgentForSession,
  getSelectedMcpsForSession,
  setSelectedModel,
  clearSelectedModelForSession,
  setSelectedAgent,
  clearSelectedAgentForSession,
  setSelectedMcpsForSession,
  setDraftSelectedMcps,
  resetDraftSelectedMcps,
  clearSelectedMcpsForSession,
  resolveSelectedModel,
  setMcpStatus,
  setProviderAuthMethods,
  setWorkspaceStatuses,
  finishWorkspaceCatalogReload() {
    setState('workspaceCatalogReloadPending', false);
  },
  getAvailableMcpNames,
  setCommands(commands: Command[]) {
    setCommandsState(commands);
    setState('commandsLoaded', true);
    releaseWorkspaceCatalogReloadLock();
  },
  getProviderLimit,
  setProviderLimit,
  modelVisibilityKey,
  isProviderVisible,
  isModelVisible,
  getVisibleProviders,
  getListedProviderModels,
  isLargeModelCatalog,
  isModelAdded,
  setProviderVisible,
  setModelVisible,
  setModelAdded,
  setModelsAdded,
  setModelsVisible,
  resetModelVisibility,
  setAllAgents(agents: Agent[]) {
    setState('allAgents', agents);
  },
  setPrimaryAgents(agents: Agent[]) {
    setState('agents', agents);
    setState('agentsLoaded', true);
    releaseWorkspaceCatalogReloadLock();
  },
  setProvidersLoaded(value: boolean) {
    setState('providersLoaded', value);
    if (value) releaseWorkspaceCatalogReloadLock();
  },
  setProviders(
    providers: Provider[],
    defaults: Record<string, string> = {},
    newlyConnectedProviderIDs: readonly string[] = []
  ) {
    const newlyConnectedProviderSet = new Set(newlyConnectedProviderIDs);
    const nextHiddenModels = new Set(state.hiddenModels);
    let hiddenModelsChanged = false;

    for (const provider of providers) {
      if (!newlyConnectedProviderSet.has(provider.id)) continue;

      const protectedModelIDs = new Set([
        defaults[provider.id],
        state.selectedModel?.providerID === provider.id ? state.selectedModel.modelID : undefined,
      ]);
      for (const modelID of getSupersededModelIds(Object.values(provider.models))) {
        if (!protectedModelIDs.has(modelID)) {
          const previousSize = nextHiddenModels.size;
          nextHiddenModels.add(modelVisibilityKey(provider.id, modelID));
          hiddenModelsChanged ||= nextHiddenModels.size !== previousSize;
        }
      }
    }

    if (hiddenModelsChanged) {
      const hiddenModels = [...nextHiddenModels];
      setState('hiddenModels', hiddenModels);
      writeStored(STORAGE_KEYS.hiddenModels, hiddenModels);
    }
    setState('providers', providers);
  },
  setProviderDefaults(defaults: Record<string, string>) {
    setState('providerDefaults', defaults);
  },
  setProviderLimitStatus(
    providerID: string,
    modelID: string | null | undefined,
    limit: ProviderLimitStatus | null
  ) {
    setProviderLimit(providerID, modelID, limit);
  },
  getConnectedMcpNames() {
    return Object.entries(state.mcpStatus)
      .filter(([, value]) => value?.status === 'connected')
      .map(([name]) => name)
      .toSorted((a, b) => a.localeCompare(b));
  },
  hasCommand(name: string) {
    return state.commands.some((command: Command) => command.name === name);
  },
};

export type RoutingStore = typeof routingStore;
