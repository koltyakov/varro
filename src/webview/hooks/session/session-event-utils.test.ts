import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '../../types';
import {
  asToolInput,
  asToolMetadata,
  getEventString,
  getToolErrorMessage,
  getToolStartTime,
  getToolStateInput,
  parseToolInput,
  toolOutputToString,
} from './session-event-utils';

function toolPart(state: Extract<Part, { type: 'tool' }>['state']): Part {
  return {
    id: 'call-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    state,
  };
}

function textPart(): Part {
  return { id: 'p-1', sessionID: 'session-1', messageID: 'message-1', type: 'text', text: 'hi' };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('getEventString', () => {
  it('returns the value only for string properties', () => {
    expect(getEventString({ name: 'bash' }, 'name')).toBe('bash');
    expect(getEventString({ name: '' }, 'name')).toBe('');
  });

  it('returns undefined for non-string values and non-object carriers', () => {
    expect(getEventString({ name: 42 }, 'name')).toBeUndefined();
    expect(getEventString({ name: null }, 'name')).toBeUndefined();
    expect(getEventString({ name: { nested: 'bash' } }, 'name')).toBeUndefined();
    expect(getEventString(null, 'name')).toBeUndefined();
    expect(getEventString('bash', 'name')).toBeUndefined();
    expect(getEventString(undefined, 'name')).toBeUndefined();
  });

  it('does not read inherited properties as event values', () => {
    expect(getEventString({}, 'toString')).toBeUndefined();
  });
});

describe('parseToolInput', () => {
  it('parses a JSON object payload', () => {
    expect(parseToolInput('{"command":"ls -la"}')).toEqual({ command: 'ls -la' });
  });

  it('returns an empty object for blank, malformed, or non-object JSON', () => {
    expect(parseToolInput('')).toEqual({});
    expect(parseToolInput('   ')).toEqual({});
    expect(parseToolInput('{"command":')).toEqual({});
    expect(parseToolInput('["ls"]')).toEqual({});
    expect(parseToolInput('"ls"')).toEqual({});
    expect(parseToolInput('null')).toEqual({});
  });
});

describe('asToolInput / asToolMetadata', () => {
  it('passes plain objects through and rejects everything else', () => {
    const record = { a: 1 };
    for (const coerce of [asToolInput, asToolMetadata]) {
      expect(coerce(record)).toBe(record);
      expect(coerce([1, 2])).toEqual({});
      expect(coerce(null)).toEqual({});
      expect(coerce(undefined)).toEqual({});
      expect(coerce('text')).toEqual({});
      expect(coerce(7)).toEqual({});
    }
  });
});

describe('getToolStateInput', () => {
  it('returns the recorded input for a tool part', () => {
    const input = { command: 'ls' };
    expect(getToolStateInput(toolPart({ status: 'pending', input, raw: '' }))).toBe(input);
  });

  it('returns an empty object for non-tool parts and non-object inputs', () => {
    expect(getToolStateInput(textPart())).toEqual({});
    expect(
      getToolStateInput(
        toolPart({ status: 'pending', input: [] as unknown as Record<string, unknown>, raw: '' })
      )
    ).toEqual({});
  });
});

describe('getToolStartTime', () => {
  it('returns the recorded start time when present', () => {
    expect(
      getToolStartTime(toolPart({ status: 'running', input: {}, time: { start: 1234 } }))
    ).toBe(1234);
  });

  it('falls back to now when the part is not a tool or has no start time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    expect(getToolStartTime(textPart())).toBe(5000);
    expect(getToolStartTime(toolPart({ status: 'pending', input: {}, raw: '' }))).toBe(5000);
  });
});

describe('getToolErrorMessage', () => {
  it('uses a string error verbatim', () => {
    expect(getToolErrorMessage('boom')).toBe('boom');
  });

  it('unwraps an error object message', () => {
    expect(getToolErrorMessage({ message: 'permission denied' })).toBe('permission denied');
    expect(getToolErrorMessage(new Error('spawn failed'))).toBe('spawn failed');
  });

  it('falls back to a generic message for unusable errors', () => {
    expect(getToolErrorMessage(undefined)).toBe('Tool execution failed');
    expect(getToolErrorMessage(null)).toBe('Tool execution failed');
    expect(getToolErrorMessage({ message: 42 })).toBe('Tool execution failed');
    expect(getToolErrorMessage({})).toBe('Tool execution failed');
  });
});

describe('toolOutputToString', () => {
  it('joins text blocks from a content array', () => {
    expect(
      toolOutputToString(
        [
          { type: 'text', text: 'line one' },
          { type: 'text', text: 'line two' },
        ],
        null
      )
    ).toBe('line one\nline two');
  });

  it('renders file blocks as their uri and skips unusable entries', () => {
    expect(
      toolOutputToString(
        [
          null,
          'raw string',
          { type: 'text', text: 'kept' },
          { type: 'text' },
          { type: 'file', uri: 'file:///tmp/out.txt' },
          { type: 'image', data: 'AAAA' },
        ],
        null
      )
    ).toBe('kept\nfile:///tmp/out.txt');
  });

  it('falls back to structured JSON when the content array yields no text', () => {
    expect(toolOutputToString([{ type: 'image', data: 'AAAA' }], { ok: true })).toBe(
      JSON.stringify({ ok: true }, null, 2)
    );
    expect(toolOutputToString(null, { ok: true })).toBe(JSON.stringify({ ok: true }, null, 2));
  });

  it('prefers content text over structured output', () => {
    expect(toolOutputToString([{ type: 'text', text: 'from content' }], { ok: true })).toBe(
      'from content'
    );
  });

  it('degrades to String() when structured output is not serializable', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(toolOutputToString(null, circular)).toBe(String(circular));
  });

  it('returns an empty string when neither content nor structured output is usable', () => {
    expect(toolOutputToString(null, null)).toBe('');
    expect(toolOutputToString([{ type: 'image', data: 'AAAA' }], null)).toBe('');
    expect(toolOutputToString('plain text', undefined)).toBe('');
    expect(toolOutputToString([], undefined)).toBe('');
  });
});
