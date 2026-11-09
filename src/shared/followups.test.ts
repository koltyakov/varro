import { describe, expect, it } from 'vitest';
import {
  parseFollowupSuggestions,
  parseFollowupSource,
  parseFollowupTitle,
  readFollowupText,
} from './followups';

describe('follow-ups validation', () => {
  it.each([
    undefined,
    null,
    1,
    {},
    '',
    ' ',
    'x'.repeat(41),
    'Fix\nall',
    'Fix\tall',
    'Fix\u202eall',
  ])('rejects invalid action attribution %j', (title) => {
    expect(parseFollowupTitle(title)).toBeNull();
  });
  it('normalizes bounded action titles', () => {
    expect(parseFollowupTitle('  Inspect parser failures  ')).toBe('Inspect parser failures');
  });
  const action = {
    title: 'Inspect failing tests',
    prompt: 'Investigate the reported parser failures without unrelated edits.',
  };
  it('round-trips stored action session IDs without accepting them from generated output', () => {
    const stored = {
      summary: 'A parser fix is running.',
      actions: [{ ...action, sessionId: 'ses_fork-1' }],
    };
    expect(parseFollowupSuggestions(JSON.stringify(stored), { allowSessionId: true })).toEqual(
      stored
    );
    expect(() => parseFollowupSuggestions(JSON.stringify(stored))).toThrow();
  });
  it.each(['', '../session', 'x'.repeat(201), null, 42])(
    'rejects an invalid stored session ID %j',
    (sessionId) => {
      expect(() =>
        parseFollowupSuggestions(
          JSON.stringify({
            summary: 'A parser fix is running.',
            actions: [{ ...action, sessionId }],
          }),
          { allowSessionId: true }
        )
      ).toThrow();
    }
  );
  it.each([0, 1, 2, 3])('accepts %s grounded action shapes without padding', (count) => {
    const actions = Array.from({ length: count }, (_, i) => ({
      title: `${action.title} ${i}`,
      prompt: `${action.prompt} Case ${i}.`,
    }));
    const summary = count
      ? 'The parser failures remain unresolved. Investigating them and adding focused coverage would address the reported gaps.'
      : '';
    expect(parseFollowupSuggestions(JSON.stringify({ summary, actions }))).toEqual({
      summary,
      actions,
    });
  });
  it.each([
    'not json',
    '[]',
    '{"actions":[],"run":true}',
    JSON.stringify({ summary: 'Useful context', actions: [action, action] }),
    JSON.stringify({ summary: 'Useful context', actions: [{ ...action, title: 'x'.repeat(41) }] }),
    JSON.stringify({ summary: 'Useful context', actions: [{ ...action, prompt: '/publish' }] }),
    JSON.stringify({
      summary: 'Useful context',
      actions: [{ ...action, prompt: 'x'.repeat(601) }],
    }),
    JSON.stringify({ summary: 'Useful context', actions: [{ ...action, title: 'Fix\nall' }] }),
    JSON.stringify({ summary: 'Useful context', actions: [{ ...action, title: 'Fix\u202eall' }] }),
    JSON.stringify({ summary: 'Useful context', actions: [{ ...action, command: 'execute' }] }),
    JSON.stringify({ summary: 'Useful context', actions: [null] }),
    JSON.stringify({ actions: [action] }),
    JSON.stringify({ summary: '', actions: [action] }),
    JSON.stringify({ summary: 'x'.repeat(401), actions: [action] }),
    JSON.stringify({ summary: 'Unsafe\u202econtext', actions: [action] }),
    JSON.stringify({ summary: 42, actions: [action] }),
    JSON.stringify({
      summary: 'Useful context',
      actions: Array.from({ length: 4 }, (_, i) => ({ title: `Task ${i}`, prompt: `Prompt ${i}` })),
    }),
    'x'.repeat(4_097),
  ])('rejects malformed or unsafe shape %j', (text) => {
    expect(() => parseFollowupSuggestions(text)).toThrow();
  });
  it('uses only visible, non-synthetic text and abstains for incomplete context', () => {
    expect(
      readFollowupText([
        { type: 'text', text: 'Real request' },
        { type: 'text', text: 'Hidden context', synthetic: true },
        { type: 'reasoning', text: 'Private reasoning' },
        { type: 'text', text: 'Ignored', ignored: true },
      ])
    ).toBe('Real request');
    const source = {
      assistantMessageId: 'a',
      userMessageId: 'u',
      userPrompt: 'Fix it',
      answer: 'One issue remains',
    };
    expect(parseFollowupSource(source)).toEqual(source);
    expect(parseFollowupSource({ ...source, answer: 'x'.repeat(12_001) })).toBeNull();
    expect(parseFollowupSource({ ...source, userMessageId: '../other' })).toBeNull();
    expect(parseFollowupSource({ ...source, userPrompt: '' })).toBeNull();
  });
});
