export const MAX_HIGHLIGHT_CHARACTERS = 20_000;
export const MAX_HIGHLIGHT_LINE_CHARACTERS = 1_000;
export const MAX_HIGHLIGHT_OUTPUT_CHARACTERS = 512_000;

export type HighlightRequest = { id: number; text: string; language: string };
export type HighlightResponse = { id: number; html: string | null };

export function canHighlight(text: string): boolean {
  if (text.length > MAX_HIGHLIGHT_CHARACTERS) return false;
  let lineLength = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n' || text[index] === '\r') lineLength = 0;
    else if (++lineLength > MAX_HIGHLIGHT_LINE_CHARACTERS) return false;
  }
  return true;
}
