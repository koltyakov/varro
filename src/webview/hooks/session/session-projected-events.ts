import { sessionStore } from '../../lib/stores/session-store';
import type { MessageEntry, Part } from '../../types';
import {
  asToolInput,
  asToolMetadata,
  getEventString,
  getEventTimestamp,
  getToolErrorMessage,
  getToolStartTime,
  getToolStateInput,
  parseToolInput,
  toolOutputToString,
} from './session-event-utils';

type ProjectedSessionEventContext = {
  isSessionInActiveTree(sessionId: string | null | undefined): boolean;
  getMessages(): MessageEntry[];
  findAssistantMessage(sessionId: string, assistantMessageID?: string): MessageEntry | null;
  scheduleActiveMessageSync(sessionId: string): void;
  syncTodosFromMessages(): void;
};

export function createProjectedSessionEventHandler(ctx: ProjectedSessionEventContext) {
  const findPart = (messageID: string, partID: string): Part | null => {
    const message = ctx.getMessages().find((entry) => entry.info.id === messageID);
    return message?.parts.find((part) => part.id === partID) || null;
  };
  const applyProjectedPart = (
    sessionId: string,
    assistantMessageID: string | undefined,
    part: Part
  ) => {
    const message = ctx.findAssistantMessage(sessionId, assistantMessageID);
    if (!message) {
      ctx.scheduleActiveMessageSync(sessionId);
      return false;
    }
    sessionStore.upsertPart(part);
    return true;
  };
  const ensureProjectedTextPart = (
    sessionId: string,
    assistantMessageID: string | undefined,
    partID: string,
    text = ''
  ) => {
    const message = ctx.findAssistantMessage(sessionId, assistantMessageID);
    if (!message) {
      ctx.scheduleActiveMessageSync(sessionId);
      return null;
    }
    const existing = message.parts.find((part) => part.id === partID);
    if (!existing) {
      sessionStore.upsertPart({
        id: partID,
        sessionID: sessionId,
        messageID: message.info.id,
        type: 'text',
        text,
      } as Part);
    }
    return message.info.id;
  };
  const handleProjectedTextEvent = (
    eventName: string,
    props: Record<string, unknown>,
    sessionId: string
  ) => {
    const textID = getEventString(props, 'textID');
    const assistantMessageID = getEventString(props, 'assistantMessageID');
    if (!textID) return false;
    const text = getEventString(props, 'text') || '';
    if (eventName === 'session.next.text.ended') {
      return !!applyProjectedPart(sessionId, assistantMessageID, {
        id: textID,
        sessionID: sessionId,
        messageID: assistantMessageID || '',
        type: 'text',
        text,
      } as Part);
    }
    const messageID = ensureProjectedTextPart(sessionId, assistantMessageID, textID);
    if (!messageID) return false;
    if (eventName === 'session.next.text.delta') {
      const delta = getEventString(props, 'delta') || text;
      if (delta) sessionStore.applyMessagePartDelta(messageID, textID, delta, sessionId, 'text');
    }
    return true;
  };
  const handleProjectedToolEvent = (
    eventName: string,
    props: Record<string, unknown>,
    sessionId: string
  ) => {
    const assistantMessageID = getEventString(props, 'assistantMessageID');
    const callID = getEventString(props, 'callID');
    if (!assistantMessageID || !callID) return false;
    const message = ctx.findAssistantMessage(sessionId, assistantMessageID);
    if (!message) {
      ctx.scheduleActiveMessageSync(sessionId);
      return false;
    }
    const existing = findPart(assistantMessageID, callID);
    const existingTool = existing?.type === 'tool' ? existing : null;
    const timestamp = getEventTimestamp(props);
    const toolName =
      getEventString(props, 'name') || getEventString(props, 'tool') || existingTool?.tool || '';
    const inputText = getEventString(props, 'text') || getEventString(props, 'input') || '';

    if (eventName === 'session.next.tool.input.delta') {
      const delta = getEventString(props, 'delta') || inputText;
      if (!delta || !existingTool || existingTool.state.status !== 'pending') return true;
      sessionStore.upsertPart({
        ...existingTool,
        state: { ...existingTool.state, raw: `${existingTool.state.raw || ''}${delta}` },
      });
      return true;
    }

    if (eventName === 'session.next.tool.input.started') {
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: { status: 'pending', input: {}, raw: '' },
      });
      return true;
    }

    if (eventName === 'session.next.tool.input.ended') {
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: { status: 'pending', input: parseToolInput(inputText), raw: inputText },
      });
      return true;
    }

    if (eventName === 'session.next.tool.called') {
      const input = asToolInput(props.input);
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: {
          status: 'running',
          input,
          title: toolName,
          metadata: asToolMetadata(props.provider),
          time: { start: timestamp },
        },
      });
      return true;
    }

    if (eventName === 'session.next.tool.progress') {
      if (!existingTool || existingTool.state.status !== 'running') return true;
      sessionStore.upsertPart({
        ...existingTool,
        state: {
          ...existingTool.state,
          metadata: {
            ...existingTool.state.metadata,
            structured: asToolMetadata(props.structured),
            content: props.content,
          },
        },
      });
      return true;
    }

    if (eventName === 'session.next.tool.success') {
      const input = existingTool ? getToolStateInput(existingTool) : {};
      const start = existingTool ? getToolStartTime(existingTool) : timestamp;
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: {
          status: 'completed',
          input,
          output: toolOutputToString(props.content, props.structured),
          title: toolName,
          metadata: {
            ...asToolMetadata(props.structured),
            provider: props.provider,
            result: props.result,
          },
          time: { start, end: timestamp },
        },
      });
      ctx.syncTodosFromMessages();
      return true;
    }

    if (eventName === 'session.next.tool.failed') {
      const input = existingTool ? getToolStateInput(existingTool) : {};
      const start = existingTool ? getToolStartTime(existingTool) : timestamp;
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID: assistantMessageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: {
          status: 'error',
          input,
          error: getToolErrorMessage(props.error),
          metadata: { provider: props.provider, result: props.result },
          time: { start, end: timestamp },
        },
      });
      ctx.syncTodosFromMessages();
      return true;
    }

    return false;
  };
  return (eventName: string, props: Record<string, unknown>) => {
    const sessionId = props.sessionID as string | undefined;
    if (!sessionId || !ctx.isSessionInActiveTree(sessionId)) return false;
    if (eventName.startsWith('session.next.text.')) {
      return handleProjectedTextEvent(eventName, props, sessionId);
    }
    if (eventName.startsWith('session.next.tool.')) {
      return handleProjectedToolEvent(eventName, props, sessionId);
    }
    return false;
  };
}
