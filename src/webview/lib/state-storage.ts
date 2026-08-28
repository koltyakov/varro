import { BrowserPersistence } from './browser-persistence';

export const STORAGE_KEYS = {
  selectedAgent: 'varro.selectedAgent',
  sessionSelectedAgents: 'varro.sessionSelectedAgents',
  skippedPlanSessions: 'varro.skippedPlanSessions',
  selectedModel: 'varro.selectedModel',
  sessionSelectedModels: 'varro.sessionSelectedModels',
  modelVariantSelections: 'varro.modelVariantSelections',
  draftPermissionMode: 'varro.draftPermissionMode',
  sessionPermissionModes: 'varro.sessionPermissionModes',
  sessionSelectedMcps: 'varro.sessionSelectedMcps',
  projectPermissionModes: 'varro.projectPermissionModes',
  projectCurrentDocumentEnabled: 'varro.projectCurrentDocumentEnabled',
  hiddenProviders: 'varro.hiddenProviders',
  hiddenModels: 'varro.hiddenModels',
  addedModels: 'varro.addedModels',
  pinnedModels: 'varro.pinnedModels',
  modelDisplayNames: 'varro.modelDisplayNames',
  modelPickerOpened: 'varro.modelPickerOpened',
  lastSeenSessions: 'varro.lastSeenSessions',
  completedSessionResponses: 'varro.completedSessionResponses',
  unsharedSessions: 'varro.unsharedSessions',
  queuedMessages: 'varro.queuedMessages',
  queuedMessageEdit: 'varro.queuedMessageEdit',
  inputDraft: 'varro.inputDraft',
  inputDraftFiles: 'varro.inputDraftFiles',
  lastActiveSessionId: 'varro.lastActiveSessionId',
  lastOpenedView: 'varro.lastOpenedView',
  editorViewId: 'varro.editorViewId',
  workspacePath: 'varro.workspacePath',
  manualWorkspaceSelection: 'varro.manualWorkspaceSelection',
  showThinking: 'varro.showThinking',
  todoListCollapsed: 'varro.todoListCollapsed',
} as const;

const browserPersistence = new BrowserPersistence();

export function readStored<T>(key: string): T | null {
  return browserPersistence.get<T>(key) ?? null;
}

export function writeStored<T>(key: string, value: T) {
  if (value === null || value === undefined) {
    browserPersistence.remove(key);
    return;
  }
  browserPersistence.set(key, value);
}
