import {
  MAX_SIDE_QUESTION_ANSWER_LENGTH,
  SIDE_QUESTION_TIMEOUT_MS,
  type SideQuestionAnswer,
  type SideQuestionRequest,
} from '../../shared/side-question';
import type { MessageEntry, Part } from '../types';
import { apiCall } from './bridge';
import { isString } from './runtime-values';
import { state } from './state';

const PLAN_SUMMARY_QUESTION = [
  'Write the implementation plan agreed in this conversation as one standalone Markdown document.',
  'Fold later revisions into the steps they change and drop superseded ideas and discussion.',
  'Keep concrete file paths, steps, decisions, constraints, and open questions.',
  'Output only the plan.',
].join(' ');

function isTypedText(part: Part): part is Extract<Part, { type: 'text' }> {
  return part.type === 'text' && !part.synthetic && !part.ignored && !!part.text.trim();
}

/** Counts prompts the user typed in a session; synthetic reminders are not turns. */
export function countPlanningTurns(sessionId: string, messages: readonly MessageEntry[]) {
  return messages.filter(
    (entry) =>
      entry.info.sessionID === sessionId &&
      entry.info.role === 'user' &&
      entry.parts.some(isTypedText)
  ).length;
}

/** Side questions summarize with the session's own context; they need OpenCode V2. */
export function canSummarizePlan(sessionId: string) {
  return (
    state.serverStatus.state === 'running' &&
    state.serverStatus.apiVersion === 2 &&
    state.sessions.some((session) => session.id === sessionId)
  );
}

export async function summarizePlanSession(sessionId: string, signal?: AbortSignal) {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  if (!session) throw new Error('Open the planning conversation to summarize it');
  const body: SideQuestionRequest = { question: PLAN_SUMMARY_QUESTION };
  const result = await apiCall<SideQuestionAnswer>(
    'POST',
    `/session/${encodeURIComponent(sessionId)}/side-question?directory=${encodeURIComponent(session.directory)}`,
    body,
    { signal, timeoutMs: SIDE_QUESTION_TIMEOUT_MS, retries: 0 }
  );
  const text = isString(result?.text) ? result.text.trim() : '';
  if (!text || text.length > MAX_SIDE_QUESTION_ANSWER_LENGTH) {
    throw new Error('OpenCode returned no usable plan summary');
  }
  return text;
}

/**
 * The plan to hand to implementation: a single-turn plan is its final response, and a
 * multi-turn plan is summarized so later revisions replace earlier drafts.
 */
export async function resolvePlanContent(
  sessionId: string,
  finalResponse: string,
  messages: readonly MessageEntry[] = state.messages
) {
  if (countPlanningTurns(sessionId, messages) > 1 && canSummarizePlan(sessionId)) {
    return summarizePlanSession(sessionId);
  }
  return finalResponse;
}
