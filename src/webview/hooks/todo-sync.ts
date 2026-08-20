import { appStore } from '../lib/stores/app-store';
import { isTodoToolName } from '../lib/tool-normalization';
import type { AssistantMessage, MessageEntry, NormalizedTodo, Part } from '../types';
import { isNumber, isString, type UnknownRecord, isObject } from '../lib/runtime-values';

type TodoSyncDependencies = {
  loadSessionTodos?(sessionId: string): Promise<void | boolean | object>;
};

export function resetTodoSync() {
  appStore.setState('todos', []);
}

function setStateTodos(todos: NormalizedTodo[], options?: { preserveAdvancedStatuses?: boolean }) {
  const nextTodos = options?.preserveAdvancedStatuses
    ? preserveAdvancedTodoStatuses(todos, appStore.state.todos)
    : todos;
  if (areTodosEqual(appStore.state.todos, nextTodos)) return;
  appStore.setState('todos', nextTodos);
}

export function createTodoSyncOperations(deps: TodoSyncDependencies = {}) {
  let nativeTodosEnabled = false;

  const applyNativeTodos = <T>(raw: T, options?: { preserveAdvancedStatuses?: boolean }) => {
    const todos = extractTodos(raw);
    if (!todos) return false;
    nativeTodosEnabled = true;
    setStateTodos(todos, options);
    return true;
  };

  const syncTodosFromMessagesWithState = <T>(
    messages: MessageEntry[] = appStore.state.messages,
    latestEventPayload?: T
  ) => {
    if (
      nativeTodosEnabled &&
      applyNativeTodos(latestEventPayload, { preserveAdvancedStatuses: true })
    ) {
      return;
    }
    if (nativeTodosEnabled) {
      advanceTodosFromMessages(messages);
      return;
    }
    syncTodosFromMessages(setStateTodos, messages, latestEventPayload);
  };

  const syncTodosForSessionWithState = async (
    sessionId: string,
    messages: MessageEntry[] = appStore.state.messages
  ) => {
    if (!deps.loadSessionTodos) {
      syncTodosFromMessagesWithState(messages);
      return;
    }

    // Loaded message parts are already available, so hydrate the panel before the
    // native request completes without clearing newer state when no part is present.
    advanceTodosFromMessages(messages);

    try {
      const todos = extractTodos(await deps.loadSessionTodos(sessionId)) ?? [];
      nativeTodosEnabled = true;
      if (appStore.state.activeSessionId === sessionId) {
        if (isStaleSettledNativeTodoSnapshot(todos, messages)) {
          setStateTodos([]);
          return;
        }
        setStateTodos(todos, { preserveAdvancedStatuses: true });
        advanceTodosFromMessages(messages);
      }
    } catch {
      nativeTodosEnabled = false;
      if (appStore.state.activeSessionId === sessionId) {
        syncTodosFromMessagesWithState(messages);
      }
    }
  };

  const handoffTodosToMessagesWithState = (messages: MessageEntry[] = appStore.state.messages) => {
    if (nativeTodosEnabled) {
      advanceTodosFromMessages(messages);
      return true;
    }
    const handedOff = handoffTodosToMessages(appStore.state.todos, setStateTodos, messages);
    return handedOff;
  };

  return {
    resetTodoSync,
    syncTodosFromMessages: syncTodosFromMessagesWithState,
    syncTodosForSession: syncTodosForSessionWithState,
    handoffTodosToMessages: handoffTodosToMessagesWithState,
  };
}

function advanceTodosFromMessages(messages: MessageEntry[]) {
  const messageTodos = deriveTodosFromMessages(messages);
  if (messageTodos.length === 0) return false;

  const currentTodos = appStore.state.todos;
  if (currentTodos.length === 0) {
    setStateTodos(messageTodos);
    return true;
  }

  if (currentTodos.length !== messageTodos.length) return false;
  const nextTodos = mergeTodoEventAdvance(currentTodos, messageTodos);
  setStateTodos(nextTodos);
  return true;
}

function isStaleSettledNativeTodoSnapshot(todos: NormalizedTodo[], messages: MessageEntry[]) {
  if (todos.length === 0 || todos.some((todo) => todo.status === 'completed')) return false;
  if (deriveTodosFromMessages(messages).length > 0) return false;

  const latestAssistant = getLatestAssistantMessageInTurn(messages);
  return !!latestAssistant?.info.time.completed && !latestAssistant.info.error;
}

export function extractTodos<T>(raw: T): NormalizedTodo[] | null {
  if (Array.isArray(raw)) {
    return raw.map(normalizeTodo).filter((todo): todo is NormalizedTodo => Boolean(todo));
  }

  if (!raw || !isObject(raw)) return null;

  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const record = raw as UnknownRecord;
  for (const key of ['todos', 'items', 'plan']) {
    const todos = extractTodos(record[key]);
    if (todos) return todos;
  }

  return null;
}

export function deriveTodosFromMessages(messages: MessageEntry[]): NormalizedTodo[] {
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.info.role === 'user') {
      lastUserMessageIndex = index;
      break;
    }
  }

  for (
    let messageIndex = messages.length - 1;
    messageIndex > lastUserMessageIndex;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex]!;
    if (message.info.role !== 'assistant') continue;

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const todos = extractTodosFromPart(message.parts[partIndex]!);
      if (todos) return todos;
    }
  }

  return [];
}

export function syncTodosFromMessages<T>(
  setTodos: (todos: NormalizedTodo[]) => void,
  messages: MessageEntry[],
  latestEventPayload?: T
) {
  const eventTodos = extractTodos(latestEventPayload);
  const messageTodos = deriveTodosFromMessages(messages);
  setTodos(mergeTodoEventAdvance(messageTodos, eventTodos));
}

export function mergeTodoEventAdvance(
  messageTodos: NormalizedTodo[],
  eventTodos: NormalizedTodo[] | null
): NormalizedTodo[] {
  if (!eventTodos || messageTodos.length === 0 || messageTodos.length !== eventTodos.length) {
    return messageTodos;
  }

  return messageTodos.map((messageTodo, index) => {
    const eventTodo = eventTodos[index]!;
    if (!isSameTodo(messageTodo, eventTodo)) return messageTodo;
    if (statusRank(eventTodo.status) <= statusRank(messageTodo.status)) return messageTodo;
    return { ...messageTodo, status: eventTodo.status };
  });
}

export function preserveAdvancedTodoStatuses(
  nextTodos: NormalizedTodo[],
  currentTodos: NormalizedTodo[]
): NormalizedTodo[] {
  if (nextTodos.length === 0 || nextTodos.length !== currentTodos.length) return nextTodos;

  return nextTodos.map((nextTodo, index) => {
    const currentTodo = currentTodos[index]!;
    if (!isSameTodo(nextTodo, currentTodo)) return nextTodo;
    if (statusRank(currentTodo.status) <= statusRank(nextTodo.status)) return nextTodo;
    return { ...nextTodo, status: currentTodo.status };
  });
}

export function handoffTodosToMessages(
  currentTodos: NormalizedTodo[],
  setTodos: (todos: NormalizedTodo[]) => void,
  messages: MessageEntry[]
): boolean {
  const nextTodos = deriveTodosFromMessages(messages);
  const latestAssistant = getLatestAssistantMessageInTurn(messages);
  const currentTodoMessageId = getLatestTodoMessageId(messages);
  const latestAssistantIdle = latestAssistant
    ? appStore.state.sessionStatus[latestAssistant.info.sessionID]?.type === 'idle'
    : false;

  // Refreshed message snapshots can briefly lose todo-bearing parts for the same reply,
  // or introduce a newer unfinished assistant shell before its todo state arrives.
  if (currentTodos.length > 0 && nextTodos.length === 0) {
    if (!latestAssistant) {
      return false;
    }

    if (
      !latestAssistant.info.time.completed &&
      !latestAssistant.info.error &&
      !latestAssistantIdle
    ) {
      return false;
    }

    if (
      currentTodoMessageId &&
      latestAssistant.info.id === currentTodoMessageId &&
      !latestAssistantIdle
    ) {
      return false;
    }
  }

  setTodos(nextTodos);
  return true;
}

function extractTodosFromParallelTool<T>(raw: T): NormalizedTodo[] | null {
  if (!raw || !isObject(raw)) return null;

  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const toolUses = (raw as UnknownRecord).tool_uses;
  if (!Array.isArray(toolUses)) return null;

  for (const toolUse of toolUses) {
    if (!toolUse || !isObject(toolUse)) continue;

    // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
    const record = toolUse as UnknownRecord;
    const recipientName = isString(record.recipient_name)
      ? record.recipient_name.trim().toLowerCase()
      : '';
    if (!isTodoToolName(recipientName)) continue;

    const todos = extractTodos(record.parameters);
    if (todos) return todos;
  }

  return null;
}

function normalizeTodo<T>(raw: T): NormalizedTodo | null {
  if (!raw || !isObject(raw)) return null;

  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const record = raw as UnknownRecord;
  const content = isString(record.content)
    ? record.content.trim()
    : isString(record.title)
      ? record.title.trim()
      : isString(record.step)
        ? record.step.trim()
        : '';

  if (!content) return null;

  const id = isString(record.id) || isNumber(record.id) ? String(record.id) : content;

  return {
    content,
    status: isString(record.status) ? record.status : 'pending',
    priority: isString(record.priority) ? record.priority : 'medium',
    id,
  };
}

function isSameTodo(left: NormalizedTodo, right: NormalizedTodo) {
  return left.id === right.id && left.content === right.content;
}

function statusRank(status: string) {
  if (status === 'completed') return 3;
  if (status === 'in_progress') return 2;
  if (status === 'pending') return 1;
  return 0;
}

function extractTodosFromPart(part: Part): NormalizedTodo[] | null {
  if (part.type !== 'tool') return null;

  const toolName = part.tool.trim().toLowerCase();
  // SAFETY: The surrounding shape or discriminator check establishes the UnknownRecord contract used below.
  const toolState = part.state as UnknownRecord;

  if (toolName === 'parallel' || toolName.endsWith('.parallel')) {
    return (
      extractTodosFromParallelTool(toolState.input) ||
      extractTodosFromParallelTool(toolState.metadata)
    );
  }

  if (!isTodoToolName(toolName)) {
    return null;
  }

  return (
    extractTodosFromOutput(toolState.output) ||
    extractTodos(toolState.metadata) ||
    extractTodos(toolState.input) ||
    null
  );
}

function extractTodosFromOutput<T>(raw: T): NormalizedTodo[] | null {
  if (!isString(raw)) return extractTodos(raw);

  try {
    return extractTodos(JSON.parse(raw));
  } catch {
    return null;
  }
}

function areTodosEqual(left: NormalizedTodo[], right: NormalizedTodo[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftTodo = left[index]!;
    const rightTodo = right[index]!;
    if (
      leftTodo.id !== rightTodo.id ||
      leftTodo.content !== rightTodo.content ||
      leftTodo.status !== rightTodo.status ||
      leftTodo.priority !== rightTodo.priority
    ) {
      return false;
    }
  }

  return true;
}

function getLatestAssistantMessageInTurn(
  messages: MessageEntry[]
): MessageEntry<AssistantMessage> | undefined {
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.info.role === 'user') {
      lastUserMessageIndex = index;
      break;
    }
  }

  return messages
    .slice(lastUserMessageIndex + 1)
    .findLast(
      (message): message is MessageEntry<AssistantMessage> => message.info.role === 'assistant'
    );
}

function getLatestTodoMessageId(messages: MessageEntry[]) {
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.info.role === 'user') {
      lastUserMessageIndex = index;
      break;
    }
  }

  for (
    let messageIndex = messages.length - 1;
    messageIndex > lastUserMessageIndex;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex]!;
    if (message.info.role !== 'assistant') continue;

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const todos = extractTodosFromPart(message.parts[partIndex]!);
      if (todos) return message.info.id;
    }
  }

  return null;
}
