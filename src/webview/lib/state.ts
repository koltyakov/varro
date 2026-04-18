import { createSignal } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import type {
  Session,
  Message,
  Part,
  Permission,
  Todo,
  SessionStatus,
  FileDiff,
  Agent,
  Provider,
} from '../types';
import type { EditorContext, DroppedFile, ServerStatus } from '../../shared/protocol';

const STORAGE_KEYS = {
  selectedAgent: 'opencode.selectedAgent',
  selectedModel: 'opencode.selectedModel',
  hiddenProviders: 'opencode.hiddenProviders',
  hiddenModels: 'opencode.hiddenModels',
} as const;

export type SelectedModel = { providerID: string; modelID: string; variant?: string };

function readStored<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    if (value === null || value === undefined) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

interface AppState {
  serverStatus: ServerStatus;
  editorContext: EditorContext;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
  sessions: Session[];
  activeSessionId: string | null;
  sessionStatus: Record<string, SessionStatus>;
  messages: Array<{ info: Message; parts: Part[] }>;
  todos: Todo[];
  permissions: Permission[];
  diffs: FileDiff[];
  streamingPartId: string | null;
  streamingText: string;
  agents: Agent[];
  providers: Provider[];
  providerDefaults: Record<string, string>;
  selectedAgent: string | null;
  selectedModel: SelectedModel | null;
  hiddenProviders: string[];
  hiddenModels: string[];
}

export interface ClipboardImage {
  id: string;
  url: string;
  mime: string;
  filename: string;
  size: number;
}

export const [state, setState] = createStore<AppState>({
  serverStatus: { state: 'stopped' },
  editorContext: { workspacePath: null, activeFile: null, selection: null, diagnostics: [] },
  droppedFiles: [],
  clipboardImages: [],
  sessions: [],
  activeSessionId: null,
  sessionStatus: {},
  messages: [],
  todos: [],
  permissions: [],
  diffs: [],
  streamingPartId: null,
  streamingText: '',
  agents: [],
  providers: [],
  providerDefaults: {},
  selectedAgent: readStored<string>(STORAGE_KEYS.selectedAgent),
  selectedModel: readStored<SelectedModel>(STORAGE_KEYS.selectedModel),
  hiddenProviders: readStored<string[]>(STORAGE_KEYS.hiddenProviders) || [],
  hiddenModels: readStored<string[]>(STORAGE_KEYS.hiddenModels) || [],
});

export const [inputText, setInputText] = createSignal('');
export const [isLoading, setIsLoading] = createSignal(false);
export const [error, setError] = createSignal<string | null>(null);
export const [showSessionPicker, setShowSessionPicker] = createSignal(false);
export const [showModelPicker, setShowModelPicker] = createSignal(false);
export const [showSettings, setShowSettings] = createSignal(false);
export const [theme, setTheme] = createSignal<'dark' | 'light'>(
  ((window as any).__initialTheme as 'dark' | 'light') || 'dark'
);

export function addContextFile(file: DroppedFile) {
  setState(
    'droppedFiles',
    produce((files) => {
      if (!files.find((f) => f.path === file.path)) {
        files.push(file);
      }
    })
  );
}

export function removeContextFile(path: string) {
  setState(
    'droppedFiles',
    produce((files) => {
      const idx = files.findIndex((f) => f.path === path);
      if (idx !== -1) files.splice(idx, 1);
    })
  );
}

export function clearContextFiles() {
  setState('droppedFiles', []);
}

export function addClipboardImage(image: ClipboardImage) {
  setState(
    'clipboardImages',
    produce((images) => {
      if (!images.find((item) => item.id === image.id)) {
        images.push(image);
      }
    })
  );
}

export function removeClipboardImage(id: string) {
  setState(
    'clipboardImages',
    produce((images) => {
      const idx = images.findIndex((item) => item.id === id);
      if (idx !== -1) images.splice(idx, 1);
    })
  );
}

export function clearClipboardImages() {
  setState('clipboardImages', []);
}

export function setSelectedAgent(agent: string | null) {
  setState('selectedAgent', agent);
  writeStored(STORAGE_KEYS.selectedAgent, agent);
}

export function setSelectedModel(model: SelectedModel | null) {
  setState('selectedModel', model);
  writeStored(STORAGE_KEYS.selectedModel, model);
}

export function modelVisibilityKey(providerID: string, modelID: string) {
  return `${providerID}:${modelID}`;
}

export function isProviderVisible(providerID: string) {
  return !state.hiddenProviders.includes(providerID);
}

export function isModelVisible(providerID: string, modelID: string) {
  return (
    isProviderVisible(providerID) &&
    !state.hiddenModels.includes(modelVisibilityKey(providerID, modelID))
  );
}

export function getVisibleProviders(providers: Provider[]) {
  return providers
    .filter((provider) => isProviderVisible(provider.id))
    .map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models).filter(([modelID]) => isModelVisible(provider.id, modelID))
      ),
    }))
    .filter((provider) => Object.keys(provider.models).length > 0);
}

export function setProviderVisible(providerID: string, visible: boolean) {
  const next = visible
    ? state.hiddenProviders.filter((item) => item !== providerID)
    : [...state.hiddenProviders.filter((item) => item !== providerID), providerID];

  setState('hiddenProviders', next);
  writeStored(STORAGE_KEYS.hiddenProviders, next);

  if (!visible && state.selectedModel?.providerID === providerID) {
    setSelectedModel(null);
  }
}

export function setModelVisible(providerID: string, modelID: string, visible: boolean) {
  const key = modelVisibilityKey(providerID, modelID);
  const next = visible
    ? state.hiddenModels.filter((item) => item !== key)
    : [...state.hiddenModels.filter((item) => item !== key), key];

  setState('hiddenModels', next);
  writeStored(STORAGE_KEYS.hiddenModels, next);

  if (
    !visible &&
    state.selectedModel?.providerID === providerID &&
    state.selectedModel.modelID === modelID
  ) {
    setSelectedModel(null);
  }
}

export function resetModelVisibility() {
  setState('hiddenProviders', []);
  setState('hiddenModels', []);
  writeStored(STORAGE_KEYS.hiddenProviders, []);
  writeStored(STORAGE_KEYS.hiddenModels, []);
}

export function resolveSelectedModel(
  selectedModel: SelectedModel | null,
  providers: Provider[],
  _providerDefaults: Record<string, string>
): SelectedModel | null {
  const candidate = selectedModel;
  if (!candidate) return null;

  const provider = providers.find((item) => item.id === candidate.providerID);
  const model = provider?.models[candidate.modelID];
  if (!provider || !model) return null;
  if (!isModelVisible(candidate.providerID, candidate.modelID)) return null;
  if (candidate.variant && !model.variants?.[candidate.variant]) {
    return { providerID: candidate.providerID, modelID: candidate.modelID };
  }
  return candidate;
}

export function upsertMessage(msg: { info: Message; parts: Part[] }) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = msgs.findIndex((m) => m.info.id === msg.info.id);
      if (idx !== -1) {
        msgs[idx] = msg;
      } else {
        msgs.push(msg);
      }
    })
  );
}

export function upsertMessageInfo(info: Message) {
  setState(
    'messages',
    produce((msgs) => {
      const idx = msgs.findIndex((m) => m.info.id === info.id);
      if (idx !== -1) {
        msgs[idx].info = info;
      } else {
        msgs.push({ info, parts: [] });
      }
    })
  );
}

export function upsertPart(part: Part) {
  setState(
    'messages',
    produce((msgs) => {
      const msgId = (part as any).messageID;
      const msg = msgs.find((m) => m.info.id === msgId);
      if (!msg) return;
      const idx = msg.parts.findIndex((p) => p.id === part.id);
      if (idx !== -1) msg.parts[idx] = part;
      else msg.parts.push(part);
    })
  );
}

export function updateMessagePart(part: Part) {
  setState(
    'messages',
    produce((msgs) => {
      for (const msg of msgs) {
        const idx = msg.parts.findIndex((p) => p.id === part.id);
        if (idx !== -1) {
          msg.parts[idx] = part;
          break;
        }
      }
    })
  );
}

export function applyMessagePartDelta(
  messageId: string,
  partId: string,
  delta: string,
  sessionId?: string,
  field = 'text'
) {
  if (field !== 'text' || !delta) return;

  setState(
    'messages',
    produce((msgs) => {
      const msg = msgs.find((item) => item.info.id === messageId);
      if (!msg) return;

      let part = msg.parts.find(
        (item): item is Part & { type: 'text'; text: string } =>
          item.id === partId && item.type === 'text'
      );

      if (!part) {
        part = {
          id: partId,
          messageID: messageId,
          sessionID: sessionId || msg.info.sessionID,
          type: 'text',
          text: '',
        };
        msg.parts.push(part);
      }

      part.text += delta;
    })
  );
}

export function removeMessagePart(sessionId: string, messageId: string, partId: string) {
  setState(
    'messages',
    produce((msgs) => {
      for (const msg of msgs) {
        if (msg.info.sessionID === sessionId && msg.info.id === messageId) {
          const idx = msg.parts.findIndex((p) => p.id === partId);
          if (idx !== -1) msg.parts.splice(idx, 1);
          break;
        }
      }
    })
  );
}

export function addPermission(permission: Permission) {
  setState(
    'permissions',
    produce((perms) => {
      if (!perms.find((p) => p.id === permission.id)) {
        perms.push(permission);
      }
    })
  );
}

export function removePermission(permissionId: string) {
  setState(
    'permissions',
    produce((perms) => {
      const idx = perms.findIndex((p) => p.id === permissionId);
      if (idx !== -1) perms.splice(idx, 1);
    })
  );
}

export function clearMessages() {
  setState('messages', []);
  setState('permissions', []);
  setState('todos', []);
  setState('diffs', []);
  setState('streamingPartId', null);
  setState('streamingText', '');
}
