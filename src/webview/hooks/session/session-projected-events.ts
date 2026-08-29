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
  latestAssistantMessageForSession,
  parseToolInput,
  toolOutputToString,
} from './session-event-utils';
import { isString, type UnknownRecord } from '../../lib/runtime-values';

type ProjectedSessionEventContext = {
  isSessionInActiveTree(sessionId: string | null | undefined): boolean;
  getMessages(): MessageEntry[];
  findAssistantMessage(sessionId: string, assistantMessageID?: string): MessageEntry | null;
  findPart(messageID: string, partID: string): Part | null;
  scheduleActiveMessageSync(sessionId: string): void;
  syncTodosFromMessages(): void;
};

export function createProjectedSessionEventHandler(ctx: ProjectedSessionEventContext) {
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
    const existing = ctx.findPart(message.info.id, partID);
    if (!existing) {
      // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
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
  const handleProjectedTextEvent = (eventName: string, props: UnknownRecord, sessionId: string) => {
    const textID = getEventString(props, 'textID');
    const assistantMessageID = getEventString(props, 'assistantMessageID');
    if (!textID) return false;
    const text = getEventString(props, 'text') || '';
    if (eventName === 'session.next.text.ended') {
      // SAFETY: The surrounding shape or discriminator check establishes the owner type contract used below.
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
  const handleProjectedToolEvent = (eventName: string, props: UnknownRecord, sessionId: string) => {
    const assistantMessageID = getEventString(props, 'assistantMessageID');
    const callID = getEventString(props, 'callID');
    if (!callID) return false;
    const message =
      ctx.findAssistantMessage(sessionId, assistantMessageID) ||
      latestAssistantMessageForSession(ctx.getMessages(), sessionId);
    if (!message) {
      ctx.scheduleActiveMessageSync(sessionId);
      return false;
    }
    const messageID = message.info.id;
    const existing = ctx.findPart(messageID, callID);
    const existingTool = existing?.type === 'tool' ? existing : null;
    const timestamp = getEventTimestamp(props);
    const toolName =
      getEventString(props, 'name') || getEventString(props, 'tool') || existingTool?.tool || '';
    const inputText = getEventString(props, 'text') || getEventString(props, 'input') || '';

    if (eventName === 'session.next.tool.input.delta') {
      const delta = getEventString(props, 'delta') || inputText;
      if (!delta || !existingTool || existingTool.state.status !== 'pending') return true;
      const raw = `${existingTool.state.raw || ''}${delta}`;
      sessionStore.upsertPart({
        ...existingTool,
        state: { ...existingTool.state, input: parseToolInput(raw), raw },
      });
      return true;
    }

    if (eventName === 'session.next.tool.input.started') {
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID,
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
        messageID,
        type: 'tool',
        callID,
        tool: toolName,
        state: { status: 'pending', input: parseToolInput(inputText), raw: inputText },
      });
      return true;
    }

    if (eventName === 'session.next.tool.called') {
      const eventInput = isString(props.input)
        ? parseToolInput(props.input)
        : asToolInput(props.input);
      const input =
        Object.keys(eventInput).length > 0 || !existingTool
          ? eventInput
          : getToolStateInput(existingTool);
      sessionStore.upsertPart({
        id: callID,
        sessionID: sessionId,
        messageID,
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
      const progress = getEventString(props, 'progress');
      const structured = asToolMetadata(props.structured);
      sessionStore.upsertPart({
        ...existingTool,
        state: {
          ...existingTool.state,
          metadata: {
            ...existingTool.state.metadata,
            ...structured,
            structured,
            content: props.content,
            progress: progress || undefined,
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
        messageID,
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
        messageID,
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
  return (eventName: string, props: UnknownRecord) => {
    // SAFETY: The surrounding shape or discriminator check establishes the string contract used below.
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
