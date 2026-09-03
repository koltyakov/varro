import { describe, expect, it } from 'vitest';
import {
  formatProviderErrorDetails,
  formatProviderErrorMessage,
  friendlyErrorName,
  isAbortedAssistantError,
  isAbortedToolError,
  isPermissionRejectedToolError,
  isProviderAuthFailure,
  isQuestionSkippedToolError,
  isTransientProviderConnectionError,
} from './error-classification';

describe('friendlyErrorName', () => {
  it('maps known opencode error names to human-readable labels', () => {
    expect(friendlyErrorName('MessageOutputLengthError')).toBe('Output length exceeded');
    expect(friendlyErrorName('ContextOverflowError')).toBe('Context window overflow');
    expect(friendlyErrorName('ProviderAuthError')).toBe('Provider authentication failed');
    expect(friendlyErrorName('StructuredOutputError')).toBe('Structured output failed');
  });

  it('passes through unknown error names unchanged', () => {
    expect(friendlyErrorName('APIError')).toBe('APIError');
    expect(friendlyErrorName('SomeNewError')).toBe('SomeNewError');
  });

  it('trims whitespace', () => {
    expect(friendlyErrorName('  MessageOutputLengthError  ')).toBe('Output length exceeded');
  });

  it('returns null for empty or missing input', () => {
    expect(friendlyErrorName(null)).toBeNull();
    expect(friendlyErrorName(undefined)).toBeNull();
    expect(friendlyErrorName('')).toBeNull();
    expect(friendlyErrorName('   ')).toBeNull();
  });
});

describe('formatProviderErrorMessage', () => {
  it('stays non-committal about the cause for a bare 404', () => {
    expect(
      formatProviderErrorMessage(
        { name: 'APIError', data: { message: 'Not Found', statusCode: 404 } },
        { providerID: 'openai' }
      )
    ).toBe(
      'The openai provider returned "Not Found". The model or API endpoint may be unavailable.'
    );
  });

  it('accepts the AI SDK error name alongside opencode APIError', () => {
    expect(
      formatProviderErrorMessage(
        { name: 'AI_APICallError', data: { message: 'Not Found', statusCode: 404 } },
        { providerID: 'openai' }
      )
    ).toBe(
      'The openai provider returned "Not Found". The model or API endpoint may be unavailable.'
    );
  });

  it('keeps the raw wording when the provider names the model', () => {
    expect(
      formatProviderErrorMessage(
        { name: 'APIError', data: { message: 'Model not found' } },
        { providerID: 'openai' }
      )
    ).toBe(
      'The openai provider returned "Model not found". The model or API endpoint may be unavailable.'
    );
  });

  it('omits the provider clause when providerID is missing', () => {
    expect(
      formatProviderErrorMessage({
        name: 'APIError',
        data: { message: 'Not Found', statusCode: 404 },
      })
    ).toBe('The provider returned "Not Found". The model or API endpoint may be unavailable.');
  });

  it('wraps terse provider errors with provider context', () => {
    expect(
      formatProviderErrorMessage(
        { name: 'APIError', data: { message: 'Internal Server Error', statusCode: 500 } },
        { providerID: 'openai' }
      )
    ).toBe('The openai provider returned an error: Internal Server Error');
  });

  it('wraps terse messages from legacy or unknown error shapes too', () => {
    expect(
      formatProviderErrorMessage(
        { name: 'server_error', data: { message: 'Internal Server Error' } },
        { providerID: 'github-copilot' }
      )
    ).toBe('The github-copilot provider returned an error: Internal Server Error');
    expect(
      formatProviderErrorMessage(
        { name: 'server_error', data: { message: 'Not Found' } },
        { providerID: 'github-copilot' }
      )
    ).toBe(
      'The github-copilot provider returned "Not Found". The model or API endpoint may be unavailable.'
    );
  });

  it('does not attribute known non-provider errors to the provider', () => {
    expect(
      formatProviderErrorMessage(
        { name: 'StructuredOutputError', data: { message: 'Invalid output' } },
        { providerID: 'openai' }
      )
    ).toBeNull();
    expect(
      formatProviderErrorMessage(
        { name: 'UnknownError', data: { message: 'Not Found' } },
        { providerID: 'openai' }
      )
    ).toBeNull();
  });

  it('falls back to a generic subject when provider is missing', () => {
    expect(
      formatProviderErrorMessage({
        name: 'APIError',
        data: { message: 'Not Found', statusCode: 404 },
      })
    ).toBe('The provider returned "Not Found". The model or API endpoint may be unavailable.');
  });

  it('synthesizes context from the status code when the message is missing', () => {
    expect(
      formatProviderErrorMessage(
        { name: 'APIError', data: { statusCode: 503 } },
        { providerID: 'openai' }
      )
    ).toBe('The openai provider returned an error (HTTP 503).');
    expect(
      formatProviderErrorMessage({ name: 'APIError', data: {} }, { providerID: 'openai' })
    ).toBe('The openai provider returned an error.');
  });

  it('returns null for descriptive messages so the raw text is shown', () => {
    const message = "This model's maximum context length is 200000 tokens. However, you requested.";
    expect(
      formatProviderErrorMessage(
        { name: 'APIError', data: { message, statusCode: 400 } },
        { providerID: 'openai' }
      )
    ).toBeNull();
  });

  it('returns null for aborted errors and missing errors', () => {
    expect(
      formatProviderErrorMessage(
        { name: 'aborted', data: { message: 'aborted' } },
        { providerID: 'openai' }
      )
    ).toBeNull();
    expect(formatProviderErrorMessage(undefined)).toBeNull();
  });
});

describe('formatProviderErrorDetails', () => {
  it('returns the raw provider error with context, name, status, and URL', () => {
    expect(
      formatProviderErrorDetails(
        {
          name: 'APIError',
          data: {
            message: 'Not Found',
            statusCode: 404,
            metadata: { url: 'https://api.openai.com/v1/responses' },
          },
        },
        { providerID: 'openai', modelID: 'gpt-5.6-sol' }
      )
    ).toBe(
      'openai / gpt-5.6-sol\nAPIError (HTTP 404)\nhttps://api.openai.com/v1/responses\nNot Found'
    );
  });

  it('reads the URL from data.url when metadata is absent', () => {
    const details = formatProviderErrorDetails({
      name: 'APIError',
      data: {
        message: 'Not Found',
        statusCode: 404,
        url: 'https://chatgpt.com/backend-api/codex/responses',
      },
    });
    expect(details).toContain('https://chatgpt.com/backend-api/codex/responses');
  });

  it('redacts credentials from diagnostic URLs', () => {
    const details = formatProviderErrorDetails({
      name: 'APIError',
      data: {
        url: 'https://user:password@example.com/v1?api_key=secret&access-token=token&mode=test#private',
      },
    });

    expect(details).toContain(
      'https://REDACTED@example.com/v1?api_key=REDACTED&access-token=REDACTED&mode=test'
    );
    expect(details).not.toContain('user');
    expect(details).not.toContain('password');
    expect(details).not.toContain('secret');
    expect(details).not.toContain('token&');
    expect(details).not.toContain('private');
  });

  it('omits malformed diagnostic URLs', () => {
    expect(
      formatProviderErrorDetails({ name: 'APIError', data: { url: 'http://[invalid' } })
    ).toContain('(invalid URL omitted)');
  });

  it('omits missing context and status code pieces', () => {
    expect(formatProviderErrorDetails({ name: 'server_error', data: {} })).toBe('server_error');
    expect(formatProviderErrorDetails({ name: 'APIError', data: { message: 'Not Found' } })).toBe(
      'APIError\nNot Found'
    );
  });

  it('appends a truncated response body when present', () => {
    const body = 'x'.repeat(2500);
    const details = formatProviderErrorDetails({
      name: 'APIError',
      data: { message: 'Bad Request', statusCode: 400, responseBody: body },
    });
    expect(details).toContain('APIError (HTTP 400)');
    expect(details).toContain('Bad Request');
    expect(details?.endsWith('...')).toBe(true);
    expect(details?.length).toBeLessThan(body.length);
  });

  it('marks an empty response body and includes only diagnostic headers', () => {
    const details = formatProviderErrorDetails({
      name: 'APIError',
      data: {
        message: 'Not Found',
        statusCode: 404,
        responseBody: '',
        responseHeaders: {
          server: 'cloudflare',
          'cf-ray': 'a3558afbee816c31-DFW',
          'content-type': 'text/html',
          nel: '{"report_to":"cf-nel"}',
          'x-empty': '   ',
        },
      },
    });
    expect(details).toContain('(empty response body)');
    expect(details).toContain('cf-ray: a3558afbee816c31-DFW');
    expect(details).toContain('server: cloudflare');
    expect(details).not.toContain('content-type');
    expect(details).not.toContain('nel');
    expect(details).not.toContain('x-empty');
    expect(details?.indexOf('cf-ray:')).toBeLessThan(details?.indexOf('server:') ?? 0);
  });

  it('returns null for aborted or missing errors', () => {
    expect(
      formatProviderErrorDetails({ name: 'aborted', data: { message: 'aborted' } })
    ).toBeNull();
    expect(formatProviderErrorDetails(undefined)).toBeNull();
  });
});

describe('isAbortedAssistantError', () => {
  it('detects legacy "aborted" error name', () => {
    expect(isAbortedAssistantError({ name: 'aborted', data: { message: 'Aborted' } })).toBe(true);
    expect(isAbortedAssistantError({ name: 'AbortError' })).toBe(true);
  });

  it('detects opencode MessageAbortedError', () => {
    expect(
      isAbortedAssistantError({
        name: 'MessageAbortedError',
        data: { message: 'The user aborted a request.' },
      })
    ).toBe(true);
  });

  it('detects abort via data.message fallback', () => {
    expect(isAbortedAssistantError({ name: 'UnknownError', data: { message: 'aborted' } })).toBe(
      true
    );
  });

  it('rejects non-abort errors', () => {
    expect(isAbortedAssistantError({ name: 'APIError', data: { message: 'timeout' } })).toBe(false);
    expect(isAbortedAssistantError(undefined)).toBe(false);
  });
});

describe('isProviderAuthFailure', () => {
  it('detects provider auth errors that require reconnection', () => {
    expect(
      isProviderAuthFailure({
        name: 'ProviderAuthError',
        data: { message: 'Token refresh failed: 401' },
      })
    ).toBe(true);
    expect(
      isProviderAuthFailure({
        name: 'ProviderAuthError',
        data: { message: 'Token expired' },
      })
    ).toBe(true);
  });

  it('preserves provider credential validation errors', () => {
    expect(
      isProviderAuthFailure({
        name: 'ProviderAuthError',
        data: { message: 'Bearer token is not region-scoped for this endpoint' },
      })
    ).toBe(false);
  });

  it('detects unauthorized API responses and invalidated-token messages', () => {
    expect(
      isProviderAuthFailure({
        name: 'APIError',
        data: { message: 'Unauthorized', statusCode: 401 },
      })
    ).toBe(true);
    expect(
      isProviderAuthFailure({
        name: 'UnknownError',
        data: { message: 'Your authentication token has been invalidated.' },
      })
    ).toBe(true);
  });

  it('detects terminal OAuth refresh failures that require reconnection', () => {
    expect(
      isProviderAuthFailure({
        name: 'UnknownError',
        data: { message: 'OAuth refresh rejected credentials (invalid_grant)' },
      })
    ).toBe(true);
    expect(
      isProviderAuthFailure({
        name: 'UnknownError',
        data: { message: 'The refresh token has expired' },
      })
    ).toBe(true);
    expect(
      isProviderAuthFailure({
        name: 'UnknownError',
        data: { message: 'The refresh token has been revoked' },
      })
    ).toBe(true);
  });

  it('detects GitHub Copilot rejecting an invalid OAuth token', () => {
    expect(
      isProviderAuthFailure({
        name: 'APIError',
        data: {
          message: 'Unauthorized: unauthorized: AuthenticateToken authentication failed',
          statusCode: 401,
        },
      })
    ).toBe(true);
  });

  it('rejects retryable non-auth errors', () => {
    expect(
      isProviderAuthFailure({
        name: 'APIError',
        data: { message: 'Service unavailable', statusCode: 503 },
      })
    ).toBe(false);
    expect(isProviderAuthFailure(undefined)).toBe(false);
  });
});

describe('isTransientProviderConnectionError', () => {
  it('detects retryable provider connection failures', () => {
    expect(
      isTransientProviderConnectionError({
        name: 'APIError',
        data: {
          message:
            'Cannot connect to API: Unable to connect. Is the computer able to access the url?',
          isRetryable: true,
        },
      })
    ).toBe(true);
    expect(
      isTransientProviderConnectionError({
        name: 'APIError',
        data: { message: 'Request failed', isRetryable: true, metadata: { code: 'ENOTFOUND' } },
      })
    ).toBe(true);
  });

  it('rejects HTTP and non-retryable API failures', () => {
    expect(
      isTransientProviderConnectionError({
        name: 'APIError',
        data: { message: 'Service unavailable', statusCode: 503, isRetryable: true },
      })
    ).toBe(false);
    expect(
      isTransientProviderConnectionError({
        name: 'APIError',
        data: { message: 'Cannot connect to API: offline', isRetryable: false },
      })
    ).toBe(false);
    expect(
      isTransientProviderConnectionError({
        name: 'UnknownError',
        data: { message: 'Cannot connect to API: offline', isRetryable: true },
      })
    ).toBe(false);
  });
});

describe('isAbortedToolError', () => {
  it('detects aborted tool errors', () => {
    expect(isAbortedToolError({ status: 'error', error: 'aborted' })).toBe(true);
    expect(isAbortedToolError({ status: 'error', error: 'AbortError' })).toBe(true);
    expect(isAbortedToolError({ status: 'error', error: 'Tool execution aborted' })).toBe(true);
  });

  it('rejects non-error status', () => {
    expect(isAbortedToolError({ status: 'completed', error: 'aborted' })).toBe(false);
  });

  it('rejects non-abort tool errors', () => {
    expect(isAbortedToolError({ status: 'error', error: 'timeout' })).toBe(false);
  });
});

describe('isPermissionRejectedToolError', () => {
  it('detects the OpenCode permission rejection error', () => {
    expect(
      isPermissionRejectedToolError({
        status: 'error',
        error: 'The user rejected permission to use this specific tool call.',
      })
    ).toBe(true);
  });

  it('does not confuse command-level permission failures with a user rejection', () => {
    expect(isPermissionRejectedToolError({ status: 'error', error: 'permission denied' })).toBe(
      false
    );
    expect(
      isPermissionRejectedToolError({
        status: 'completed',
        error: 'The user rejected permission to use this specific tool call.',
      })
    ).toBe(false);
  });
});

describe('isQuestionSkippedToolError', () => {
  it('detects the OpenCode question rejection error', () => {
    expect(
      isQuestionSkippedToolError({
        status: 'error',
        error: 'QuestionRejectedError: The user dismissed this question',
      })
    ).toBe(true);
  });

  it('does not confuse other question failures with a skipped question', () => {
    expect(isQuestionSkippedToolError({ status: 'error', error: 'Question request failed' })).toBe(
      false
    );
    expect(
      isQuestionSkippedToolError({
        status: 'completed',
        error: 'The user dismissed this question',
      })
    ).toBe(false);
  });
});
