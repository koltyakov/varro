import { describe, expect, it } from 'vitest';
import {
  createComposerHistory,
  getComposerHistoryAction,
  type ComposerSnapshot,
} from './composer-history';
import type { DroppedFile } from '../../shared/protocol';
import type { ClipboardImage } from './app-state-types';

function snap(
  text: string,
  caret = text.length,
  extra?: Partial<ComposerSnapshot>
): ComposerSnapshot {
  return { text, caret, files: [], images: [], ...extra };
}

function file(path: string): DroppedFile {
  return { path, relativePath: path, type: 'file' } as DroppedFile;
}

function image(id: string): ClipboardImage {
  return {
    id,
    url: `data:image/png;base64,${id}`,
    mime: 'image/png',
    filename: `${id}.png`,
    size: 10,
  } as ClipboardImage;
}

describe('getComposerHistoryAction', () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it('maps Cmd+Z and Ctrl+Z to undo', () => {
    expect(getComposerHistoryAction({ ...base, key: 'z', metaKey: true })).toBe('undo');
    expect(getComposerHistoryAction({ ...base, key: 'z', ctrlKey: true })).toBe('undo');
    expect(getComposerHistoryAction({ ...base, key: 'Z', metaKey: true })).toBe('undo');
  });

  it('maps Cmd+Shift+Z, Ctrl+Shift+Z, and Ctrl+Y to redo', () => {
    expect(getComposerHistoryAction({ ...base, key: 'z', metaKey: true, shiftKey: true })).toBe(
      'redo'
    );
    expect(getComposerHistoryAction({ ...base, key: 'z', ctrlKey: true, shiftKey: true })).toBe(
      'redo'
    );
    expect(getComposerHistoryAction({ ...base, key: 'y', ctrlKey: true })).toBe('redo');
  });

  it('ignores other combinations', () => {
    expect(getComposerHistoryAction({ ...base, key: 'z' })).toBeNull();
    expect(getComposerHistoryAction({ ...base, key: 'z', metaKey: true, altKey: true })).toBeNull();
    expect(getComposerHistoryAction({ ...base, key: 'y', metaKey: true })).toBeNull();
    expect(
      getComposerHistoryAction({ ...base, key: 'y', ctrlKey: true, shiftKey: true })
    ).toBeNull();
    expect(getComposerHistoryAction({ ...base, key: 'a', metaKey: true })).toBeNull();
  });
});

describe('createComposerHistory', () => {
  it('undoes and redoes text edits', () => {
    const history = createComposerHistory();
    history.record(snap('hello'));
    history.record(snap('hello world'));

    expect(history.undo()).toMatchObject({ text: 'hello', caret: 5 });
    expect(history.undo()).toMatchObject({ text: '', caret: 0 });
    expect(history.undo()).toBeNull();
    expect(history.redo()).toMatchObject({ text: 'hello', caret: 5 });
    expect(history.redo()).toMatchObject({ text: 'hello world', caret: 11 });
    expect(history.redo()).toBeNull();
  });

  it('coalesces rapid single-character typing into one entry', () => {
    let time = 0;
    const history = createComposerHistory({ now: () => time });
    for (const [index] of Array.from('hello').entries()) {
      time += 100;
      history.record(snap('hello'.slice(0, index + 1)));
    }

    expect(history.undo()).toMatchObject({ text: '' });
    expect(history.undo()).toBeNull();
  });

  it('breaks typing runs on whitespace', () => {
    let time = 0;
    const history = createComposerHistory({ now: () => time });
    const text = 'hi yo';
    for (const [index] of Array.from(text).entries()) {
      time += 100;
      history.record(snap(text.slice(0, index + 1)));
    }

    expect(history.undo()).toMatchObject({ text: 'hi ' });
    expect(history.undo()).toMatchObject({ text: '' });
  });

  it('breaks typing runs after a pause', () => {
    let time = 0;
    const history = createComposerHistory({ coalesceMs: 1000, now: () => time });
    time = 100;
    history.record(snap('a'));
    time = 200;
    history.record(snap('ab'));
    time = 5000;
    history.record(snap('abc'));

    expect(history.undo()).toMatchObject({ text: 'ab' });
    expect(history.undo()).toMatchObject({ text: '' });
  });

  it('keeps multi-character edits like paste as separate entries', () => {
    let time = 0;
    const history = createComposerHistory({ now: () => time });
    time = 100;
    history.record(snap('a'));
    time = 200;
    history.record(snap('apasted text'));

    expect(history.undo()).toMatchObject({ text: 'a' });
    expect(history.undo()).toMatchObject({ text: '' });
  });

  it('clears the redo tail on a new edit', () => {
    const history = createComposerHistory();
    history.record(snap('one'));
    history.record(snap('one two'));
    history.undo();
    history.record(snap('one three'));

    expect(history.redo()).toBeNull();
    expect(history.undo()).toMatchObject({ text: 'one' });
  });

  it('updates the caret without creating entries when only the caret moves', () => {
    const history = createComposerHistory();
    history.record(snap('hello'));
    history.record(snap('hello', 2));

    expect(history.undo()).toMatchObject({ text: '', caret: 0 });
    expect(history.redo()).toMatchObject({ text: 'hello', caret: 2 });
  });

  it('records attachment-only changes as their own entries', () => {
    const history = createComposerHistory();
    history.record(snap('hello'));
    history.record(snap('hello', 5, { files: [file('src/a.ts')] }));
    history.record(snap('hello', 5, { files: [file('src/a.ts')], images: [image('img-1')] }));

    const undone = history.undo();
    expect(undone?.files.map((item) => item.path)).toEqual(['src/a.ts']);
    expect(undone?.images).toEqual([]);

    const undoneAgain = history.undo();
    expect(undoneAgain?.files).toEqual([]);
    expect(undoneAgain?.text).toBe('hello');

    const redone = history.redo();
    expect(redone?.files.map((item) => item.path)).toEqual(['src/a.ts']);
  });

  it('does not coalesce typing across attachment changes', () => {
    let time = 0;
    const history = createComposerHistory({ now: () => time });
    time = 100;
    history.record(snap('a'));
    time = 200;
    history.record(snap('ab', 2, { files: [file('src/a.ts')] }));

    expect(history.undo()).toMatchObject({ text: 'a', files: [] });
  });

  it('does not coalesce new typing into an undone entry', () => {
    let time = 0;
    const history = createComposerHistory({ coalesceMs: 1000, now: () => time });
    time = 100;
    history.record(snap('a'));
    time = 5000;
    history.record(snap('ab'));
    history.undo();
    time = 5100;
    history.record(snap('ax'));

    expect(history.undo()).toMatchObject({ text: 'a' });
  });

  it('drops the oldest entries beyond the max depth', () => {
    let time = 0;
    const history = createComposerHistory({ maxDepth: 3, coalesceMs: 0, now: () => time });
    for (const index of [1, 2, 3, 4]) {
      time += 100;
      history.record(snap('x'.repeat(index * 2)));
    }

    expect(history.undo()).toMatchObject({ text: 'xxxxxx' });
    expect(history.undo()).toMatchObject({ text: 'xxxx' });
    expect(history.undo()).toBeNull();
  });

  it('reset clears both stacks', () => {
    const history = createComposerHistory();
    history.record(snap('hello'));
    history.undo();
    history.reset(snap('draft'));

    expect(history.undo()).toBeNull();
    expect(history.redo()).toBeNull();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});
