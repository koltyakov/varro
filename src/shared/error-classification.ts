const FRIENDLY_ERROR_NAMES = new Map<string, string>([
  ['MessageOutputLengthError', 'Output length exceeded'],
  ['ContextOverflowError', 'Context window overflow'],
  ['ProviderAuthError', 'Provider authentication failed'],
  ['StructuredOutputError', 'Structured output failed'],
]);

export function friendlyErrorName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return FRIENDLY_ERROR_NAMES.get(trimmed) ?? trimmed;
}

const AUTH_INVALIDATED_RE =
  /authentication token has been invalidated|token refresh failed:\s*401\b|invalid_grant|refresh token (?:has )?(?:expired|been revoked|been invalidated)|try signing in again/i;

export function isProviderAuthFailure(
  error:
    | {
        name?: string | null;
        data?: { message?: string | null; statusCode?: number | null };
      }
    | undefined
) {
  if (!error) return false;
  if (error.name === 'ProviderAuthError') return true;
  if (error.data?.statusCode === 401) return true;
  return AUTH_INVALIDATED_RE.test(error.data?.message || '');
}

const TRANSIENT_CONNECTION_RE =
  /cannot connect to api:|\b(?:econnreset|econnrefused|enotfound|eai_again|etimedout)\b/i;

export function isTransientProviderConnectionError(
  error:
    | {
        name?: string | null;
        data?: {
          message?: string | null;
          statusCode?: number | null;
          isRetryable?: boolean | null;
          metadata?: Record<string, string> | null;
        };
      }
    | undefined
) {
  if (error?.name !== 'APIError' || error.data?.isRetryable !== true) return false;
  if (error.data.statusCode) return false;
  const metadata = Object.entries(error.data.metadata ?? {})
    .flat()
    .join(' ');
  return TRANSIENT_CONNECTION_RE.test(`${error.data.message || ''} ${metadata}`);
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

export function isPermissionRejectedToolError(state: { status: string; error?: string }) {
  if (state.status !== 'error') return false;
  return normalizeAbortText(state.error).includes(
    'user rejected permission to use this specific tool call'
  );
}

export function isQuestionSkippedToolError(state: { status: string; error?: string }) {
  if (state.status !== 'error') return false;
  return normalizeAbortText(state.error).includes('user dismissed this question');
}
