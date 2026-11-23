import type { SelectedModel } from './app-state-types';
import { state } from './app-state';
import { getStoredVariantForModel, resolveSelectedModel } from './state-model-selection';
import { readStoredSelectedModelForWorkspace } from './state-stored-values';

// Mirrors OpenCode's TUI: each composer scope remembers the model last used with
// each agent, and an agent's configured model seeds the choice otherwise.
const rememberedAgentModels = new Map<string, Map<string, SelectedModel>>();

function scopeKey(sessionId: string | null | undefined) {
  return sessionId ? `session:${sessionId}` : `draft:${state.editorContext.workspacePath ?? ''}`;
}

function copyModel(model: SelectedModel): SelectedModel {
  return model.variant
    ? { providerID: model.providerID, modelID: model.modelID, variant: model.variant }
    : { providerID: model.providerID, modelID: model.modelID };
}

function sameRoute(a: SelectedModel | null | undefined, b: SelectedModel | null | undefined) {
  return !!a && !!b && a.providerID === b.providerID && a.modelID === b.modelID;
}

function sameModel(a: SelectedModel | null | undefined, b: SelectedModel | null | undefined) {
  return sameRoute(a, b) && (a?.variant || null) === (b?.variant || null);
}

function availableModel(model: SelectedModel | null | undefined, allowHidden: boolean) {
  if (!model) return null;
  return resolveSelectedModel(copyModel(model), state.providers, state.providerDefaults, {
    allowHidden,
  });
}

function getRememberedAgentModel(sessionId: string | null | undefined, agent: string) {
  return availableModel(rememberedAgentModels.get(scopeKey(sessionId))?.get(agent), true);
}

/** The agent's configured model, when the connected catalog can run it. */
export function getAgentConfiguredModel(agentName: string | null | undefined) {
  if (!agentName) return null;
  const agent =
    state.agents.find((item) => item.name === agentName) ??
    state.allAgents.find((item) => item.name === agentName);
  const configured = agent?.model;
  if (!agent || !configured?.providerID || !configured.modelID) return null;
  // A remembered reasoning choice wins over the agent default, as in OpenCode.
  const stored = getStoredVariantForModel(configured.providerID, configured.modelID);
  const variant = stored !== undefined ? stored : (configured.variant ?? agent.variant);
  return availableModel(
    variant
      ? { providerID: configured.providerID, modelID: configured.modelID, variant }
      : { providerID: configured.providerID, modelID: configured.modelID },
    true
  );
}

/** Records the composer model the user chose while this agent was selected. */
export function rememberAgentModel(
  sessionId: string | null | undefined,
  agent: string | null | undefined,
  model: SelectedModel | null | undefined
) {
  if (!agent || !model?.providerID || !model.modelID) return;
  const key = scopeKey(sessionId);
  let models = rememberedAgentModels.get(key);
  if (!models) {
    models = new Map();
    rememberedAgentModels.set(key, models);
  }
  models.set(agent, copyModel(model));
}

/** The model a new chat starts with for this agent, or null to keep the folder default. */
export function resolveNewChatAgentModel(agent: string | null | undefined) {
  if (!agent) return null;
  return getRememberedAgentModel(null, agent) ?? getAgentConfiguredModel(agent);
}

/**
 * Resolves the composer model after the user picks another agent.
 * Returns null when the current model should stay.
 */
export function resolveAgentSwitchModel(args: {
  sessionId: string | null | undefined;
  previousAgent: string | null | undefined;
  nextAgent: string;
  currentModel: SelectedModel | null | undefined;
}): SelectedModel | null {
  const { sessionId, previousAgent, nextAgent, currentModel } = args;
  if (previousAgent === nextAgent) return null;
  // Sessions keep each agent's choice so switching back restores it.
  if (sessionId) rememberAgentModel(sessionId, previousAgent, currentModel);

  const candidate =
    getRememberedAgentModel(sessionId, nextAgent) ?? getAgentConfiguredModel(nextAgent);
  if (candidate) return sameModel(candidate, currentModel) ? null : candidate;

  // An agent without its own model returns to the user's choice instead of
  // inheriting the previous agent's configured model.
  if (!sameRoute(currentModel, getAgentConfiguredModel(previousAgent))) return null;
  const fallback =
    availableModel(readStoredSelectedModelForWorkspace(state.editorContext.workspacePath), false) ??
    availableModel(state.lastSelectedModel, false);
  return fallback && !sameModel(fallback, currentModel) ? fallback : null;
}
