import type { Agent, Command, Provider } from '../../types';
import type { ProviderLimitStatus } from '../../../shared/protocol';
import { getSupersededModelIds } from '../model-ordering';
import { STORAGE_KEYS, writeStored } from '../state-storage';
import {
  clearSelectedAgentForSession,
  clearSelectedMcpsForSession,
  clearSelectedModelForSession,
  getAvailableMcpNames,
  getPersistedSelectedAgent,
  getPersistedSelectedModel,
  getProviderLimit,
  getSelectedAgentForSession,
  getSelectedMcpsForSession,
  getSelectedModelForSession,
  getVisibleProviders,
  isModelVisible,
  isProviderVisible,
  modelVisibilityKey,
  resetModelVisibility,
  resolveSelectedModel,
  setCommands,
  setMcpStatus,
  setModelVisible,
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
  clearSelectedMcpsForSession,
  resolveSelectedModel,
  setMcpStatus,
  setProviderAuthMethods,
  setWorkspaceStatuses,
  getAvailableMcpNames,
  setCommands,
  getProviderLimit,
  setProviderLimit,
  modelVisibilityKey,
  isProviderVisible,
  isModelVisible,
  getVisibleProviders,
  setProviderVisible,
  setModelVisible,
  resetModelVisibility,
  setAllAgents(agents: Agent[]) {
    setState('allAgents', agents);
  },
  setPrimaryAgents(agents: Agent[]) {
    setState('agents', agents);
  },
  setProvidersLoaded(value: boolean) {
    setState('providersLoaded', value);
  },
  setProviders(
    providers: Provider[],
    defaults: Record<string, string> = {},
    newlyConnectedProviderIDs: readonly string[] = []
  ) {
    const newlyConnectedProviderSet = new Set(newlyConnectedProviderIDs);
    const nextHiddenModels = new Set(state.hiddenModels);

    for (const provider of providers) {
      if (!newlyConnectedProviderSet.has(provider.id)) continue;

      const protectedModelIDs = new Set([
        defaults[provider.id],
        state.selectedModel?.providerID === provider.id ? state.selectedModel.modelID : undefined,
      ]);
      for (const modelID of getSupersededModelIds(Object.values(provider.models))) {
        if (!protectedModelIDs.has(modelID)) {
          nextHiddenModels.add(modelVisibilityKey(provider.id, modelID));
        }
      }
    }

    if (nextHiddenModels.size !== state.hiddenModels.length) {
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
