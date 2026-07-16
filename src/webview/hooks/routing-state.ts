import type { SelectedModel } from '../lib/app-state-types';
import { resolveSelectedModel } from '../lib/state';
import type { Agent, MessageEntry, Provider } from '../types';

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

export function deriveSelectedModelFromMessages(messages: MessageEntry[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role === 'user') {
      return message.model;
    }
    return {
      providerID: message.providerID,
      modelID: message.modelID,
      variant: message.variant,
    } satisfies SelectedModel;
  }

  return null;
}

export function deriveSelectedAgentFromMessages(messages: MessageEntry[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]?.info;
    if (!message) continue;
    if (message.role === 'user') return message.agent;
    if (message.agent) return message.agent;
  }

  return null;
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
    const firstProvider = args.providers[0]!;
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
  activeSessionId?: string | null;
  selectedModel: SelectedModel | null;
  providers: Provider[];
  providerDefaults: Record<string, string>;
  getActiveRalphModel?: (
    sessionId: string | null
  ) => { providerID: string; modelID?: string | null } | null;
}) {
  const ralphModel = args.getActiveRalphModel?.(args.activeSessionId ?? null);
  if (ralphModel?.providerID) {
    return { providerID: ralphModel.providerID, modelID: ralphModel.modelID };
  }

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

export function getUsageLimitNoticeContext(args: {
  sessionId: string;
  messages?: MessageEntry[];
  selectedModelForSession: SelectedModel | null;
  providers: Provider[];
  providerDefaults: Record<string, string>;
  fallbackSelectedModel: SelectedModel | null;
}) {
  const selected = resolveSelectedModel(
    args.selectedModelForSession,
    args.providers,
    args.providerDefaults
  );
  if (selected) {
    return { providerID: selected.providerID, modelID: selected.modelID };
  }

  const derived = resolveSelectedModel(
    deriveSelectedModelFromMessages(args.messages || []),
    args.providers,
    args.providerDefaults
  );
  if (derived) {
    return { providerID: derived.providerID, modelID: derived.modelID };
  }

  return getActiveProviderSelection({
    selectedModel: args.fallbackSelectedModel,
    providers: args.providers,
    providerDefaults: args.providerDefaults,
  });
}
