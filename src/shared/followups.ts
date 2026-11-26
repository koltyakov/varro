import { asRecord, isBoolean, isString } from './type-utils';
import type { Message, Part } from './opencode-types';

export type FollowupAction = { title: string; prompt: string; sessionId?: string };
/** `combinable` marks actions that are compatible and can be requested together. */
export type FollowupSuggestionSet = {
  summary: string;
  actions: FollowupAction[];
  combinable?: boolean;
};
export const EMPTY_FOLLOWUP_SUGGESTIONS: FollowupSuggestionSet = { summary: '', actions: [] };

/** Exact visible text snapshot. IDs and text are checked against server history before inference. */
export type FollowupSource = {
  assistantMessageId: string;
  userMessageId: string;
  userPrompt: string;
  answer: string;
};

export const FOLLOWUP_MAX_ACTIONS = 3;
export const FOLLOWUP_GENERATION_TIMEOUT_MS = 30_000;
export const FOLLOWUP_REQUEST_TIMEOUT_MS = FOLLOWUP_GENERATION_TIMEOUT_MS + 5_000;
export const FOLLOWUP_MAX_ANSWER_CHARS = 12_000;
export const FOLLOWUP_MAX_PROMPT_CHARS = 4_000;
export const FOLLOWUP_ALL_TITLE = 'All follow-ups';
// oxlint-disable-next-line no-control-regex -- Reject control and bidi override characters in generated button text.
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

export function parseFollowupTitle<T>(value: T): string | null {
  if (!isString(value)) return null;
  const title = value.trim();
  return title && title.length <= 40 && !/[\r\n\t]/.test(title) && !UNSAFE_TEXT.test(title)
    ? title
    : null;
}

/** Explicit action attribution only. Identical text typed by the user stays a normal prompt. */
export function getFollowupActionTitle(info: Message, parts: readonly Part[]): string | null {
  const part = parts[0];
  if (
    info.role !== 'user' ||
    parts.length !== 1 ||
    part?.type !== 'text' ||
    part.synthetic ||
    part.ignored
  )
    return null;
  return parseFollowupTitle(info.followupTitle);
}

export function readFollowupText<T>(parts: T): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .flatMap((value) => {
      const part = asRecord(value);
      return part?.type === 'text' && !part.synthetic && !part.ignored && isString(part.text)
        ? [part.text]
        : [];
    })
    .join('\n\n')
    .trim();
}

export function parseFollowupSource<T>(value: T): FollowupSource | null {
  const record = asRecord(value);
  if (
    !isString(record?.assistantMessageId) ||
    !/^[\w-]{1,200}$/.test(record.assistantMessageId) ||
    !isString(record.userMessageId) ||
    !/^[\w-]{1,200}$/.test(record.userMessageId) ||
    !isString(record.userPrompt) ||
    !record.userPrompt.trim() ||
    record.userPrompt.length > FOLLOWUP_MAX_PROMPT_CHARS ||
    !isString(record.answer) ||
    !record.answer.trim() ||
    record.answer.length > FOLLOWUP_MAX_ANSWER_CHARS
  )
    return null;
  return {
    assistantMessageId: record.assistantMessageId,
    userMessageId: record.userMessageId,
    userPrompt: record.userPrompt,
    answer: record.answer,
  };
}

/** Fail closed. JSON instructions are not schema-constrained decoding. */
export function parseFollowupSuggestions(
  text: string,
  options?: { allowSessionId?: boolean }
): FollowupSuggestionSet {
  if (text.length > 4_096) throw new Error('Follow-ups output is too large');
  const record = asRecord(JSON.parse(text));
  if (
    !record ||
    Object.keys(record).some(
      (key) => key !== 'summary' && key !== 'actions' && key !== 'combinable'
    ) ||
    (record.combinable !== undefined && !isBoolean(record.combinable)) ||
    !isString(record.summary) ||
    record.summary.trim().length > 400 ||
    UNSAFE_TEXT.test(record.summary) ||
    !Array.isArray(record.actions) ||
    record.actions.length > FOLLOWUP_MAX_ACTIONS ||
    (record.actions.length > 0 && !record.summary.trim())
  )
    throw new Error('Invalid follow-ups output');
  const titles = new Set<string>();
  const prompts = new Set<string>();
  const actions = record.actions.map((value) => {
    const action = asRecord(value);
    if (
      !action ||
      Object.keys(action).some(
        (key) =>
          key !== 'title' && key !== 'prompt' && !(options?.allowSessionId && key === 'sessionId')
      ) ||
      !isString(action.title) ||
      !isString(action.prompt) ||
      ('sessionId' in action &&
        (!options?.allowSessionId ||
          !isString(action.sessionId) ||
          !/^[\w-]{1,200}$/.test(action.sessionId)))
    )
      throw new Error('Invalid follow-up action');
    const title = action.title.trim();
    const prompt = action.prompt.trim();
    const titleKey = title.toLowerCase();
    const promptKey = prompt.toLowerCase();
    if (
      !title ||
      title.length > 40 ||
      /[\r\n\t]/.test(title) ||
      !prompt ||
      prompt.length > 600 ||
      prompt.startsWith('/') ||
      UNSAFE_TEXT.test(title) ||
      UNSAFE_TEXT.test(prompt) ||
      titles.has(titleKey) ||
      prompts.has(promptKey)
    )
      throw new Error('Invalid follow-up action text');
    titles.add(titleKey);
    prompts.add(promptKey);
    return isString(action.sessionId)
      ? { title, prompt, sessionId: action.sessionId }
      : { title, prompt };
  });
  const summaryText = record.summary.trim();
  return record.combinable === true && actions.length > 1
    ? { summary: summaryText, actions, combinable: true }
    : { summary: summaryText, actions };
}

/** Joins compatible actions into one request. Callers pass at least two unsent actions. */
export function combineFollowupActions(actions: readonly FollowupAction[]): FollowupAction {
  return {
    title: FOLLOWUP_ALL_TITLE,
    prompt: [
      'Do all of the following:',
      ...actions.map((action, index) => `${index + 1}. ${action.prompt}`),
    ].join('\n\n'),
  };
}
