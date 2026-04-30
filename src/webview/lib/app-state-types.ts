export type SelectedModel = { providerID: string; modelID: string; variant?: string };

export type SessionSelectedAgents = Record<string, string>;
export type SessionSelectedModels = Record<string, SelectedModel>;
export type SessionSelectedMcps = Record<string, string[]>;

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
}

export interface ClipboardImage {
  id: string;
  url: string;
  mime: string;
  filename: string;
  size: number;
}
