import { beforeEach, describe, expect, it } from 'vitest';
import { diagnosticRoute, diagnosticTimeline, redactDiagnosticText } from './diagnostics';

beforeEach(() => diagnosticTimeline.clear());

describe('diagnostic export', () => {
  it('redacts credentials and all URL query values while optionally retaining local paths', () => {
    const snapshot = [
      'Authorization: Bearer bearer-secret',
      'Basic YmFzaWMtc2VjcmV0',
      'api_key="key-secret"',
      '{"refresh_token":"refresh-secret", "password":"password-secret"}',
      'https://user:url-password@example.com/status?code=oauth-secret&anything=query-secret#fragment-secret',
      'Binary: `/Users/alex/My Tools/opencode`',
      'Windows: `C:\\Users\\alex\\opencode.exe`',
    ].join('\n');
    const redacted = diagnosticTimeline.export(snapshot);
    for (const secret of [
      'bearer-secret',
      'YmFzaWMtc2VjcmV0',
      'key-secret',
      'refresh-secret',
      'password-secret',
      'url-password',
      'oauth-secret',
      'query-secret',
      'fragment-secret',
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).not.toContain('/Users/alex');
    expect(redacted).not.toContain('C:\\Users');
    expect(diagnosticTimeline.export(snapshot, false)).toContain('/Users/alex/My Tools/opencode');
    expect(redacted).toContain('https://example.com/status');
  });

  it('bounds event count, fields, and exports while retaining stream activity independently', () => {
    diagnosticTimeline.streamActivity('stream-1');
    for (let index = 0; index < 150; index += 1) {
      diagnosticTimeline.record({
        event: 'workspace-activated',
        operationId: `request-${index}`,
        directory: `/repo/${'a'.repeat(1000)}`,
      });
    }
    const report = diagnosticTimeline.export('# Snapshot');
    expect(report).toContain('Retained events: 100/100');
    expect(report).not.toContain('"request-49"');
    expect(report).toContain('"request-50"');
    expect(report).toContain('(stream-1)');
    expect(report).not.toContain('/repo/');
    expect(diagnosticTimeline.export('', false)).not.toContain('a'.repeat(257));
    expect(diagnosticTimeline.export('x'.repeat(100_000)).length).toBeLessThanOrEqual(64 * 1024);
  });

  it('keeps endpoint names and correlation IDs without retaining arbitrary path or query content', () => {
    const route = diagnosticRoute('/session/private-session/message?token=secret');
    expect(route).toBe('/session/:id/message');
    diagnosticTimeline.record({
      event: 'rest-failure',
      operationId: 'request-1',
      route,
      status: 503,
    });
    const report = diagnosticTimeline.export('');
    expect(report).toContain('/session/:id/message');
    expect(report).toContain('request-1');
    expect(report).not.toContain('private-session');
    expect(report).not.toContain('secret');
  });

  it('handles quoted and unquoted secrets without depending on verbose logging', () => {
    expect(
      redactDiagnosticText('x-api-key: abc123\nclient_secret=xyz\naccess_token: "quoted secret"')
    ).not.toMatch(/abc123|xyz|quoted secret/);
    expect(diagnosticTimeline.export('# Ready')).toContain('Retained events: 0/100');
  });
});
