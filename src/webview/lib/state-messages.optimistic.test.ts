import { beforeEach, describe, expect, it } from 'vitest';
import type { FilePart, MessageEntry, Part, UserMessage } from '../types';
import { clearMessages, setMessagesIncremental, state, upsertMessage, upsertPart } from './state';
import { upsertMessageInfo } from './state-messages';

const OPTIMISTIC_ID = 'optimistic-user-1';

function userMessage(id: string, sessionID = 'session-1'): UserMessage {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created: 1 },
    agent: 'build',
    model: { providerID: 'provider-1', modelID: 'model-1' },
  };
}

function textPart(id: string, messageID: string, text: string, sessionID = 'session-1'): Part {
  return { id, sessionID, messageID, type: 'text', text };
}

function imagePart(
  id: string,
  messageID: string,
  overrides: Partial<Pick<FilePart, 'url' | 'mime' | 'filename' | 'sessionID'>> = {}
): Part {
  return {
    id,
    sessionID: overrides.sessionID ?? 'session-1',
    messageID,
    type: 'file',
    mime: overrides.mime ?? 'image/png',
    filename: overrides.filename ?? 'pasted-1.png',
    url: overrides.url ?? 'data:image/png;base64,AAAA',
  };
}

function optimisticEntry(parts: Part[], sessionID = 'session-1'): MessageEntry {
  return { info: userMessage(OPTIMISTIC_ID, sessionID), parts };
}

function partIds() {
  return state.messages.map((entry) => entry.parts.map((part) => part.id));
}

beforeEach(() => {
  clearMessages();
});

describe('optimistic user message reconciliation', () => {
  it('preserves an unacknowledged optimistic row across a stale incremental refresh', () => {
    const previous = {
      info: userMessage('msg-previous'),
      parts: [textPart('part-previous', 'msg-previous', 'previous prompt')],
    };
    const optimistic = {
      info: userMessage('msg-pending'),
      parts: [textPart('msg-pending-part-0', 'msg-pending', 'new prompt')],
    };
    upsertMessage(previous);
    upsertMessage(optimistic);

    setMessagesIncremental([previous]);

    expect(state.messages.map((entry) => entry.info.id)).toEqual(['msg-previous', 'msg-pending']);
    expect(state.messages[1]!.parts).toEqual(optimistic.parts);
  });

  it('replaces a preserved optimistic row when its exact server message arrives', () => {
    const previous = {
      info: userMessage('msg-previous'),
      parts: [textPart('part-previous', 'msg-previous', 'previous prompt')],
    };
    const optimistic = {
      info: userMessage('msg-pending'),
      parts: [textPart('msg-pending-part-0', 'msg-pending', 'new prompt')],
    };
    upsertMessage(previous);
    upsertMessage(optimistic);
    setMessagesIncremental([previous]);

    const acknowledged = {
      info: userMessage('msg-pending'),
      parts: [textPart('part-server', 'msg-pending', 'new prompt')],
    };
    setMessagesIncremental([previous, acknowledged]);

    expect(state.messages.map((entry) => entry.info.id)).toEqual(['msg-previous', 'msg-pending']);
    expect(state.messages[1]!.parts).toEqual(acknowledged.parts);
  });

  it('does not reconcile a different server ID based only on matching text', () => {
    upsertMessage(optimisticEntry([textPart('p-1', OPTIMISTIC_ID, 'hello world')]));
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [textPart('p-2', 'msg-1', 'hello world')],
    });

    expect(state.messages.map((entry) => entry.info.id)).toEqual([OPTIMISTIC_ID, 'msg-1']);
  });

  it('does not reconcile a different server ID after stripping composer context', () => {
    upsertMessage(
      optimisticEntry([
        textPart('p-1', OPTIMISTIC_ID, '[Working directory: /repo]'),
        textPart('p-2', OPTIMISTIC_ID, '[Active file: src/app.ts]'),
        textPart('p-3', OPTIMISTIC_ID, '[Selection from src/app.ts]'),
        textPart('p-4', OPTIMISTIC_ID, 'explain this'),
      ])
    );
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [textPart('p-5', 'msg-1', 'explain this')],
    });

    expect(state.messages.map((entry) => entry.info.id)).toEqual([OPTIMISTIC_ID, 'msg-1']);
  });

  it('keeps the optimistic entry when the server text does not match', () => {
    upsertMessage(optimisticEntry([textPart('p-1', OPTIMISTIC_ID, 'first question')]));
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [textPart('p-2', 'msg-1', 'a different question')],
    });

    expect(state.messages.map((entry) => entry.info.id)).toEqual([OPTIMISTIC_ID, 'msg-1']);
  });

  it('does not reconcile an optimistic entry from another session', () => {
    upsertMessage(optimisticEntry([textPart('p-1', OPTIMISTIC_ID, 'hello')], 'session-2'));
    upsertMessage({
      info: userMessage('msg-1', 'session-1'),
      parts: [textPart('p-2', 'msg-1', 'hello')],
    });

    expect(state.messages.map((entry) => entry.info.id)).toEqual([OPTIMISTIC_ID, 'msg-1']);
  });

  it('does not guess the owner of an image-only server message', () => {
    upsertMessage(
      optimisticEntry([imagePart(`${OPTIMISTIC_ID}-optimistic-file-0`, OPTIMISTIC_ID)])
    );
    upsertMessage({ info: userMessage('msg-1'), parts: [] });

    expect(state.messages.map((entry) => entry.info.id)).toEqual([OPTIMISTIC_ID, 'msg-1']);
  });

  it('keeps all pending entries when another same-text ID arrives', () => {
    upsertMessage({
      info: userMessage('optimistic-user-1'),
      parts: [textPart('p-1', 'optimistic-user-1', 'same text')],
    });
    upsertMessage({
      info: userMessage('optimistic-user-2'),
      parts: [textPart('p-2', 'optimistic-user-2', 'same text')],
    });
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [textPart('p-3', 'msg-1', 'same text')],
    });

    expect(state.messages.map((entry) => entry.info.id)).toEqual([
      'optimistic-user-1',
      'optimistic-user-2',
      'msg-1',
    ]);
  });

  it('acknowledges exact optimistic message ids out of order', () => {
    upsertMessage({
      info: userMessage('msg-older'),
      parts: [textPart('msg-older-part-0', 'msg-older', 'older prompt')],
    });
    upsertMessage({
      info: userMessage('msg-newer'),
      parts: [textPart('msg-newer-part-0', 'msg-newer', 'newer prompt')],
    });

    upsertMessageInfo(userMessage('msg-older'));

    expect(state.messages.map((entry) => entry.info.id)).toEqual(['msg-older', 'msg-newer']);
    expect(state.messages[0]!.parts).toHaveLength(1);
    expect(state.messages[1]!.parts).toHaveLength(1);
  });

  it('keeps optimistic text between message metadata and its authoritative part', () => {
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [textPart('msg-1-part-0', 'msg-1', 'optimistic text')],
    });

    upsertMessageInfo(userMessage('msg-1'));
    expect(state.messages[0]!.parts).toEqual([
      textPart('msg-1-part-0', 'msg-1', 'optimistic text'),
    ]);

    upsertPart(textPart('part-server', 'msg-1', 'server text'));
    expect(state.messages[0]!.parts).toEqual([textPart('part-server', 'msg-1', 'server text')]);
  });

  it('keeps images attached to their exact IDs when acknowledgements arrive out of order', () => {
    upsertMessage({
      info: userMessage('msg-older'),
      parts: [
        imagePart('msg-older-part-0', 'msg-older', {
          filename: 'older.png',
          url: 'data:image/png;base64,OLDER',
        }),
      ],
    });
    upsertMessage({
      info: userMessage('msg-newer'),
      parts: [
        imagePart('msg-newer-part-0', 'msg-newer', {
          filename: 'newer.png',
          url: 'data:image/png;base64,NEWER',
        }),
      ],
    });

    upsertMessageInfo(userMessage('msg-newer'));
    upsertMessageInfo(userMessage('msg-older'));

    expect(
      state.messages.map((entry) => {
        const image = entry.parts[0];
        return [entry.info.id, image?.type === 'file' ? image.url : undefined];
      })
    ).toEqual([
      ['msg-older', 'data:image/png;base64,OLDER'],
      ['msg-newer', 'data:image/png;base64,NEWER'],
    ]);
  });

  it('drops optimistic text when a server part arrives before message metadata', () => {
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [textPart('msg-1-part-0', 'msg-1', 'optimistic text')],
    });

    upsertPart(textPart('part-server', 'msg-1', 'server text'));

    expect(state.messages[0]!.parts).toEqual([textPart('part-server', 'msg-1', 'server text')]);
  });
});

describe('optimistic image parts carried onto the server message', () => {
  it('rebases optimistic image parts when only the message info arrives', () => {
    upsertMessage(
      optimisticEntry([
        textPart('p-1', OPTIMISTIC_ID, 'look at this'),
        imagePart('local-image', OPTIMISTIC_ID),
      ])
    );
    upsertMessageInfo(userMessage(OPTIMISTIC_ID));

    expect(state.messages).toHaveLength(1);
    const entry = state.messages[0]!;
    expect(entry.info.id).toBe(OPTIMISTIC_ID);
    expect(entry.parts).toHaveLength(2);
    expect(entry.parts[0]).toEqual(textPart('p-1', OPTIMISTIC_ID, 'look at this'));
    const carried = entry.parts[1] as FilePart;
    expect(carried.id).toBe(`${OPTIMISTIC_ID}-optimistic-file-1`);
    expect(carried.messageID).toBe(OPTIMISTIC_ID);
    expect(carried.sessionID).toBe('session-1');
    expect(carried.url).toBe('data:image/png;base64,AAAA');
  });

  it('keeps non-image optimistic parts until a server part arrives', () => {
    upsertMessage(optimisticEntry([textPart('p-1', OPTIMISTIC_ID, 'text only')]));
    upsertMessageInfo(userMessage(OPTIMISTIC_ID));

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.parts).toEqual([textPart('p-1', OPTIMISTIC_ID, 'text only')]);
  });
});

describe('optimistic image part de-duplication', () => {
  function seedServerMessageWithOptimisticImage(overrides?: Partial<FilePart>) {
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [{ ...(imagePart('msg-1-optimistic-file-0', 'msg-1') as FilePart), ...overrides }],
    });
  }

  it('removes the optimistic twin when the server image part arrives', () => {
    seedServerMessageWithOptimisticImage();
    upsertPart(imagePart('server-image', 'msg-1'));

    expect(partIds()).toEqual([['server-image']]);
  });

  it('replaces the optimistic image when the server rewrites its url', () => {
    seedServerMessageWithOptimisticImage();
    upsertPart(imagePart('server-image', 'msg-1', { url: 'https://cdn/img.png' }));

    expect(partIds()).toEqual([['server-image']]);
  });

  it('replaces the optimistic image when the server rewrites its filename', () => {
    seedServerMessageWithOptimisticImage();
    upsertPart(imagePart('server-image', 'msg-1', { filename: 'renamed.png' }));

    expect(partIds()).toEqual([['server-image']]);
  });

  it('removes the optimistic twin when an existing server part is updated', () => {
    seedServerMessageWithOptimisticImage();
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [
        imagePart('msg-1-optimistic-file-0', 'msg-1'),
        imagePart('server-image', 'msg-1', { url: 'https://cdn/img.png' }),
      ],
    });

    upsertPart(imagePart('server-image', 'msg-1', { url: 'https://cdn/img.png' }));

    expect(partIds()).toEqual([['server-image']]);
  });

  it('does not remove an optimistic image for a non-image file part', () => {
    seedServerMessageWithOptimisticImage();
    upsertPart({
      id: 'server-file',
      sessionID: 'session-1',
      messageID: 'msg-1',
      type: 'file',
      mime: 'text/plain',
      filename: 'pasted-1.png',
      url: 'data:image/png;base64,AAAA',
    });

    expect(partIds()).toEqual([['msg-1-optimistic-file-0', 'server-file']]);
  });

  it('leaves a non-optimistic image part in place', () => {
    upsertMessage({
      info: userMessage('msg-1'),
      parts: [imagePart('regular-image', 'msg-1')],
    });
    upsertPart(imagePart('server-image', 'msg-1'));

    expect(partIds()).toEqual([['regular-image', 'server-image']]);
  });
});

describe('optimistic image parts across an incremental refresh', () => {
  const optimisticImageId = 'msg-1-optimistic-file-0';

  function currentEntry(parts: Part[]): MessageEntry {
    return { info: userMessage('msg-1'), parts };
  }

  it('preserves an optimistic image the server payload has not caught up to', () => {
    upsertMessage(currentEntry([imagePart(optimisticImageId, 'msg-1')]));
    setMessagesIncremental([currentEntry([textPart('p-1', 'msg-1', 'look')])]);

    expect(partIds()).toEqual([['p-1', optimisticImageId]]);
  });

  it('does not duplicate the image once the server payload includes a match', () => {
    upsertMessage(currentEntry([imagePart(optimisticImageId, 'msg-1')]));
    setMessagesIncremental([currentEntry([imagePart('server-image', 'msg-1')])], {
      preserveExtraParts: true,
    });

    expect(partIds()).toEqual([['server-image']]);
  });

  it('does not duplicate an image when the server rewrites its metadata', () => {
    upsertMessage(currentEntry([imagePart(optimisticImageId, 'msg-1')]));
    setMessagesIncremental(
      [
        currentEntry([
          imagePart('server-image', 'msg-1', {
            filename: 'normalized.png',
            url: 'https://cdn/img.png',
          }),
        ]),
      ],
      { preserveExtraParts: true }
    );

    expect(partIds()).toEqual([['server-image']]);
  });

  it('preserves only images not yet present in a partial server snapshot', () => {
    upsertMessage(
      currentEntry([
        imagePart(optimisticImageId, 'msg-1'),
        imagePart('msg-1-optimistic-file-1', 'msg-1', {
          filename: 'pasted-2.png',
          url: 'data:image/png;base64,BBBB',
        }),
      ])
    );
    setMessagesIncremental(
      [
        currentEntry([
          imagePart('server-image-1', 'msg-1', {
            filename: 'normalized.png',
            url: 'https://cdn/img.png',
          }),
        ]),
      ],
      { preserveExtraParts: true }
    );

    expect(partIds()).toEqual([['server-image-1', 'msg-1-optimistic-file-1']]);
  });

  it('does not add a phantom image beside multiple acknowledged images', () => {
    upsertMessage(
      currentEntry([
        imagePart(optimisticImageId, 'msg-1'),
        imagePart('msg-1-optimistic-file-1', 'msg-1', {
          filename: 'pasted-2.png',
          url: 'data:image/png;base64,BBBB',
        }),
      ])
    );
    setMessagesIncremental(
      [
        currentEntry([
          imagePart('server-image-1', 'msg-1'),
          imagePart('server-image-2', 'msg-1', {
            filename: 'pasted-2.png',
            url: 'data:image/png;base64,BBBB',
          }),
        ]),
      ],
      { preserveExtraParts: true }
    );

    expect(partIds()).toEqual([['server-image-1', 'server-image-2']]);
  });

  it('treats a different server image as the canonical optimistic image', () => {
    upsertMessage(currentEntry([imagePart(optimisticImageId, 'msg-1')]));
    setMessagesIncremental([
      currentEntry([imagePart('server-image', 'msg-1', { url: 'data:image/png;base64,BBBB' })]),
    ]);

    expect(partIds()).toEqual([['server-image']]);
  });
});
