import type { AssistantMessage, ToolStateError } from '../types';

function normalizeAbortText(value: string | null | undefined) {
  return value?.trim().toLowerCase() || '';
}

export function isAbortedAssistantError(error: AssistantMessage['error'] | undefined) {
  const name = normalizeAbortText(error?.name);
  const message = normalizeAbortText(error?.data?.message);
  return name === 'aborted' || name === 'aborterror' || message === 'aborted';
}

export function isAbortedToolError(state: { status: string; error?: string } | ToolStateError) {
  if (state.status !== 'error') return false;
  const error = normalizeAbortText('error' in state ? state.error : undefined);
  return error === 'aborted' || error === 'aborterror';
}
