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

export function isAbortedAssistantError(
  error: { name?: string | null; data?: { message?: string | null } } | undefined
) {
  const name = normalizeAbortText(error?.name);
  const message = normalizeAbortText(error?.data?.message);
  return (
    name === 'aborted' ||
    name === 'aborterror' ||
    name === 'messageabortederror' ||
    message === 'aborted'
  );
}

export function isAbortedToolError(state: { status: string; error?: string }) {
  if (state.status !== 'error') return false;
  const error = normalizeAbortText(state.error);
  return error === 'aborted' || error === 'aborterror' || error.includes('aborted');
}
