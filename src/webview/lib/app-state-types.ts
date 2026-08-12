import type { ChatModelSelection, DroppedFile, EditorDiagnostic } from '../../shared/protocol';

export type SelectedModel = ChatModelSelection;
export type SessionSelectionOptions = { markSeen?: boolean; selectedModel?: SelectedModel };
export type ModelVariantSelections = Record<string, string | null>;

export type SessionSelectedAgents = Record<string, string>;
export type SessionSelectedModels = Record<string, SelectedModel>;
export type SessionSelectedMcps = Record<string, string[]>;

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  agent?: string;
  paused?: boolean;
  droppedFiles?: DroppedFile[];
  clipboardImages?: ClipboardImage[];
  terminalSelection?: { text: string; terminalName: string } | null;
  attachedDiagnostics?: AttachedDiagnostics | null;
}

export interface AttachedDiagnostics {
  diagnostics: EditorDiagnostic[];
  total: number;
}

export interface ClipboardImage {
  id: string;
  url: string;
  mime: string;
  filename: string;
  size: number;
  contentKey?: string;
  attachmentSequence?: number;
}
