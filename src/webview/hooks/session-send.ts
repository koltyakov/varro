import type { DroppedFile, EditorContext } from '../../shared/protocol';
import {
  formatSelectionReference,
  getSelectionRangesFromEditorContext,
  hasExplicitContextForPath,
  subtractContextLineRanges,
} from '../../shared/context-files';
import { resolveSelectedModel, type ClipboardImage, type SelectedModel } from '../lib/state';
import { getPromptTextForClipboardImages } from '../lib/clipboard-images';
import { modelSupportsVision } from '../lib/model-capabilities';
import { getPreferredVariant } from '../lib/model-variants';
import { getWorkspaceRelativePath, isSamePath } from '../lib/path-display';
import type { Provider } from '../types';

type ComposerState = {
  selectedAgent: string | null;
  selectedModel: SelectedModel | null;
  providers: Provider[];
  providerDefaults: Record<string, string>;
  editorContext: EditorContext;
  terminalSelection: { text: string; terminalName: string } | null;
  droppedFiles: DroppedFile[];
  clipboardImages: ClipboardImage[];
};

export type SessionSendBody = {
  parts: Array<{
    type: string;
    text?: string;
    mime?: string;
    filename?: string;
    url?: string;
  }>;
  model?: { providerID: string; modelID: string };
  agent?: string;
  noReply?: boolean;
  variant?: string;
};

export function getAttachmentReference(
  file: { path: string; type: 'file' | 'directory' },
  workspacePath: string | null
) {
  const relativePath = getWorkspaceRelativePath(file.path, workspacePath) ?? file.path;
  const normalizedPath = relativePath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (file.type === 'directory') {
    return normalizedPath === '.' ? './' : `${normalizedPath}/`;
  }
  return normalizedPath;
}

export function buildSessionSendBody(
  state: ComposerState,
  sessionId: string,
  text: string,
  getCurrentDocumentEnabled: (sessionId: string) => boolean,
  options?: { noReply?: boolean }
): { body: SessionSendBody; effectiveModel: SelectedModel | null } | null {
  const effectiveModel = resolveSelectedModel(
    state.selectedModel,
    state.providers,
    state.providerDefaults
  );
  const includeClipboardImages = effectiveModel
    ? modelSupportsVision(effectiveModel.providerID, effectiveModel.modelID, state.providers)
    : true;
  const promptText = getPromptTextForClipboardImages(
    text,
    state.clipboardImages,
    includeClipboardImages
  );

  const parts: SessionSendBody['parts'] = [];
  if (promptText.trim()) parts.push({ type: 'text', text: promptText });

  const workspacePath = state.editorContext.workspacePath;
  if (workspacePath) {
    parts.push({ type: 'text', text: `[Working directory: ${workspacePath}]` });
  }

  const selection = state.editorContext.selection;
  const activeFile = state.editorContext.activeFile;
  const currentDocumentEnabled = getCurrentDocumentEnabled(sessionId);
  if (activeFile && currentDocumentEnabled) {
    const activeFilePath = getAttachmentReference(
      { path: activeFile.path, type: 'file' },
      workspacePath
    );
    const explicitContext = hasExplicitContextForPath(state.droppedFiles, activeFile.path);
    const activeSelectionRanges = getSelectionRangesFromEditorContext(selection);
    const explicitSelectionRanges =
      explicitContext?.type === 'file' ? explicitContext.lineRanges : undefined;
    const uniqueActiveSelectionRanges = subtractContextLineRanges(
      activeSelectionRanges,
      explicitSelectionRanges
    );

    if (explicitContext) {
      if (uniqueActiveSelectionRanges.length > 0) {
        parts.push({
          type: 'text',
          text: formatSelectionReference(activeFilePath, uniqueActiveSelectionRanges),
        });
      }
      parts.push({
        type: 'text',
        text:
          explicitSelectionRanges && explicitSelectionRanges.length > 0
            ? formatSelectionReference(activeFilePath, explicitSelectionRanges)
            : activeFilePath,
      });
    } else {
      parts.push({
        type: 'text',
        text:
          uniqueActiveSelectionRanges.length > 0
            ? formatSelectionReference(activeFilePath, uniqueActiveSelectionRanges)
            : `[Active file: ${activeFilePath}]`,
      });
    }
  }

  const terminalSelection = state.terminalSelection;
  if (terminalSelection) {
    parts.push({
      type: 'text',
      text: `[Selection from terminal ${terminalSelection.terminalName}]\n\`\`\`text\n${terminalSelection.text}\n\`\`\``,
    });
  }

  for (const file of state.droppedFiles) {
    if (isSamePath(file.path, activeFile?.path)) continue;
    const fileReference = getAttachmentReference(file, workspacePath);
    parts.push({
      type: 'text',
      text: file.lineRanges?.length
        ? formatSelectionReference(fileReference, file.lineRanges)
        : fileReference,
    });
  }

  if (includeClipboardImages) {
    for (const image of state.clipboardImages) {
      parts.push({
        type: 'file',
        mime: image.mime,
        filename: image.filename,
        url: image.url,
      });
    }
  }

  if (parts.length === 0) return null;

  const body: SessionSendBody = { parts };
  if (state.selectedAgent) body.agent = state.selectedAgent;
  if (effectiveModel) {
    body.model = {
      providerID: effectiveModel.providerID,
      modelID: effectiveModel.modelID,
    };
  }
  if (effectiveModel?.variant) {
    body.variant = effectiveModel.variant;
  } else if (body.model) {
    body.variant =
      getPreferredVariant(body.model.providerID, body.model.modelID, state.providers) || undefined;
  }
  if (options?.noReply) body.noReply = true;

  return { body, effectiveModel };
}
