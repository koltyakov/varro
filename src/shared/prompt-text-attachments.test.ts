import { describe, expect, it } from 'vitest';
import { appendPromptTextAttachments, splitPromptTextAttachments } from './prompt-text-attachments';

describe('prompt text attachments', () => {
  it('round-trips pasted text and annotations after the prompt', () => {
    const attachments = [
      { name: 'annotation-a781acb7.txt', text: 'Chat annotation\n\nComment:\nКак так?' },
      { name: 'pasted-text-1234abcd.txt', text: 'line 1\r\n\n</attached-text>\nline 3\n' },
    ];
    const text = appendPromptTextAttachments(
      'Review @annotation-a781acb7.txt @pasted-text-1234abcd.txt',
      attachments
    );

    expect(text).toContain(
      '\n\n<attached-text name="annotation-a781acb7.txt" length="34">\nChat annotation'
    );
    expect(splitPromptTextAttachments(text)).toEqual({
      text: 'Review @annotation-a781acb7.txt @pasted-text-1234abcd.txt',
      attachments,
    });
  });

  it('round-trips attachments without prompt text', () => {
    const attachments = [{ name: 'annotation-a781acb7.txt', text: 'note' }];
    expect(splitPromptTextAttachments(appendPromptTextAttachments('', attachments))).toEqual({
      text: '',
      attachments,
    });
  });

  it('skips an opening tag inside the prompt before the real blocks', () => {
    const prompt = 'Explain this:\n\n<attached-text name="annotation-00000000.txt" length="1">\nx';
    const attachments = [{ name: 'pasted-text-1234abcd.txt', text: 'body' }];
    expect(splitPromptTextAttachments(appendPromptTextAttachments(prompt, attachments))).toEqual({
      text: prompt,
      attachments,
    });
  });

  it.each([
    '<attached-text name="annotation-a781acb7.txt" length="5">\nnote\n</attached-text>',
    '<attached-text name="annotation-a781acb7.txt" length="4">\nnote\n</attached-text>\nmore',
    '<attached-text name="notes.txt" length="4">\nnote\n</attached-text>',
    'Prompt <attached-text name="annotation-a781acb7.txt" length="4">\nnote\n</attached-text>',
  ])('keeps malformed or unknown blocks as prompt text', (text) => {
    expect(splitPromptTextAttachments(text)).toEqual({ text, attachments: [] });
  });

  it('rejects names the projection would not recognize', () => {
    expect(() => appendPromptTextAttachments('', [{ name: 'notes.txt', text: 'x' }])).toThrow(
      'Invalid prompt text attachment name: notes.txt'
    );
  });
});
