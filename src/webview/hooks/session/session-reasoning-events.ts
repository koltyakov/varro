import { serverEvents } from '../../lib/client';
import { sessionStore } from '../../lib/stores/session-store';
import { uiStore } from '../../lib/stores/ui-store';
import type { MessageEntry, Part } from '../../types';
import { getEventString, latestAssistantMessageForSession } from './session-event-utils';

type ReasoningEventContext = {
  getMessages(): MessageEntry[];
  syncSessionMessages(sessionId: string): Promise<void>;
  logError(context: string, err: unknown): void;
  isSessionInActiveTree(sessionId: string | null | undefined): boolean;
  markSessionProgress(sessionId: string): void;
  ignoreStaleProgressForCompletedMessage(sessionId: string, messageId: string): boolean;
  ignoreStaleProgressAfterFinishedAssistant(sessionId: string): boolean;
};

export function registerReasoningEventHandlers(ctx: ReasoningEventContext): Array<() => void> {
  // v2 reasoning events carry the owning assistantMessageID. When that message is loaded
  // we attach directly to it; otherwise we fall back to the "latest active assistant"
  // heuristic, preserving the pre-v2 behavior for older servers / not-yet-synced messages.
  const findReasoningMessage = (sessionId: string, assistantMessageID?: string) => {
    if (assistantMessageID) {
      const named = ctx
        .getMessages()
        .find(
          (entry) =>
            entry.info.id === assistantMessageID &&
            entry.info.sessionID === sessionId &&
            entry.info.role === 'assistant'
        );
      if (named) return named;
    }
    return latestAssistantMessageForSession(ctx.getMessages(), sessionId);
  };
  const ensureReasoningPart = (
    sessionId: string,
    reasoningId: string,
    assistantMessageID?: string
  ) => {
    const message = findReasoningMessage(sessionId, assistantMessageID);
    if (!message) return null;
    if (!message.parts.some((part) => part.id === reasoningId)) {
      sessionStore.upsertPart({
        id: reasoningId,
        sessionID: sessionId,
        messageID: message.info.id,
        type: 'reasoning',
        text: '',
      } as Part);
    }
    return message.info.id;
  };
  const withReasoningMessage = (
    sessionId: string,
    reasoningId: string,
    apply: (messageID: string) => void,
    assistantMessageID?: string
  ) => {
    const messageID = ensureReasoningPart(sessionId, reasoningId, assistantMessageID);
    if (messageID) {
      apply(messageID);
      return;
    }
    void ctx
      .syncSessionMessages(sessionId)
      .then(() => {
        const syncedMessageID = ensureReasoningPart(sessionId, reasoningId, assistantMessageID);
        if (syncedMessageID) apply(syncedMessageID);
      })
      .catch((err) => ctx.logError('syncSessionMessages', err));
  };

  const cleanups: Array<() => void> = [];

  cleanups.push(
    serverEvents.on('session.next.reasoning.started', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      const assistantMessageID = getEventString(p, 'assistantMessageID');
      if (!sessionID) return;
      if (
        assistantMessageID &&
        ctx.ignoreStaleProgressForCompletedMessage(sessionID, assistantMessageID)
      ) {
        return;
      }
      if (!assistantMessageID && ctx.ignoreStaleProgressAfterFinishedAssistant(sessionID)) return;
      ctx.markSessionProgress(sessionID);
      if (!reasoningID || !ctx.isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      withReasoningMessage(sessionID, reasoningID, () => {}, assistantMessageID);
    })
  );

  cleanups.push(
    serverEvents.on('session.next.reasoning.delta', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      const assistantMessageID = getEventString(p, 'assistantMessageID');
      const delta = getEventString(p, 'delta') || getEventString(p, 'text');
      if (!sessionID) return;
      if (
        assistantMessageID &&
        ctx.ignoreStaleProgressForCompletedMessage(sessionID, assistantMessageID)
      ) {
        return;
      }
      if (!assistantMessageID && ctx.ignoreStaleProgressAfterFinishedAssistant(sessionID)) return;
      ctx.markSessionProgress(sessionID);
      if (!reasoningID || !delta || !ctx.isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      withReasoningMessage(
        sessionID,
        reasoningID,
        (messageID) => {
          sessionStore.applyMessagePartDelta(messageID, reasoningID, delta, sessionID, 'text');
        },
        assistantMessageID
      );
    })
  );

  cleanups.push(
    serverEvents.on('session.next.reasoning.ended', (data) => {
      const p = data.properties;
      const sessionID = p?.sessionID as string | undefined;
      const reasoningID = getEventString(p, 'reasoningID');
      const assistantMessageID = getEventString(p, 'assistantMessageID');
      if (!sessionID) return;
      if (
        assistantMessageID &&
        ctx.ignoreStaleProgressForCompletedMessage(sessionID, assistantMessageID)
      ) {
        return;
      }
      if (!assistantMessageID && ctx.ignoreStaleProgressAfterFinishedAssistant(sessionID)) return;
      ctx.markSessionProgress(sessionID);
      if (!reasoningID || !ctx.isSessionInActiveTree(sessionID)) return;
      uiStore.markLoadingActivity();
      const text = getEventString(p, 'text');
      withReasoningMessage(
        sessionID,
        reasoningID,
        (messageID) => {
          if (!text) return;
          sessionStore.upsertPart({
            id: reasoningID,
            sessionID,
            messageID,
            type: 'reasoning',
            text,
          } as Part);
        },
        assistantMessageID
      );
    })
  );

  return cleanups;
}
