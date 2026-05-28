import type { AssistantMessage, FileDiff, Message, Part, Provider, StepFinishPart } from '../types';
import { validateFileDiffs } from './validate-diffs';

export type TokenUsage = {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export type AssistantDiffRequest = {
  sessionID: string;
  messageID: string;
};

export function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === 'assistant';
}

const numberFormatter = new Intl.NumberFormat('en-US');

export function formatNumber(value: number | undefined): string {
  if (!value) return '0';
  return numberFormatter.format(Math.round(value));
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function formatCost(cost: number | undefined): string {
  if (!cost) return '';
  if (cost < 0.01) return '<$0.01';
  return `$${cost.toFixed(2)}`;
}

export function sumSessionCost(messages: AssistantMessage[]): number {
  return messages.reduce((sum, msg) => sum + msg.cost, 0);
}

export function sumAssistantTokens(messages: AssistantMessage[]): TokenUsage {
  return messages.reduce<TokenUsage>(
    (acc, message) => {
      acc.total += getAssistantTotalTokens(message);
      acc.input += message.tokens.input || 0;
      acc.output += message.tokens.output || 0;
      acc.reasoning += message.tokens.reasoning || 0;
      acc.cacheRead += message.tokens.cache?.read || 0;
      acc.cacheWrite += message.tokens.cache?.write || 0;
      return acc;
    },
    { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  );
}

export function getAssistantTotalTokens(message: AssistantMessage): number {
  return (
    message.tokens.total ||
    message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      (message.tokens.cache?.read || 0) +
      (message.tokens.cache?.write || 0)
  );
}

export function getAssistantDuration(message: AssistantMessage): number | undefined {
  const end = message.time.completed;
  if (!end) return undefined;
  return end - message.time.created;
}

export function getAssistantDiffRequest(
  message: Message,
  isLastAssistant: boolean
): AssistantDiffRequest | null {
  if (!isLastAssistant || !isAssistantMessage(message) || !message.time.completed) return null;
  return { sessionID: message.sessionID, messageID: message.id };
}

export function getContextWindow(message: AssistantMessage, providers: Provider[]) {
  const provider = providers.find((item) => item.id === message.providerID);
  const model = provider?.models[message.modelID];
  const contextLimit = model?.limit?.context;
  if (!contextLimit) return null;

  const used =
    (message.tokens.input || 0) +
    (message.tokens.output || 0) +
    (message.tokens.reasoning || 0) +
    (message.tokens.cache?.read || 0) +
    (message.tokens.cache?.write || 0);
  return {
    used,
    limit: contextLimit,
    percent: Math.min((used / contextLimit) * 100, 100),
  };
}

export function getStepFinishParts(parts: Part[]): StepFinishPart[] {
  return parts.filter((part): part is StepFinishPart => part.type === 'step-finish');
}

export function getTaskDiffs(message: Message, fallback: FileDiff[] | undefined): FileDiff[] {
  if (message.role === 'user') return validateFileDiffs(message.summary?.diffs);
  return fallback || [];
}

export function formatRelativeAge(timestamp: number, now: number): string {
  const totalMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000));

  if (totalMinutes < 1) return 'now';

  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor(totalMinutes / 60);

  if (days >= 7) return `${Math.floor(days / 7)}w`;
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${totalMinutes}m`;
}
