import { describe, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/protocol';
import {
  asRecord,
  assertValidJson,
  getSessionIdsForEvent,
  normalizeCliOutput,
  parseModelRoute,
} from './sidebar-provider-utils';

describe('sidebar-provider utils', () => {
  it('coerces record-like values', () => {
    expect(asRecord({ ok: true })).toEqual({ ok: true });
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord('nope')).toBeUndefined();
  });

  it('validates and normalizes JSON and CLI output', () => {
    expect(() => assertValidJson('{"ok":true}', 'Export')).not.toThrow();
    expect(() => assertValidJson('{', 'Export')).toThrow('Export returned invalid JSON');
    expect(normalizeCliOutput('  hello  ')).toBe('hello');
    expect(normalizeCliOutput(Buffer.from('  hi  '))).toBe('hi');
    expect(normalizeCliOutput(42)).toBe('42');
  });

  it('parses model routes and extracts session ids from events', () => {
    expect(parseModelRoute('openai/gpt-5')).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
    expect(parseModelRoute('invalid')).toBeNull();

    const event: ServerEvent = {
      type: 'message.part.updated',
      properties: {
        sessionID: 'session-root',
        info: { id: 'message-1', sessionID: 'session-info' },
        part: { sessionID: 'session-part' },
      },
    };

    expect(getSessionIdsForEvent(event)).toEqual([
      'session-root',
      'message-1',
      'session-info',
      'session-part',
    ]);
  });
});
