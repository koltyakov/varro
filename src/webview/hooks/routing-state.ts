import { resolveSelectedModel, type SelectedModel } from '../lib/state';
import type { Agent, Provider } from '../types';

type AgentSelectionUpdate = {
  value: string | null;
  options: { sessionId?: string | null; persistGlobal: boolean };
};

export function getDefaultPrimaryAgentName(agents: Agent[]) {
  return agents.find((agent) => agent.name === 'build')?.name || agents[0]?.name || null;
}

export function getBuildAgentName(agents: Agent[]) {
  return agents.find((agent) => agent.name === 'build')?.name || null;
}

export function reconcileLoadedAgents(args: {
  loadedAgents: Agent[];
  activeSessionId: string | null;
  selectedAgent: string | null;
  sessionSelectedAgent: string | null;
  persistedSelectedAgent: string | null;
}) {
  const visibleAgents = args.loadedAgents.filter((agent) => !agent.hidden);
  const primaryAgents = visibleAgents.filter((agent) => agent.mode !== 'subagent');
  let nextSelectedAgent: AgentSelectionUpdate | null = null;

  if (args.selectedAgent && !primaryAgents.some((agent) => agent.name === args.selectedAgent)) {
    nextSelectedAgent = {
      value: null,
      options: {
        sessionId: args.activeSessionId,
        persistGlobal: !args.activeSessionId,
      },
    };
  } else if (!args.activeSessionId) {
    const defaultAgent = getDefaultPrimaryAgentName(primaryAgents);
    if (defaultAgent && args.selectedAgent !== defaultAgent) {
      nextSelectedAgent = {
        value: defaultAgent,
        options: { persistGlobal: false },
      };
    }
  } else if (!args.selectedAgent) {
    const fallback = [
      args.sessionSelectedAgent,
      getDefaultPrimaryAgentName(primaryAgents),
      args.persistedSelectedAgent,
    ].find(
      (candidate): candidate is string =>
        !!candidate && primaryAgents.some((agent) => agent.name === candidate)
    );
    if (fallback) {
      nextSelectedAgent = {
        value: fallback,
        options: {
          sessionId: args.activeSessionId,
          persistGlobal: false,
        },
      };
    }
  }

  return { visibleAgents, primaryAgents, nextSelectedAgent };
}

export function reconcileLoadedProviders(args: {
  selectedModel: SelectedModel | null;
  providers: Provider[];
  providerDefaults: Record<string, string>;
}) {
  const effectiveModel = resolveSelectedModel(
    args.selectedModel,
    args.providers,
    args.providerDefaults
  );

  if (args.selectedModel && !effectiveModel) {
    return { effectiveModel, nextSelectedModel: null as SelectedModel | null | undefined };
  }

  if (effectiveModel && args.selectedModel?.variant && !effectiveModel.variant) {
    return {
      effectiveModel,
      nextSelectedModel: {
        providerID: effectiveModel.providerID,
        modelID: effectiveModel.modelID,
      } satisfies SelectedModel,
    };
  }

  if (!args.selectedModel && args.providers.length > 0) {
    const firstProvider = args.providers[0];
    const defaultModelID = args.providerDefaults[firstProvider.id];
    const modelID = defaultModelID || Object.keys(firstProvider.models)[0];
    if (modelID) {
      return {
        effectiveModel,
        nextSelectedModel: {
          providerID: firstProvider.id,
          modelID,
        } satisfies SelectedModel,
      };
    }
  }

  return { effectiveModel, nextSelectedModel: undefined };
}

export function getActiveProviderSelection(args: {
  selectedModel: SelectedModel | null;
  providers: Provider[];
  providerDefaults: Record<string, string>;
}) {
  const selected = resolveSelectedModel(args.selectedModel, args.providers, args.providerDefaults);
  if (selected) {
    return { providerID: selected.providerID, modelID: selected.modelID };
  }

  const firstProvider = args.providers[0];
  if (!firstProvider) return null;

  const defaultModelID = args.providerDefaults[firstProvider.id];
  const fallbackModelID =
    (defaultModelID && firstProvider.models[defaultModelID] ? defaultModelID : null) ||
    Object.keys(firstProvider.models)[0];
  if (!fallbackModelID) return null;

  return { providerID: firstProvider.id, modelID: fallbackModelID };
}
