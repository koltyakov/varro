export type CommentSelection = {
  startLine: number;
  startChar: number;
  endLine: number;
  endChar: number;
};

export type CommentNote = {
  path: string;
  selection?: CommentSelection;
  comment: string;
  preview?: string;
  origin?: 'review' | 'file';
};

export function formatCommentNote(input: {
  path: string;
  selection?: { startLine: number; endLine: number };
  comment: string;
}) {
  const start = input.selection
    ? Math.min(input.selection.startLine, input.selection.endLine)
    : undefined;
  const end = input.selection
    ? Math.max(input.selection.startLine, input.selection.endLine)
    : undefined;
  const range =
    start === undefined || end === undefined
      ? 'this file'
      : start === end
        ? `line ${start}`
        : `lines ${start} through ${end}`;
  return `The user made the following comment regarding ${range} of ${input.path}: ${input.comment}`;
}

const COMMENT_NOTE_PATTERN =
  /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/;

export function parseCommentNote(text: string): CommentNote | undefined {
  const match = text.match(COMMENT_NOTE_PATTERN);
  if (!match) return undefined;
  const start = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : undefined;
  const end = match[2] ? Number(match[2]) : match[4] ? Number(match[4]) : undefined;
  return {
    path: match[5]!,
    selection:
      start !== undefined && end !== undefined
        ? { startLine: start, startChar: 0, endLine: end, endChar: 0 }
        : undefined,
    comment: match[6]!,
  };
}

function isSelection(value: unknown): value is CommentSelection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const startLine = Number(record.startLine);
  const startChar = Number(record.startChar);
  const endLine = Number(record.endLine);
  const endChar = Number(record.endChar);
  if (![startLine, startChar, endLine, endChar].every(Number.isFinite)) return false;
  return true;
}

export function createCommentMetadata(input: CommentNote) {
  return {
    opencodeComment: {
      path: input.path,
      selection: input.selection,
      comment: input.comment,
      preview: input.preview,
      origin: input.origin,
    },
  };
}

export function readCommentMetadata(value: unknown): CommentNote | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const meta = (value as { opencodeComment?: unknown }).opencodeComment;
  if (!meta || typeof meta !== 'object') return undefined;
  const record = meta as Record<string, unknown>;
  const path = record.path;
  const comment = record.comment;
  if (typeof path !== 'string' || typeof comment !== 'string') return undefined;
  const preview = record.preview;
  const origin = record.origin;
  const selection = isSelection(record.selection) ? record.selection : undefined;
  return {
    path,
    selection: selection
      ? {
          startLine: Number(selection.startLine),
          startChar: Number(selection.startChar),
          endLine: Number(selection.endLine),
          endChar: Number(selection.endChar),
        }
      : undefined,
    comment,
    preview: typeof preview === 'string' ? preview : undefined,
    origin: origin === 'review' || origin === 'file' ? origin : undefined,
  };
}
