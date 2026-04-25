export const STORAGE_KEYS = {
  selectedAgent: 'varro.selectedAgent',
  sessionSelectedAgents: 'varro.sessionSelectedAgents',
  skippedPlanSessions: 'varro.skippedPlanSessions',
  selectedModel: 'varro.selectedModel',
  sessionSelectedModels: 'varro.sessionSelectedModels',
  draftPermissionMode: 'varro.draftPermissionMode',
  sessionPermissionModes: 'varro.sessionPermissionModes',
  sessionSelectedMcps: 'varro.sessionSelectedMcps',
  projectPermissionModes: 'varro.projectPermissionModes',
  hiddenProviders: 'varro.hiddenProviders',
  hiddenModels: 'varro.hiddenModels',
  lastSeenSessions: 'varro.lastSeenSessions',
  lastActiveSessionId: 'varro.lastActiveSessionId',
  showThinking: 'varro.showThinking',
  expandThinkingByDefault: 'varro.expandThinkingByDefault',
  legacyexpandThinkingByDefault: 'varro.expandThinkingByDefault',
  showStickyUserPrompt: 'varro.showStickyUserPrompt',
} as const;

export function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(key);
      return;
    }
    const serialized = JSON.stringify(value);
    if (window.localStorage.getItem(key) === serialized) return;
    window.localStorage.setItem(key, serialized);
  } catch {}
}
