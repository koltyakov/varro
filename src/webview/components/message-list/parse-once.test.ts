import { createMemo, createRoot, flush } from 'solid-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_RESUME_PROMPT } from '../../../shared/session-pauses';
import { registerHostExtension } from '../../host/extensions';
import {
  parseUserMessageContent,
  projectAutomaticActionMessage,
  projectAutomaticActionMessageWithContent,
} from '../message/UserMessageContent';
import type { AssistantMessage, MessageEntry, Part } from '../../types';
import { getMessageBlockBoundaryMap, getRenderEmptyMessageIds } from './row-layout';
import { getUserMessageNavigationPreviews } from './sticky-preview';

// The real parser asks the host's legacy context readers once per text line of every actual text
// parse. Counting that callback counts full parses without mocking the parser.
const readLegacyBlock = vi.fn(() => null);
let disposeHost: (() => void) | undefined;
function countParses() {
  readLegacyBlock.mockClear();
  disposeHost = registerHostExtension({
    id: 'test.parse-count',
    apiVersion: 1,
    contexts: [
      {
        id: 'test.parse-count.legacy',
        version: 1,
        validate: () => true,
        capture: () => ({ text: 'unused' }),
        readLegacyBlock,
      },
    ],
  });
  return () => readLegacyBlock.mock.calls.length;
}
afterEach(() => {
  disposeHost?.();
  disposeHost = undefined;
});

function user(id: string, parts: Part[], info: Partial<MessageEntry['info']> = {}): MessageEntry {
  // SAFETY: Fixtures supply the user-message fields these helpers read; overrides keep the user role.
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'user',
      time: { created: 10 },
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5' },
      ...info,
    } as MessageEntry['info'],
    parts,
  };
}
function text(id: string, value: string, extra: Partial<Part> = {}): Part {
  // SAFETY: Test fixtures supply the fields the parser and layout passes read for text parts.
  return { id, sessionID: 'session-1', messageID: id, type: 'text', text: value, ...extra } as Part;
}
function prompt(id: string, value = `Prompt ${id}`) {
  return user(id, [text(`${id}-text`, value)]);
}
function assistant(id: string, mode = 'default', sessionID = 'session-1'): MessageEntry {
  const info: AssistantMessage = {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 11, completed: 12 },
    parentID: 'u1',
    modelID: 'gpt-5',
    providerID: 'openai',
    mode,
    path: { cwd: '/workspace', root: '/workspace' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
  return { info, parts: [text(`${id}-text`, 'Assistant answer')] };
}
const boundaryOptions = (renderEmptyMessageIds: ReadonlySet<string> = new Set()) => ({
  expandedActivityGroup: () => false,
  renderEmptyMessageIds,
  showThinking: false,
});
const boundaries = (messages: MessageEntry[]) =>
  getMessageBlockBoundaryMap(messages, new Map(), boundaryOptions());
const renderEmpty = (messages: MessageEntry[]) =>
  getRenderEmptyMessageIds(messages, new Map(), () => false);
function observed<T>(read: () => T): T {
  let value!: T;
  const dispose = createRoot((cleanup) => {
    const memo = createMemo(read);
    value = memo();
    return cleanup;
  });
  flush();
  dispose();
  return value;
}

describe('one parse per user prompt in each whole-history pass', () => {
  const transcript = () => [prompt('u1'), assistant('a1'), prompt('u2'), prompt('u3')];

  it.each([
    ['untracked', <T>(read: () => T) => read()],
    ['observed', observed],
  ])('parses each plain prompt once per call (%s)', (_label, run) => {
    const parses = countParses();
    const messages = transcript();

    run(() => getUserMessageNavigationPreviews(messages));
    expect(parses()).toBe(3);
    readLegacyBlock.mockClear();
    run(() => boundaries(messages));
    expect(parses()).toBe(3);
    readLegacyBlock.mockClear();
    run(() => renderEmpty(messages));
    expect(parses()).toBe(3);
  });

  it('does not parse assistant rows or prompts that navigation skips before reading text', () => {
    const parses = countParses();
    const followup = user('f1', [text('f1-text', 'Run tests')], { followupTitle: 'Run tests' });
    const resume = user('r1', [text('r1-text', SESSION_RESUME_PROMPT)]);
    const subagentPrompt = user('s1', [text('s1-text', 'Child prompt')], {
      sessionID: 'child-session',
    });
    const previews = getUserMessageNavigationPreviews([
      assistant('a1'),
      followup,
      resume,
      assistant('a2', 'subagent', 'child-session'),
      subagentPrompt,
      prompt('u1'),
    ]);
    expect(previews.map((preview) => preview.id)).toEqual(['u1']);
    // Only the eligible prompt is parsed; skipped follow-ups, resumes and subagent prompts are not.
    expect(parses()).toBe(1);
  });
});

describe('navigation previews from one parse', () => {
  it('keeps preview text, counts, markup metadata, offsets and the empty sentinel', () => {
    // SAFETY: The fixture supplies every field the preview reads from a file part.
    const image = {
      id: 'img',
      sessionID: 'session-1',
      messageID: 'u2',
      type: 'file',
      mime: 'image/png',
      url: 'file:///a.png',
      filename: 'a.png',
    } as Part;
    const file = { ...image, id: 'doc', mime: 'text/plain', url: 'file:///b.ts', filename: 'b.ts' };
    const previews = getUserMessageNavigationPreviews(
      [
        prompt('u1', 'Fix   the\nbug'),
        user('u2', [text('u2-text', ''), image, file]),
        user('u3', [text('u3-text', '')]),
        user('u4', [text('u4-text', '(no content)')]),
        prompt('u5', 'Diagram\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
      ],
      new Set(),
      40
    );
    expect(previews).toEqual([
      expect.objectContaining({ id: 'u1', index: 40, sentAt: 10, text: 'Fix the bug' }),
      expect.objectContaining({
        id: 'u2',
        index: 41,
        text: 'Attachment: a.png',
        attachmentCount: 1,
        imageCount: 1,
      }),
      expect.objectContaining({
        id: 'u5',
        index: 44,
        format: expect.objectContaining({ kind: 'svg' }),
        formatPrefix: 'Diagram',
      }),
    ]);
    // An empty prompt and a literal "(no content)" prompt both match the skipped sentinel.
    expect(previews.map((preview) => preview.id)).not.toContain('u3');
    expect(previews.map((preview) => preview.id)).not.toContain('u4');
  });

  it('reads fresh text and attachments from the same array on a later call', () => {
    const parts: Part[] = [text('u1-text', 'First wording')];
    const messages = [user('u1', parts)];
    expect(getUserMessageNavigationPreviews(messages)[0]).toMatchObject({
      text: 'First wording',
      attachmentCount: 0,
    });
    // SAFETY: The fixture's first part is the text part created above.
    (parts[0] as { text: string }).text = 'Second wording';
    // SAFETY: The fixture supplies every field the preview reads from a file part.
    parts.push({
      id: 'doc',
      sessionID: 'session-1',
      messageID: 'u1',
      type: 'file',
      mime: 'text/plain',
      url: 'file:///b.ts',
      filename: 'b.ts',
    } as Part);
    expect(getUserMessageNavigationPreviews(messages)[0]).toMatchObject({
      text: 'Second wording',
      attachmentCount: 1,
    });
  });
});

const autoText = (id: string) =>
  text(id, 'Summarize the task tool output above and continue with your task.', {
    synthetic: true,
  });

describe('row-layout passes from one projection parse', () => {
  const automaticOnly = () =>
    user('auto', [
      text('auto-text', 'Summarize the task tool output above and continue with your task.', {
        synthetic: true,
      }),
    ]);
  const mixed = () =>
    user('mixed', [
      text('mixed-auto', 'Summarize the task tool output above and continue with your task.', {
        synthetic: true,
      }),
      text('mixed-text', 'Also check the logs'),
    ]);

  it('keeps user signatures, empty rows and automatic-action projection', () => {
    // SAFETY: Fixtures supply the summary and compaction fields these layout passes read.
    const messages = [
      prompt('plain'),
      user('empty', [text('empty-text', '')]),
      user('omitted', [text('omitted-text', '')], { summary: { diffs: [], diffsOmitted: true } }),
      user('compacted', [
        { id: 'c', sessionID: 'session-1', messageID: 'compacted', type: 'compaction' } as Part,
      ]),
      automaticOnly(),
      mixed(),
    ];
    const empty = renderEmpty(messages);
    expect([...empty]).toEqual(['empty']);

    const map = getMessageBlockBoundaryMap(messages, new Map(), boundaryOptions(empty));
    expect(map.get('plain')?.signature).toBe('user:content:b:b');
    expect(map.get('empty')?.signature).toBe('empty');
    expect(map.get('omitted')?.signature).toBe('user:content:b:b');
    expect(map.get('compacted')?.signature).toBe('user:empty:u:u');
    expect(map.get('mixed')?.signature).toBe('user:content:b:u:Continued after subagent task');
    // The automatic-only prompt is projected to an assistant row, not classified as a user row.
    expect(map.get('auto')?.signature.startsWith('user:')).toBe(false);
  });

  it.each([
    [
      'omitted diffs',
      () => user('veto', [autoText('veto-auto')], { summary: { diffs: [], diffsOmitted: true } }),
      'user:content:b:u:Continued after subagent task',
    ],
    [
      'compaction',
      () =>
        user('veto', [
          autoText('veto-auto'),
          // SAFETY: The fixture supplies the fields the projection reads from a compaction part.
          { id: 'veto-c', sessionID: 'session-1', messageID: 'veto', type: 'compaction' } as Part,
        ]),
      'user:empty:u:u:Continued after subagent task',
    ],
  ])('keeps an automatic-only prompt as a user row with %s', (_label, create, signature) => {
    const parses = countParses();
    const message = create();
    const projected = projectAutomaticActionMessageWithContent(message);
    expect(projected.message).toBe(message);
    expect(projected.content?.automaticActions).toEqual(['Continued after subagent task']);
    expect(projectAutomaticActionMessage(message)).toBe(message);
    readLegacyBlock.mockClear();

    const empty = renderEmpty([message]);
    expect(empty.has('veto')).toBe(false);
    expect(parses()).toBe(1);
    readLegacyBlock.mockClear();
    const map = getMessageBlockBoundaryMap([message], new Map(), boundaryOptions(empty));
    expect(map.get('veto')?.signature).toBe(signature);
    expect(parses()).toBe(1);
  });

  it('keeps the user role when a synthetic automatic prompt becomes a regular one', () => {
    const parts: Part[] = [autoText('u1-auto')];
    const messages = [user('u1', parts)];
    expect(boundaries(messages).get('u1')?.signature.startsWith('user:')).toBe(false);
    // SAFETY: The fixture's first part is the synthetic text part created above.
    (parts[0] as { synthetic?: boolean; text: string }).synthetic = false;
    // SAFETY: The same first part remains the text part.
    (parts[0] as { text: string }).text = 'Please continue';
    expect(boundaries(messages).get('u1')?.signature).toBe('user:content:b:b');
    expect(renderEmpty(messages).has('u1')).toBe(false);
  });

  it('reads fresh content from the same array on a later call', () => {
    const parts: Part[] = [text('u1-text', '')];
    const messages = [user('u1', parts)];
    expect(renderEmpty(messages).has('u1')).toBe(true);
    expect(boundaries(messages).get('u1')?.signature).toBe('user:empty:u:u');
    // SAFETY: The fixture's first part is the text part created above.
    (parts[0] as { text: string }).text = 'Now with content';
    expect(renderEmpty(messages).has('u1')).toBe(false);
    expect(boundaries(messages).get('u1')?.signature).toBe('user:content:b:b');
  });
});

describe('projectAutomaticActionMessageWithContent', () => {
  it('returns the deciding parse only for a retained user message', () => {
    const parses = countParses();
    const retained = prompt('u1');
    const result = projectAutomaticActionMessageWithContent(retained);
    expect(result.message).toBe(retained);
    expect(result.content).toEqual(parseUserMessageContent(retained.parts));
    expect(parses()).toBe(2);

    const answer = assistant('a1');
    expect(projectAutomaticActionMessageWithContent(answer)).toEqual({
      message: answer,
      content: null,
    });

    const automatic = user('auto', [
      text('auto-text', 'Summarize the task tool output above and continue with your task.', {
        synthetic: true,
      }),
    ]);
    const projected = projectAutomaticActionMessageWithContent(automatic);
    expect(projected.content).toBeNull();
    expect(projected.message).toEqual(projectAutomaticActionMessage(automatic));
    expect(projected.message.info.role).toBe('assistant');
  });
});
