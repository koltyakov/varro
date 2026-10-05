import { describe, expect, it } from 'vitest';
import { readEditorVisibility } from './editor-window-visibility';

const screen = { x: 0, y: 0, width: 1200, height: 900 };
const editor = { x: 100, y: 100, width: 800, height: 600, editor: true, opaque: true };
const cover = { ...editor, editor: false };

describe('editor window visibility', () => {
  it.each([
    { name: 'visible but unfocused', windows: [editor], visible: true },
    { name: 'minimized or hidden, absent from on-screen list', windows: [cover], visible: false },
    { name: 'fully covered', windows: [cover, editor], visible: false },
    { name: 'side by side', windows: [{ ...cover, x: 950 }, editor], visible: true },
    { name: 'partly covered', windows: [{ ...cover, width: 799 }, editor], visible: true },
    {
      name: 'covered jointly by two windows',
      windows: [{ ...cover, width: 400 }, { ...cover, x: 500, width: 400 }, editor],
      visible: false,
    },
    { name: 'transparent overlay', windows: [{ ...cover, opaque: false }, editor], visible: true },
    { name: 'window behind the editor', windows: [editor, cover], visible: true },
    { name: 'off-screen editor', windows: [{ ...editor, x: 1400 }], visible: false },
    {
      name: 'another editor window remains visible',
      windows: [cover, editor, { ...editor, x: 1000, width: 100 }],
      visible: true,
    },
  ])('$name', ({ windows, visible }) => {
    expect(readEditorVisibility(JSON.stringify({ screens: [screen], windows }))).toBe(visible);
  });

  it('clips bounds to each display, including monitors with negative coordinates', () => {
    const screens = [screen, { ...screen, x: -1200 }];
    expect(
      readEditorVisibility(JSON.stringify({ screens, windows: [{ ...editor, x: -1000 }] }))
    ).toBe(true);
    expect(
      readEditorVisibility(
        JSON.stringify({
          screens: [screen],
          windows: [
            { ...cover, x: 0, width: 500 },
            { ...editor, x: -100, width: 600 },
          ],
        })
      )
    ).toBe(false);
  });

  it.each([
    {},
    { screens: [], windows: [{}] },
    { screens: [screen], windows: [{ ...editor, width: -1 }] },
    { screens: [screen], windows: [{ ...editor, opaque: 'yes' }] },
  ])('rejects invalid helper data: %j', (value) => {
    expect(() => readEditorVisibility(JSON.stringify(value))).toThrow();
  });
});
