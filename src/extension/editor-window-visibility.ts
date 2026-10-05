import { asRecord, isBoolean, isNumber } from '../shared/type-utils';

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectangle<T>(value: T): Rectangle {
  const record = asRecord(value);
  if (!record) throw new Error('Missing window visibility bounds');
  const { x, y, width, height } = record;
  if (
    !isNumber(x) ||
    !isNumber(y) ||
    !isNumber(width) ||
    !isNumber(height) ||
    ![x, y, width, height].every(Number.isFinite) ||
    width < 0 ||
    height < 0
  ) {
    throw new Error('Invalid window visibility bounds');
  }
  return { x, y, width, height };
}

function intersection(a: Rectangle, b: Rectangle): Rectangle | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const width = Math.min(a.x + a.width, b.x + b.width) - x;
  const height = Math.min(a.y + a.height, b.y + b.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

function uncovered(area: Rectangle, cover: Rectangle): Rectangle[] {
  const overlap = intersection(area, cover);
  if (!overlap) return [area];
  return [
    { x: area.x, y: area.y, width: area.width, height: overlap.y - area.y },
    {
      x: area.x,
      y: overlap.y + overlap.height,
      width: area.width,
      height: area.y + area.height - overlap.y - overlap.height,
    },
    { x: area.x, y: overlap.y, width: overlap.x - area.x, height: overlap.height },
    {
      x: overlap.x + overlap.width,
      y: overlap.y,
      width: area.x + area.width - overlap.x - overlap.width,
      height: overlap.height,
    },
  ].filter((part) => part.width > 0 && part.height > 0);
}

/** Read front-to-back window bounds from the macOS helper without screen capture or window titles. */
export function readEditorVisibility(json: string): boolean {
  const value: unknown = JSON.parse(json);
  const state = asRecord(value);
  if (!state || !Array.isArray(state.screens) || !Array.isArray(state.windows)) {
    throw new Error('Invalid editor window visibility response');
  }
  const screens = state.screens.map(rectangle);
  const windows = state.windows.map((entry) => {
    const window = asRecord(entry);
    if (!window || !isBoolean(window.editor) || !isBoolean(window.opaque)) {
      throw new Error('Invalid editor window visibility flags');
    }
    return { bounds: rectangle(window), editor: window.editor, opaque: window.opaque };
  });
  const covers: Rectangle[] = [];
  for (const window of windows) {
    if (window.editor) {
      let visible = screens.flatMap((screen) => {
        const part = intersection(window.bounds, screen);
        return part ? [part] : [];
      });
      for (const cover of covers) {
        visible = visible.flatMap((part) => uncovered(part, cover));
        if (!visible.length) break;
      }
      if (visible.length) return true;
    }
    if (window.opaque) covers.push(window.bounds);
  }
  return false;
}
