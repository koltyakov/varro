import { setState, state } from '../lib/state';
import type { AssistantMessage, Message, Part, Todo } from '../types';

const TODO_TOOL_NAMES = new Set(['todowrite', 'update_plan', 'updateplan']);

export function resetTodoSync() {
  // Todos are always derived from message tool parts; resets only clear session state elsewhere.
}

export function createTodoSyncOperations() {
  const syncTodosFromMessagesWithState = (
    messages: Array<{ info: Message; parts: Part[] }> = state.messages
  ) => {
    syncTodosFromMessages((todos) => setState('todos', todos), messages);
  };

  const handoffTodosToMessagesWithState = (
    messages: Array<{ info: Message; parts: Part[] }> = state.messages
  ) => {
    const handedOff = handoffTodosToMessages(
      state.todos,
      (todos) => setState('todos', todos),
      messages
    );
    return handedOff;
  };

  return {
    resetTodoSync,
    syncTodosFromMessages: syncTodosFromMessagesWithState,
    handoffTodosToMessages: handoffTodosToMessagesWithState,
  };
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

export function deriveTodosFromMessages(messages: Array<{ info: Message; parts: Part[] }>): Todo[] {
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].info.role === 'user') {
      lastUserMessageIndex = index;
      break;
    }
  }

  for (
    let messageIndex = messages.length - 1;
    messageIndex > lastUserMessageIndex;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (message.info.role !== 'assistant') continue;

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const todos = extractTodosFromPart(message.parts[partIndex]);
      if (todos) return todos;
    }
  }

  return [];
}

export function syncTodosFromMessages(
  setTodos: (todos: Todo[]) => void,
  messages: Array<{ info: Message; parts: Part[] }>
) {
  setTodos(deriveTodosFromMessages(messages));
}

export function handoffTodosToMessages(
  currentTodos: Todo[],
  setTodos: (todos: Todo[]) => void,
  messages: Array<{ info: Message; parts: Part[] }>
): boolean {
  const nextTodos = deriveTodosFromMessages(messages);
  const latestAssistant = getLatestAssistantMessageInTurn(messages);
  const currentTodoMessageId = getLatestTodoMessageId(messages);

  // Refreshed message snapshots can briefly lose todo-bearing parts for the same reply,
  // or introduce a newer unfinished assistant shell before its todo state arrives.
  if (currentTodos.length > 0 && nextTodos.length === 0) {
    if (!latestAssistant) {
      return false;
    }

    if (!latestAssistant.info.time.completed && !latestAssistant.info.error) {
      return false;
    }

    if (currentTodoMessageId && latestAssistant.info.id === currentTodoMessageId) {
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
    if (!recipientName.includes('todowrite')) continue;

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

  if (!toolName.includes('todo') && !TODO_TOOL_NAMES.has(toolName)) {
    return null;
  }

  return extractTodos(toolState.input) || extractTodos(toolState.metadata) || null;
}

function getLatestAssistantMessageInTurn(
  messages: Array<{ info: Message; parts: Part[] }>
): { info: AssistantMessage; parts: Part[] } | undefined {
  let lastUserMessageIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].info.role === 'user') {
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
    if (messages[index].info.role === 'user') {
      lastUserMessageIndex = index;
      break;
    }
  }

  for (
    let messageIndex = messages.length - 1;
    messageIndex > lastUserMessageIndex;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex];
    if (message.info.role !== 'assistant') continue;

    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const todos = extractTodosFromPart(message.parts[partIndex]);
      if (todos) return message.info.id;
    }
  }

  return null;
}
