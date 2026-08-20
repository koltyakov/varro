import type { Message, Part } from './opencode-types';

export type ContextBreakdownKey = 'system' | 'user' | 'assistant' | 'tool' | 'other';

export type ContextBreakdownSegment = {
  key: ContextBreakdownKey;
  tokens: number;
  percent: number;
};

export type ContextMessageEntry = { info: Message; parts: Part[] };

type AssistantPartCharacters = { assistant: number; tool: number };

const estimateTokens = (characters: number) => Math.ceil(characters / 4);

function getUserPartCharacters(part: Part): number {
  if (part.type === 'text') return part.text.length;
  if (part.type === 'file') return part.source?.text.value.length ?? 0;
  if (part.type === 'agent') return part.source?.value.length ?? 0;
  return 0;
}

function getAssistantPartCharacters(part: Part): AssistantPartCharacters {
  if (part.type === 'text' || part.type === 'reasoning') {
    return { assistant: part.text.length, tool: 0 };
  }
  if (part.type !== 'tool') return { assistant: 0, tool: 0 };

  const input = Object.keys(part.state.input).length * 16;
  if (part.state.status === 'pending') {
    return { assistant: 0, tool: input + part.state.raw.length };
  }
  if (part.state.status === 'completed') {
    return { assistant: 0, tool: input + part.state.output.length };
  }
  if (part.state.status === 'error') {
    return { assistant: 0, tool: input + part.state.error.length };
  }
  return { assistant: 0, tool: input };
}

export function estimateContextBreakdown(
  messages: readonly ContextMessageEntry[],
  inputTokens: number
): ContextBreakdownSegment[] {
  if (inputTokens <= 0) return [];

  let systemCharacters = 0;
  let userCharacters = 0;
  let assistantCharacters = 0;
  let toolCharacters = 0;

  for (const message of messages) {
    if (message.info.role === 'user') {
      if (message.info.system?.trim()) systemCharacters = message.info.system.trim().length;
      userCharacters += message.parts.reduce(
        (total, part) => total + getUserPartCharacters(part),
        0
      );
      continue;
    }

    for (const part of message.parts) {
      const characters = getAssistantPartCharacters(part);
      assistantCharacters += characters.assistant;
      toolCharacters += characters.tool;
    }
  }

  const estimated = {
    system: estimateTokens(systemCharacters),
    user: estimateTokens(userCharacters),
    assistant: estimateTokens(assistantCharacters),
    tool: estimateTokens(toolCharacters),
  };
  const estimatedTotal = Object.values(estimated).reduce((total, value) => total + value, 0);
  const scale = estimatedTotal > inputTokens ? inputTokens / estimatedTotal : 1;
  const tokens = {
    system: Math.floor(estimated.system * scale),
    user: Math.floor(estimated.user * scale),
    assistant: Math.floor(estimated.assistant * scale),
    tool: Math.floor(estimated.tool * scale),
  };
  const attributed = Object.values(tokens).reduce((total, value) => total + value, 0);

  return (
    [
      ['system', tokens.system],
      ['user', tokens.user],
      ['assistant', tokens.assistant],
      ['tool', tokens.tool],
      ['other', Math.max(0, inputTokens - attributed)],
    ] as const
  )
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({
      key,
      tokens: value,
      percent: Math.round((value / inputTokens) * 1_000) / 10,
    }));
}

export function estimateNestedContextBreakdown(
  sessions: readonly (readonly ContextMessageEntry[])[]
): ContextBreakdownSegment[] {
  const totals = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
    other: 0,
  } satisfies Record<ContextBreakdownKey, number>;
  let inputTokens = 0;

  for (const messages of sessions) {
    let sessionInputTokens = 0;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const info = messages[index]?.info;
      const input = info?.role === 'assistant' ? info.tokens?.input : 0;
      if (!input || input <= 0) continue;
      sessionInputTokens = input;
      break;
    }
    if (sessionInputTokens <= 0) continue;

    inputTokens += sessionInputTokens;
    for (const segment of estimateContextBreakdown(messages, sessionInputTokens)) {
      totals[segment.key] += segment.tokens;
    }
  }

  if (inputTokens <= 0) return [];
  const keys: ContextBreakdownKey[] = ['system', 'user', 'assistant', 'tool', 'other'];
  return keys
    .filter((key) => totals[key] > 0)
    .map((key) => ({
      key,
      tokens: totals[key],
      percent: Math.round((totals[key] / inputTokens) * 1_000) / 10,
    }));
}
