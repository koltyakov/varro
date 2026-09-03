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
  /\bunauthorized\b|token refresh failed:\s*401\b|invalid_grant|(?:authentication|access|refresh)?\s*token (?:has )?(?:expired|been revoked|been invalidated)|(?:api key|credentials?) (?:is |are )?missing|try signing in again/i;

export function isProviderAuthFailure(
  error:
    | {
        name?: string | null;
        data?: { message?: string | null; statusCode?: number | null };
      }
    | undefined
) {
  if (!error) return false;
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

const MODEL_NOT_FOUND_RE = /\bnot\s+found\b|\bdoes not exist\b|\bunknown model\b/i;
const TERSE_ERROR_MESSAGE_RE = /^[a-z][a-z0-9 .,'-]{0,63}$/i;
const PROVIDER_API_ERROR_NAMES = new Set(['APIError', 'AI_APICallError']);

export type ApiErrorMessageContext = {
  providerID?: string | null;
  modelID?: string | null;
};

function providerLabel(context: Pick<ApiErrorMessageContext, 'providerID'>) {
  const providerID = context.providerID?.trim();
  return providerID ? `${providerID} provider` : 'provider';
}

export function formatProviderErrorMessage(
  error:
    | {
        name?: string | null;
        data?: { message?: string | null; statusCode?: number | null };
      }
    | undefined,
  context: Pick<ApiErrorMessageContext, 'providerID'> = {}
): string | null {
  if (!error || isAbortedAssistantError(error)) return null;
  const message = error.data?.message?.trim();
  if (!message) {
    if (!PROVIDER_API_ERROR_NAMES.has(error.name ?? '')) return null;
    const statusCode = error.data?.statusCode;
    return `The ${providerLabel(context)} returned an error${statusCode ? ` (HTTP ${statusCode})` : ''}.`;
  }
  if (!TERSE_ERROR_MESSAGE_RE.test(message)) return null;
  if (MODEL_NOT_FOUND_RE.test(message) || error.data?.statusCode === 404) {
    return `The ${providerLabel(context)} returned "${message}". The model or API endpoint may be unavailable.`;
  }
  return `The ${providerLabel(context)} returned an error: ${message}`;
}

const MAX_ERROR_DETAILS_LENGTH = 2000;
const DIAGNOSTIC_RESPONSE_HEADERS = new Set([
  'cf-ray',
  'date',
  'request-id',
  'retry-after',
  'server',
  'x-request-id',
]);

export function formatProviderErrorDetails(
  error:
    | {
        name?: string | null;
        data?: {
          message?: string | null;
          statusCode?: number | null;
          responseBody?: string | null;
          responseHeaders?: { [key: string]: string } | null;
          url?: string | null;
          metadata?: { url?: string | null } | null;
        };
      }
    | undefined,
  context: ApiErrorMessageContext = {}
): string | null {
  if (!error || isAbortedAssistantError(error)) return null;
  const providerID = context.providerID?.trim();
  const modelID = context.modelID?.trim();
  const name = error.name?.trim() || 'Error';
  const statusCode = error.data?.statusCode;
  const lines: string[] = [];
  const subject = [providerID, modelID].filter(Boolean).join(' / ');
  if (subject) lines.push(subject);
  lines.push(statusCode ? `${name} (HTTP ${statusCode})` : name);
  const url = error.data?.url?.trim() || error.data?.metadata?.url?.trim();
  if (url) lines.push(url);
  const message = error.data?.message?.trim();
  if (message) lines.push(message);
  const responseBody = error.data?.responseBody?.trim();
  if (responseBody) {
    lines.push(
      responseBody.length > MAX_ERROR_DETAILS_LENGTH
        ? `${responseBody.slice(0, MAX_ERROR_DETAILS_LENGTH)}\n...`
        : responseBody
    );
  } else if (error.data?.responseBody != null) {
    lines.push('(empty response body)');
  }
  const responseHeaders = error.data?.responseHeaders;
  if (responseHeaders) {
    const headerLines = Object.entries(responseHeaders)
      .filter(
        ([key, value]) => DIAGNOSTIC_RESPONSE_HEADERS.has(key.toLowerCase()) && !!value.trim()
      )
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}: ${value}`);
    if (headerLines.length > 0) lines.push(headerLines.join('\n'));
  }
  return lines.join('\n');
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
