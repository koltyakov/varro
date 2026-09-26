import { readExtensionContextBlock } from '../../shared/extension-context';
import { isDatabaseContext } from '../../shared/database-context';
import { readLegacyExtensionContext } from '../host/extensions';

/** Hide generated context in composer history, preserving fenced examples and malformed blocks. */
export function stripContextForHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  const visible: string[] = [];
  let fence: string | null = null;
  let removed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!fence) {
      let end = (
        readExtensionContextBlock(lines, index) ?? readLegacyExtensionContext(lines, index)
      )?.end;
      if (end === undefined && trimmed === '[Database context]') {
        const opening = lines[index + 1]?.trim().match(/^(`{3,})json$/);
        if (opening) {
          const closing = lines.findIndex(
            (candidate, position) => position > index + 1 && candidate.trim() === opening[1]
          );
          if (closing > index) {
            try {
              if (isDatabaseContext(JSON.parse(lines.slice(index + 2, closing).join('\n'))))
                end = closing;
            } catch {
              // Malformed context remains user text.
            }
          }
        }
      }
      if (end !== undefined) {
        removed = true;
        index = end;
        while (index + 1 < lines.length && lines[index + 1]!.trim() === '') index += 1;
        continue;
      }
    }
    const marker = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null;
    }
    visible.push(line);
  }
  return removed ? visible.join('\n') : text;
}
