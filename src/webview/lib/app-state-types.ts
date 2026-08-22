import type {
  ChatModelSelection,
  ClipboardImageSnapshot,
  DroppedFile,
  EditorDiagnostic,
  QueuedContextSnapshot,
} from '../../shared/protocol';
import type { NativePdfAttachment } from '../../shared/native-pdf';

export type SelectedModel = ChatModelSelection;
export type SessionSelectionOptions = { markSeen?: boolean; selectedModel?: SelectedModel };
export type ModelVariantSelections = Record<string, string | null>;

export type SessionSelectedAgents = Record<string, string>;
export type SessionSelectedModels = Record<string, SelectedModel>;
export type SessionSelectedMcps = Record<string, string[]>;

export interface QueuedMessage {
  id: string;
  messageId?: string;
  sessionId: string;
  text: string;
  agent?: string;
  paused?: boolean;
  droppedFiles?: DroppedFile[];
  clipboardImages?: ClipboardImage[];
  nativePdfs?: NativePdfAttachment[];
  terminalSelection?: { text: string; terminalName: string } | null;
  attachedDiagnostics?: AttachedDiagnostics | null;
  queuedContext?: QueuedContextSnapshot;
}

export type { NativePdfAttachment };

export interface AttachedDiagnostics {
  diagnostics: EditorDiagnostic[];
  total: number;
}

export type ClipboardImage = ClipboardImageSnapshot;
