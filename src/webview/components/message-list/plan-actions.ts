import { isSkippedPlanSession, state } from '../../lib/state';
import { isAssistantMessage } from '../../lib/message-metrics';
import type { AssistantMessage, Message, Part } from '../../types';

export function isPlanningAssistantMessage(info: AssistantMessage): boolean {
  return info.agent === 'plan';
}

const PLAN_IMPLEMENTATION_PROMPT =
  'Implement the plan from your last response in the current workspace. Make the code changes instead of revising the plan.';

export function isPlanImplementationMessage(info: Message, parts: readonly Part[]): boolean {
  return (
    info.role === 'user' &&
    info.agent === 'build' &&
    parts.length === 1 &&
    parts[0]?.type === 'text' &&
    !parts[0].synthetic &&
    !parts[0].ignored &&
    parts[0].text === PLAN_IMPLEMENTATION_PROMPT
  );
}

export function buildPlanImplementationPrompt(parts: Part[]) {
  void parts;
  return PLAN_IMPLEMENTATION_PROMPT;
}

export function buildPlanDocumentContent(parts: Part[]) {
  return parts
    .filter(
      (part): part is Extract<Part, { type: 'text' }> =>
        part.type === 'text' && !part.synthetic && !part.ignored
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function getLatestPlanImplementationMessageId(
  messages: Array<{ info: Message }>
): string | null {
  const lastMessage = messages[messages.length - 1]?.info;
  if (
    !lastMessage ||
    !isAssistantMessage(lastMessage) ||
    !isPlanningAssistantMessage(lastMessage)
  ) {
    return null;
  }

  return lastMessage.id;
}

export function shouldShowPlanImplementationAction(args: {
  hasBuildAgent: boolean;
  info: Message;
  latestPlanImplementationMessageId: string | null;
}) {
  if (
    !args.hasBuildAgent ||
    !isAssistantMessage(args.info) ||
    !isPlanningAssistantMessage(args.info) ||
    !!args.info.error
  ) {
    return false;
  }
  if (args.info.id !== args.latestPlanImplementationMessageId) {
    return false;
  }

  const session = state.sessions.find((item) => item.id === args.info.sessionID);
  return !session || !isSkippedPlanSession(args.info.sessionID, session.time.updated);
}

export function shouldShowPlanSkippedNotice(args: {
  info: Message;
  latestPlanImplementationMessageId: string | null;
}): boolean {
  if (
    !isAssistantMessage(args.info) ||
    !isPlanningAssistantMessage(args.info) ||
    !!args.info.error ||
    args.info.id !== args.latestPlanImplementationMessageId
  ) {
    return false;
  }

  const session = state.sessions.find((item) => item.id === args.info.sessionID);
  return !!session && isSkippedPlanSession(args.info.sessionID, session.time.updated);
}
