import { BrowserPersistence } from './browser-persistence';

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
  lastOpenedView: 'varro.lastOpenedView',
  showThinking: 'varro.showThinking',
  expandThinkingByDefault: 'varro.expandThinkingByDefault',
  showStickyUserPrompt: 'varro.showStickyUserPrompt',
  providerLimitWindow: 'varro.providerLimitWindow',
} as const;

const browserPersistence = new BrowserPersistence();

export function readStored<T>(key: string): T | null {
  return browserPersistence.get<T>(key) ?? null;
}

export function writeStored(key: string, value: unknown) {
  if (value === null || value === undefined) {
    browserPersistence.remove(key);
    return;
  }
  browserPersistence.set(key, value);
}
