export type PromptTextAttachment = { name: string; text: string };
export type PromptTextWithAttachments = { text: string; attachments: PromptTextAttachment[] };

const OPEN_PREFIX = '<attached-text name="';
const OPEN =
  /<attached-text name="((?:pasted-text|annotation)-[a-f0-9]{8}\.txt)" length="(\d+)">\n/y;
const CLOSE = '\n</attached-text>';
const SEPARATOR = '\n\n';

export function isPromptTextAttachmentName(name: string): boolean {
  return /^(?:pasted-text|annotation)-[a-f0-9]{8}\.txt$/.test(name);
}

/**
 * OpenCode v2 compaction keeps recent prompts verbatim but reduces attachments to their names,
 * so pasted text and annotations travel as length-prefixed blocks after the prompt text.
 */
export function appendPromptTextAttachments(
  text: string,
  attachments: readonly PromptTextAttachment[]
): string {
  if (attachments.length === 0) return text;
  const blocks = attachments.map((attachment) => {
    if (!isPromptTextAttachmentName(attachment.name))
      throw new Error(`Invalid prompt text attachment name: ${attachment.name}`);
    return `${OPEN_PREFIX}${attachment.name}" length="${attachment.text.length}">\n${attachment.text}${CLOSE}`;
  });
  return [...(text ? [text] : []), ...blocks].join(SEPARATOR);
}

/** Splits trailing attachment blocks from prompt text; malformed blocks stay as text. */
export function splitPromptTextAttachments(text: string): PromptTextWithAttachments {
  for (
    let start = text.indexOf(OPEN_PREFIX);
    start >= 0;
    start = text.indexOf(OPEN_PREFIX, start + 1)
  ) {
    if (start > 0 && !text.startsWith(SEPARATOR, start - SEPARATOR.length)) continue;
    const attachments = readBlocks(text, start);
    if (attachments)
      return { text: text.slice(0, Math.max(0, start - SEPARATOR.length)), attachments };
  }
  return { text, attachments: [] };
}

function readBlocks(text: string, start: number): PromptTextAttachment[] | null {
  const attachments: PromptTextAttachment[] = [];
  let index = start;
  for (;;) {
    OPEN.lastIndex = index;
    const match = OPEN.exec(text);
    if (!match) return null;
    const contentStart = OPEN.lastIndex;
    const contentEnd = contentStart + Number(match[2]);
    if (!Number.isSafeInteger(contentEnd) || !text.startsWith(CLOSE, contentEnd)) return null;
    attachments.push({ name: match[1]!, text: text.slice(contentStart, contentEnd) });
    index = contentEnd + CLOSE.length;
    if (index === text.length) return attachments;
    if (!text.startsWith(SEPARATOR, index)) return null;
    index += SEPARATOR.length;
  }
}
