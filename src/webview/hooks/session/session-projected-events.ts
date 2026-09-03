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
  tryParseToolInput,
  toolOutputToString,
} from './session-event-utils';
import { isString, type UnknownRecord } from '../../lib/runtime-values';

const PROJECTED_TOOL_STATE_LIMIT = 256;
const PENDING_TOOL_INPUT_MAX_CHARACTERS = 1024 * 1024;

type ProjectedSessionEventContext = {
  isSessionInActiveTree(sessionId: string | null | undefined): boolean;
  getMessages(): MessageEntry[];
  findAssistantMessage(sessionId: string, assistantMessageID?: string): MessageEntry | null;
  findPart(messageID: string, partID: string): Part | null;
  scheduleActiveMessageSync(sessionId: string): void;
  syncTodosFromMessages(): void;
};

type ToolInputScanState = {
  depth: number;
  inString: boolean;
  escaped: boolean;
  started: boolean;
  complete: boolean;
  invalid: boolean;
};

type PendingToolInput = {
  raw: string;
  observedStateRaw: string;
  scanState: ToolInputScanState;
  suspended: boolean;
};

function emptyToolInputScanState(): ToolInputScanState {
  return {
    depth: 0,
    inString: false,
    escaped: false,
    started: false,
    complete: false,
    invalid: false,
  };
}

function scanToolInputFragment(previous: ToolInputScanState, fragment: string): ToolInputScanState {
  const state = { ...previous };
  for (const character of fragment) {
    if (state.invalid) break;
    if (!state.started) {
      if (/\s/.test(character)) continue;
      if (character !== '{') {
        state.invalid = true;
        break;
      }
      state.started = true;
      state.depth = 1;
      continue;
    }
    if (state.complete) {
      if (!/\s/.test(character)) state.invalid = true;
      continue;
    }
    if (state.inString) {
      if (state.escaped) state.escaped = false;
      else if (character === '\\') state.escaped = true;
      else if (character === '"') state.inString = false;
      continue;
    }
    if (character === '"') state.inString = true;
    else if (character === '{' || character === '[') state.depth += 1;
    else if (character === '}' || character === ']') {
      state.depth -= 1;
      if (state.depth === 0) state.complete = true;
      else if (state.depth < 0) state.invalid = true;
    }
  }
  return state;
}

function rememberBoundedToolState<T>(
  stateByExecution: Map<string, T>,
  executionKey: string,
  state: T
) {
  stateByExecution.delete(executionKey);
  stateByExecution.set(executionKey, state);
  while (stateByExecution.size > PROJECTED_TOOL_STATE_LIMIT) {
    const oldest = stateByExecution.keys().next().value;
    if (!oldest) break;
    stateByExecution.delete(oldest);
  }
}

export function createProjectedSessionEventHandler(ctx: ProjectedSessionEventContext) {
  const pendingToolInput = new Map<string, PendingToolInput>();
  const runningToolProviders = new Map<string, UnknownRecord>();
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
    const executionKey = `${sessionId}\u0000${callID}`;

    if (eventName === 'session.next.tool.input.delta') {
      const delta = getEventString(props, 'delta') || inputText;
      if (!delta || !existingTool || existingTool.state.status !== 'pending') return true;
      const existingRaw = existingTool.state.raw ?? '';
      const pendingInput = pendingToolInput.get(executionKey);
      const currentPendingInput =
        pendingInput?.observedStateRaw === existingRaw ? pendingInput : null;
      if (currentPendingInput?.suspended) return true;
      const baseRaw = currentPendingInput?.raw ?? existingRaw;
      if (baseRaw.length + delta.length > PENDING_TOOL_INPUT_MAX_CHARACTERS) {
        rememberBoundedToolState(pendingToolInput, executionKey, {
          raw: '',
          observedStateRaw: existingRaw,
          scanState: emptyToolInputScanState(),
          suspended: true,
        });
        return true;
      }
      const baseScanState = currentPendingInput
        ? currentPendingInput.scanState
        : scanToolInputFragment(emptyToolInputScanState(), existingRaw);
      const raw = `${baseRaw}${delta}`;
      const scanState = scanToolInputFragment(baseScanState, delta);
      rememberBoundedToolState(pendingToolInput, executionKey, {
        raw,
        observedStateRaw: existingRaw,
        scanState,
        suspended: false,
      });
      if (!scanState.complete || scanState.invalid) return true;
      const input = tryParseToolInput(raw);
      if (!input) return true;
      sessionStore.upsertPart({
        ...existingTool,
        state: { ...existingTool.state, input, raw },
      });
      return true;
    }

    if (eventName === 'session.next.tool.input.started') {
      rememberBoundedToolState(pendingToolInput, executionKey, {
        raw: '',
        observedStateRaw: '',
        scanState: emptyToolInputScanState(),
        suspended: false,
      });
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
      pendingToolInput.delete(executionKey);
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
      pendingToolInput.delete(executionKey);
      const provider = asToolMetadata(props.provider);
      rememberBoundedToolState(runningToolProviders, executionKey, provider);
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
          metadata: provider,
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
            ...runningToolProviders.get(executionKey),
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
      pendingToolInput.delete(executionKey);
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
      pendingToolInput.delete(executionKey);
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
    if (!sessionId) return false;
    const callID = getEventString(props, 'callID');
    if (callID) {
      const executionKey = `${sessionId}\u0000${callID}`;
      if (
        eventName === 'session.next.tool.input.ended' ||
        eventName === 'session.next.tool.called' ||
        eventName === 'session.next.tool.success' ||
        eventName === 'session.next.tool.failed'
      ) {
        pendingToolInput.delete(executionKey);
      }
      if (eventName === 'session.next.tool.success' || eventName === 'session.next.tool.failed') {
        runningToolProviders.delete(executionKey);
      }
    }
    if (!ctx.isSessionInActiveTree(sessionId)) return false;
    if (eventName.startsWith('session.next.text.')) {
      return handleProjectedTextEvent(eventName, props, sessionId);
    }
    if (eventName.startsWith('session.next.tool.')) {
      return handleProjectedToolEvent(eventName, props, sessionId);
    }
    return false;
  };
}
