import { describe, expect, it } from 'vitest';
import {
  formatReasoningDuration,
  formatReasoningHeader,
  parseStreamingTextSegments,
  splitReasoningText,
} from './MessagePart';

describe('formatReasoningDuration', () => {
  it('returns null while reasoning is still running', () => {
    expect(formatReasoningDuration({ start: 12 })).toBeNull();
  });

  it('formats completed reasoning time', () => {
    expect(formatReasoningDuration({ start: 10, end: 17 })).toBe('7ms');
  });
});

describe('formatReasoningHeader', () => {
  it('shows the subject without the Thinking prefix when present', () => {
    expect(formatReasoningHeader('Inspecting extension util files')).toBe(
      'Inspecting extension util files'
    );
  });

  it('falls back to Thinking when there is no subject', () => {
    expect(formatReasoningHeader(null)).toBe('Thinking');
  });

  it('appends detail labels after the primary heading', () => {
    expect(formatReasoningHeader('Inspecting extension util files', 'GPT-5 · High Reasoning')).toBe(
      'Inspecting extension util files · GPT-5 · High Reasoning'
    );
  });
});

describe('splitReasoningText', () => {
  it('moves a bold first line into the thinking header', () => {
    expect(
      splitReasoningText(
        '**Considering layout options**\n\nI am weighing warning and error displays.'
      )
    ).toEqual({
      subject: 'Considering layout options',
      body: 'I am weighing warning and error displays.',
    });
  });

  it('ignores reasoning text without a standalone bold subject line', () => {
    expect(splitReasoningText('Thinking through the layout options.')).toEqual({
      subject: null,
      body: 'Thinking through the layout options.',
    });
  });

  it('skips leading blank lines before extracting the subject', () => {
    expect(splitReasoningText('\n\n**Plan the migration**\n\nStep one\nStep two')).toEqual({
      subject: 'Plan the migration',
      body: 'Step one\nStep two',
    });
  });
});

describe('parseStreamingTextSegments', () => {
  it('keeps plain paragraphs and fenced code separate', () => {
    expect(
      parseStreamingTextSegments('First paragraph\n\n```ts\nconst x = 1;\n```\n\nSecond')
    ).toEqual([
      { type: 'text', content: 'First paragraph' },
      { type: 'code', content: 'const x = 1;\n', language: 'ts' },
      { type: 'text', content: 'Second' },
    ]);
  });
});
