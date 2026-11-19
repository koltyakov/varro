import { createSignal } from 'solid-js';
import { MAX_SIDE_QUESTION_LENGTH, getSideQuestionText } from '../../shared/side-question';
import { readPastedTextDataUrl } from '../../shared/pasted-text';
import { getSkillReferences } from '../../shared/skill-reference';
import { buildSessionSendBody } from '../hooks/session/session-send';
import { showSessionActionFeedback } from '../components/chat/SessionActionFeedback';
import { getCurrentDocumentEnabled, inputText, state } from './state';
import { PROBLEMS_REFERENCE, problemReferenceMarker } from './editor-problems';
import { stripClipboardImagePlaceholders } from './clipboard-images';

export const SIDE_QUESTION_IMAGE_HINT =
  'Images are not included in side questions. Kept attached for your next regular message.';

type SideQuestionView = {
  sessionID: string;
  directory: string;
  serverURL: string;
  question: string;
  context?: string;
};

const [sideQuestionView, setSideQuestionView] = createSignal<SideQuestionView | null>(null);
export { sideQuestionView };

export function sideQuestionPromptUnavailableReason(text: string): string | null {
  const prompt = getSideQuestionText(text) ?? text;
  if (getSkillReferences(prompt).length) return 'Side questions cannot use skills';
  if (
    !state.autoAttachProblems &&
    (prompt.includes(PROBLEMS_REFERENCE) ||
      state.inlineProblems.some((reference) => prompt.includes(problemReferenceMarker(reference))))
  ) {
    return 'Enable problems context before asking a side question';
  }
  if (/^\s*\/[\w-]+(?:\s|$)/.test(prompt)) return 'Side questions cannot run commands';
  const mentions = Array.from(prompt.matchAll(/(?:^|\s)@([^\s]+)/g), (match) =>
    match[1]!.replace(/[,.!?;:]+$/, '')
  );
  if (state.allAgents.some((agent) => mentions.includes(agent.name))) {
    return 'Side questions cannot call subagents';
  }
  if (/\bsession:[\w-]+/.test(prompt)) return 'Side questions cannot load other conversations';
  return null;
}

export function sideQuestionUnavailableReason(
  checkComposerDraft = true,
  draft = inputText()
): string | null {
  if (state.serverStatus.state !== 'running') return 'Connect to OpenCode';
  if (state.serverStatus.apiVersion !== 2) return 'Requires OpenCode V2';
  const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
  if (!session) return 'Open a conversation';
  if (!checkComposerDraft) return null;
  if (state.nativePdfs.length) {
    return 'Remove PDFs to ask a side question';
  }
  const promptReason = sideQuestionPromptUnavailableReason(draft);
  if (promptReason) return promptReason;
  return null;
}

function captureSideQuestionContext(question: string, sessionID: string): string {
  const sourcePrompt = question || (getSideQuestionText(inputText()) ?? inputText());
  // Reuse attachment formatting, not model/agent routing or main-send side effects.
  const payload = buildSessionSendBody(
    {
      selectedAgent: null,
      selectedModel: null,
      providers: [],
      providerDefaults: {},
      modelVariantSelections: {},
      editorContext: state.editorContext,
      terminalSelection: state.terminalSelection,
      droppedFiles: state.droppedFiles,
      clipboardImages: [],
      nativePdfs: [],
      attachedDiagnostics: state.attachedDiagnostics,
      inlineProblems: state.inlineProblems,
      issuesEnabled: state.issuesEnabled,
      autoAttachProblems: state.autoAttachProblems,
      autoAttachActiveFile: state.autoAttachActiveFile,
    },
    sessionID,
    sourcePrompt,
    getCurrentDocumentEnabled
  );
  // The question remains editable; opening from the title menu must not copy the main draft.
  const parts = payload?.body.parts.slice(sourcePrompt.trim() ? 1 : 0) ?? [];
  return parts
    .map((part) => {
      if (part.type === 'text' && part.text !== undefined) return part.text;
      const text =
        part.type === 'file' && part.mime === 'text/plain' && part.url
          ? readPastedTextDataUrl(part.url)
          : null;
      if (text === null) throw new Error('This attachment cannot be used in a side question');
      const fence = '`'.repeat(
        Math.max(3, ...Array.from(text.matchAll(/`{3,}/g), (match) => match[0].length + 1))
      );
      return `[Unsaved buffer from ${part.filename ?? 'pasted-text.txt'} lines 1-${text.split(/\r?\n/).length}]\n${fence}text\n${text}\n${fence}`;
    })
    .join('\n\n');
}

export function openSideQuestion(question = '', draft = inputText()): boolean {
  const prompt = stripClipboardImagePlaceholders(question, state.clipboardImages).trim();
  const reason =
    sideQuestionUnavailableReason(true, draft) ?? sideQuestionPromptUnavailableReason(prompt);
  if (reason || state.serverStatus.state !== 'running') return false;
  const session = state.sessions.find((entry) => entry.id === state.activeSessionId);
  if (!session) return false;
  let context: string;
  try {
    context = captureSideQuestionContext(prompt, session.id);
    if ([prompt, context].filter(Boolean).join('\n\n').length > MAX_SIDE_QUESTION_LENGTH) {
      throw new Error('Question and context exceed the side-question limit');
    }
  } catch (cause) {
    showSessionActionFeedback(cause instanceof Error ? cause.message : String(cause), 'warning');
    return false;
  }
  const view: SideQuestionView = {
    sessionID: session.id,
    directory: session.directory,
    serverURL: state.serverStatus.url,
    question: prompt,
  };
  if (context) view.context = context;
  setSideQuestionView(view);
  return true;
}

export function closeSideQuestion() {
  setSideQuestionView(null);
}
