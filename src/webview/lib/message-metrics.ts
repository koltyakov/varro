import type { AssistantMessage, FileDiff, Message, Part, Provider, StepFinishPart } from '../types';

export type TokenUsage = {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
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
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`;

  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
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
  if (message.role === 'user') return message.summary?.diffs || [];
  return fallback || [];
}
