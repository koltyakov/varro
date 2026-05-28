import type { AssistantMessage, ToolStateError } from '../types';

const FRIENDLY_ERROR_NAMES: Record<string, string> = {
  MessageOutputLengthError: 'Output length exceeded',
  ContextOverflowError: 'Context window overflow',
  ProviderAuthError: 'Provider authentication failed',
  StructuredOutputError: 'Structured output failed',
};

export function friendlyErrorName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return FRIENDLY_ERROR_NAMES[trimmed] ?? trimmed;
}

function normalizeAbortText(value: string | null | undefined) {
  return value?.trim().toLowerCase() || '';
}

export function isAbortedAssistantError(error: AssistantMessage['error'] | undefined) {
  const name = normalizeAbortText(error?.name);
  const message = normalizeAbortText(error?.data?.message);
  return (
    name === 'aborted' ||
    name === 'aborterror' ||
    name === 'messageabortederror' ||
    message === 'aborted'
  );
}

export function isAbortedToolError(state: { status: string; error?: string } | ToolStateError) {
  if (state.status !== 'error') return false;
  const error = normalizeAbortText('error' in state ? state.error : undefined);
  return error === 'aborted' || error === 'aborterror' || error.includes('aborted');
}
