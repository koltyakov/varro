import { appStore } from '../lib/stores/app-store';
import type { AssistantMessage, Message, Part, Todo } from '../types';

const TODO_TOOL_NAMES = new Set(['todowrite', 'update_plan', 'updateplan']);
type SessionEntry = { info: Message; parts: Part[] };
type TodoSyncDependencies = {
  loadSessionTodos?(sessionId: string): Promise<unknown>;
};

export function resetTodoSync() {
  appStore.setState('todos', []);
}

function setStateTodos(todos: Todo[], options?: { preserveAdvancedStatuses?: boolean }) {
  const nextTodos = options?.preserveAdvancedStatuses
    ? preserveAdvancedTodoStatuses(todos, appStore.state.todos)
    : todos;
  if (areTodosEqual(appStore.state.todos, nextTodos)) return;
  appStore.setState('todos', nextTodos);
}

export function createTodoSyncOperations(deps: TodoSyncDependencies = {}) {
  let nativeTodosEnabled = false;

  const applyNativeTodos = (raw: unknown, options?: { preserveAdvancedStatuses?: boolean }) => {
    const todos = extractTodos(raw);
    if (!todos) return false;
    nativeTodosEnabled = true;
    setStateTodos(todos, options);
    return true;
  };

  const syncTodosFromMessagesWithState = (
    messages: SessionEntry[] = appStore.state.messages,
    latestEventPayload?: unknown
  ) => {
    if (nativeTodosEnabled && applyNativeTodos(latestEventPayload)) return;
    if (nativeTodosEnabled) {
      advanceTodosFromMessages(messages);
      return;
    }
    syncTodosFromMessages(setStateTodos, messages, latestEventPayload);
  };

  const syncTodosForSessionWithState = async (
    sessionId: string,
    messages: SessionEntry[] = appStore.state.messages
  ) => {
    if (!deps.loadSessionTodos) {
      syncTodosFromMessagesWithState(messages);
      return;
    }

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
      syncTodosFromMessagesWithState(messages);
    }
  };

  const handoffTodosToMessagesWithState = (messages: SessionEntry[] = appStore.state.messages) => {
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

function advanceTodosFromMessages(messages: SessionEntry[]) {
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

function isStaleSettledNativeTodoSnapshot(todos: Todo[], messages: SessionEntry[]) {
  if (todos.length === 0 || todos.some((todo) => todo.status === 'completed')) return false;
  if (deriveTodosFromMessages(messages).length > 0) return false;

  const latestAssistant = getLatestAssistantMessageInTurn(messages);
  return !!latestAssistant?.info.time.completed && !latestAssistant.info.error;
}

export function extractTodos(raw: unknown): Todo[] | null {
  if (Array.isArray(raw)) {
    return raw.map(normalizeTodo).filter((todo): todo is Todo => Boolean(todo));
  }

  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  for (const key of ['todos', 'items', 'plan']) {
    const todos = extractTodos(record[key]);
    if (todos) return todos;
  }

  return null;
}

export function deriveTodosFromMessages(messages: SessionEntry[]): Todo[] {
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

export function syncTodosFromMessages(
  setTodos: (todos: Todo[]) => void,
  messages: SessionEntry[],
  latestEventPayload?: unknown
) {
  const eventTodos = extractTodos(latestEventPayload);
  const messageTodos = deriveTodosFromMessages(messages);
  setTodos(mergeTodoEventAdvance(messageTodos, eventTodos));
}

export function mergeTodoEventAdvance(messageTodos: Todo[], eventTodos: Todo[] | null): Todo[] {
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

export function preserveAdvancedTodoStatuses(nextTodos: Todo[], currentTodos: Todo[]): Todo[] {
  if (nextTodos.length === 0 || nextTodos.length !== currentTodos.length) return nextTodos;

  return nextTodos.map((nextTodo, index) => {
    const currentTodo = currentTodos[index]!;
    if (!isSameTodo(nextTodo, currentTodo)) return nextTodo;
    if (statusRank(currentTodo.status) <= statusRank(nextTodo.status)) return nextTodo;
    return { ...nextTodo, status: currentTodo.status };
  });
}

export function handoffTodosToMessages(
  currentTodos: Todo[],
  setTodos: (todos: Todo[]) => void,
  messages: Array<{ info: Message; parts: Part[] }>
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

function extractTodosFromParallelTool(raw: unknown): Todo[] | null {
  if (!raw || typeof raw !== 'object') return null;

  const toolUses = (raw as Record<string, unknown>).tool_uses;
  if (!Array.isArray(toolUses)) return null;

  for (const toolUse of toolUses) {
    if (!toolUse || typeof toolUse !== 'object') continue;

    const record = toolUse as Record<string, unknown>;
    const recipientName =
      typeof record.recipient_name === 'string' ? record.recipient_name.trim().toLowerCase() : '';
    if (!isTodoToolName(recipientName)) continue;

    const todos = extractTodos(record.parameters);
    if (todos) return todos;
  }

  return null;
}

function normalizeTodo(raw: unknown): Todo | null {
  if (!raw || typeof raw !== 'object') return null;

  const record = raw as Record<string, unknown>;
  const content =
    typeof record.content === 'string'
      ? record.content.trim()
      : typeof record.title === 'string'
        ? record.title.trim()
        : '';

  if (!content) return null;

  const id =
    typeof record.id === 'string' || typeof record.id === 'number' ? String(record.id) : content;

  return {
    content,
    status: typeof record.status === 'string' ? record.status : 'pending',
    priority: typeof record.priority === 'string' ? record.priority : 'medium',
    id,
  };
}

function isSameTodo(left: Todo, right: Todo) {
  return left.id === right.id && left.content === right.content;
}

function statusRank(status: string) {
  if (status === 'completed') return 3;
  if (status === 'in_progress') return 2;
  if (status === 'pending') return 1;
  return 0;
}

function isTodoToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('todo')) return true;

  const bareName = normalized.split('.').at(-1) ?? normalized;
  return TODO_TOOL_NAMES.has(normalized) || TODO_TOOL_NAMES.has(bareName);
}

function extractTodosFromPart(part: Part): Todo[] | null {
  if (part.type !== 'tool') return null;

  const toolName = part.tool.trim().toLowerCase();
  const toolState = part.state as Record<string, unknown>;

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

function extractTodosFromOutput(raw: unknown): Todo[] | null {
  if (typeof raw !== 'string') return extractTodos(raw);

  try {
    return extractTodos(JSON.parse(raw));
  } catch {
    return null;
  }
}

function areTodosEqual(left: Todo[], right: Todo[]) {
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
  messages: Array<{ info: Message; parts: Part[] }>
): { info: AssistantMessage; parts: Part[] } | undefined {
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
      (message): message is { info: AssistantMessage; parts: Part[] } =>
        message.info.role === 'assistant'
    );
}

function getLatestTodoMessageId(messages: Array<{ info: Message; parts: Part[] }>) {
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
